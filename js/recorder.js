/* ═══════════════════════════════════════════════════════════════
   recorder.js — Per-segment microphone recording & take analysis
   - Records directly INTO the selected dubbing segment (never a
     generic global track)
   - Live level meter + elapsed timer callbacks
   - Deterministic take analysis: trimmed speech duration, silence,
     clipping, completeness heuristics
   - Optional "Fit to target" time-stretch (WSOLA-lite) for small
     differences only
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Recorder = (() => {
  /* ── SAFETY TAIL (post-recording safety time) ──────────
     When STOP is pressed the microphone keeps capturing for a
     short safety period before the MediaRecorder is actually
     stopped. This prevents the classic end-clipping problem:
     the actor presses STOP while the last word is still decaying
     (or the encoder is still flushing its final frames) and the
     tail of the take gets destroyed. */
  const SAFETY_TAIL_MS = 800;   // extra capture time after STOP
  const TAIL_PAD_SEC   = 0.20;  // decay padding kept after the last detected speech frame
  const HEAD_PAD_SEC   = 0.05;  // small attack padding before the first speech frame

  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let startTs = 0;
  let levelRAF = null;
  let analyser = null, levelSrc = null;

  let playSource = null; // take preview source

  async function ensureMic() {
    if (mediaStream && mediaStream.active) return mediaStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support microphone capture.');
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      if (e.name === 'NotAllowedError') throw new Error('Microphone permission was denied. Allow microphone access in the browser and try again.');
      if (e.name === 'NotFoundError') throw new Error('No microphone was found on this device.');
      throw new Error('Could not access the microphone: ' + e.message);
    }
    return mediaStream;
  }

  /**
   * Start recording for one specific segment.
   * callbacks: onTick(elapsedSec), onLevel(0..1)
   */
  async function start(segment, { onTick, onLevel } = {}) {
    if (recording) throw new Error('Already recording.');
    const stream = await ensureMic();
    const ac = AudioEngine.getCtx();

    // level meter
    analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    levelSrc = ac.createMediaStreamSource(stream);
    levelSrc.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    chunks = [];
    let mime = '';
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    }
    try {
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      throw new Error('Recording could not be started: ' + e.message);
    }
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.start(100);
    recording = true;
    startTs = performance.now();

    const tick = () => {
      if (!recording) return;
      const elapsed = (performance.now() - startTs) / 1000;
      if (onTick) onTick(elapsed);
      if (onLevel && analyser) {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        onLevel(peak);
      }
      levelRAF = requestAnimationFrame(tick);
    };
    tick();
    return { segmentId: segment.id, startedAt: Date.now() };
  }

  /**
   * Stop and return a fully analyzed take object bound to the segment.
   * The recorder does NOT stop immediately: it keeps capturing for a
   * safety-tail period (default 800 ms) so the end of the take is
   * never clipped. `onSafetyTail(ms)` lets the UI show feedback while
   * the tail is being captured.
   */
  function stop(segment, { safetyTailMs = SAFETY_TAIL_MS, onSafetyTail } = {}) {
    return new Promise((resolve, reject) => {
      if (!recording || !mediaRecorder) return reject(new Error('Not recording.'));
      recording = false;
      if (levelRAF) cancelAnimationFrame(levelRAF);
      if (levelSrc) { try { levelSrc.disconnect(); } catch (e) {} levelSrc = null; analyser = null; }

      mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          if (!blob.size) throw new Error('The recording is empty — no audio was captured.');
          const arrayBuf = await blob.arrayBuffer();
          const ac = AudioEngine.getCtx();
          let audioBuf;
          try { audioBuf = await ac.decodeAudioData(arrayBuf); }
          catch (e) { throw new Error('The recorded audio could not be decoded.'); }

          // Fixed recording DSP chain (gain −9dB → VAD suppression →
          // EQ 70Hz HP / 150Hz +4dB peak → noise gate). Applied to every
          // take BEFORE analysis; the untouched capture is kept in rawBuffer.
          const rawBuf = audioBuf;
          let dspApplied = false;
          if (window.DspChain) {
            try {
              audioBuf = await DspChain.process(rawBuf);
              dspApplied = true;
            } catch (e) {
              console.warn('DSP chain failed — using unprocessed capture:', e);
            }
          }

          const analysis = analyzeTakeBuffer(audioBuf, segment.targetDuration);
          const take = {
            id: 'take-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
            segmentId: segment.id,
            blob,
            buffer: audioBuf,          // DSP-processed capture (chain above)
            rawBuffer: rawBuf,         // untouched microphone capture
            dspApplied,
            dspChain: dspApplied ? DspChain.describe() : [],
            rawDuration: +audioBuf.duration.toFixed(3),
            duration: analysis.speechDuration,        // trimmed speech duration (what matters)
            trimStart: analysis.trimStart,
            trimEnd: analysis.trimEnd,
            analysis,
            status: analysis.verdict,                  // 'perfect' | 'near' | 'too_long' | 'too_short' | 'silent'
            fitted: false,
            createdAt: Date.now()
          };
          resolve(take);
        } catch (err) { reject(err); }
      };
      const doStop = () => {
        try { mediaRecorder.stop(); } catch (e) { reject(new Error('Failed to stop the recorder: ' + e.message)); }
      };

      // ── safety tail: keep the mic rolling briefly after STOP so the
      //    tail of the last word (and the encoder flush) is never cut.
      if (safetyTailMs > 0 && mediaRecorder.state === 'recording') {
        if (onSafetyTail) { try { onSafetyTail(safetyTailMs); } catch (e) {} }
        try { mediaRecorder.requestData(); } catch (e) {}
        setTimeout(doStop, safetyTailMs);
      } else {
        doStop();
      }
    });
  }

  function isRecording() { return recording; }

  /* ── deterministic take analysis ───────────────────── */

  function analyzeTakeBuffer(buffer, targetDuration) {
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const win = Math.round(sr * 0.02);
    const energies = [];
    let clippedSamples = 0;
    for (let i = 0; i < data.length; i += win) {
      let sum = 0; const end = Math.min(i + win, data.length);
      for (let j = i; j < end; j++) {
        sum += data[j] * data[j];
        if (Math.abs(data[j]) > 0.985) clippedSamples++;
      }
      energies.push(Math.sqrt(sum / (end - i)));
    }
    const sorted = [...energies].sort((a, b) => a - b);
    const peak = sorted[sorted.length - 1] || 0;
    const threshold = Math.max(0.006, peak * 0.09);

    let first = -1, last = -1;
    for (let i = 0; i < energies.length; i++) {
      if (energies[i] >= threshold) { if (first < 0) first = i; last = i; }
    }

    if (first < 0 || peak < 0.008) {
      return { speechDuration: 0, trimStart: 0, trimEnd: 0, verdict: 'silent',
               diff: -(targetDuration || 0), clipping: false,
               leadingSilence: +buffer.duration.toFixed(2), trailingSilence: 0,
               flags: ['No speech detected — the take is silent or too quiet.'] };
    }

    // Actual speech boundaries (used for timing verdicts — unpadded).
    const speechStart = first * win / sr;
    const speechEnd = Math.min(((last + 1) * win) / sr, buffer.duration);

    // Head/tail SAFETY padding on the trim points: keep a little audio
    // around the detected speech so consonant attacks and the natural
    // decay of the last word are never destroyed by the auto-trim
    // (end-clipping protection). Timing is still judged on the real
    // speech duration, so verdicts are unaffected by the padding.
    const trimStart = +Math.max(0, speechStart - HEAD_PAD_SEC).toFixed(3);
    const trimEnd = +Math.min(speechEnd + TAIL_PAD_SEC, buffer.duration).toFixed(3);
    const speechDuration = +(speechEnd - speechStart).toFixed(3);
    const diff = +(speechDuration - targetDuration).toFixed(3);
    const clipping = clippedSamples > sr * 0.01;
    const leadingSilence = +speechStart.toFixed(3);
    const trailingSilence = +(buffer.duration - speechEnd).toFixed(3);

    // internal gap check → possible clipped/incomplete words
    let longestGap = 0, gap = 0;
    for (let i = first; i <= last; i++) {
      if (energies[i] < threshold) { gap++; longestGap = Math.max(longestGap, gap); } else gap = 0;
    }
    const longestGapSec = longestGap * win / sr;

    const tol = Math.max(0.12, targetDuration * 0.06);
    let verdict;
    if (Math.abs(diff) <= tol) verdict = 'perfect';
    else if (Math.abs(diff) <= tol * 2.2) verdict = 'near';
    else verdict = diff > 0 ? 'too_long' : 'too_short';

    const flags = [];
    if (clipping) flags.push('Clipping detected — lower the mic gain or move back.');
    if (leadingSilence > 0.8) flags.push(`Long silence before speech (${leadingSilence.toFixed(2)}s) — auto-trimmed.`);
    if (longestGapSec > 1.0) flags.push('Long pause inside the take — check for missed words.');
    if (verdict === 'too_short' && speechDuration < targetDuration * 0.5) flags.push('The take may be incomplete (much shorter than the line).');

    return { speechDuration, trimStart, trimEnd, verdict, diff, clipping,
             leadingSilence, trailingSilence, longestGapSec: +longestGapSec.toFixed(2), flags };
  }

  /* ── take preview playback ─────────────────────────── */

  function playTake(take, { onEnded } = {}) {
    stopTake();
    const ac = AudioEngine.getCtx();
    // fitted > AI-enhanced > raw-trimmed (Enhancer.effectiveAudio resolves it)
    const eff = (window.Enhancer && Enhancer.effectiveAudio)
      ? Enhancer.effectiveAudio(take)
      : { buffer: take.fitted && take.fittedBuffer ? take.fittedBuffer : take.buffer,
          start: take.fitted ? 0 : take.trimStart,
          duration: take.fitted && take.fittedBuffer ? take.fittedBuffer.duration : (take.trimEnd - take.trimStart) };
    playSource = ac.createBufferSource();
    playSource.buffer = eff.buffer;
    playSource.connect(ac.destination);
    playSource.onended = () => { playSource = null; if (onEnded) onEnded(); };
    playSource.start(0, eff.start, eff.duration);
  }

  // A/B comparison: play the ORIGINAL capture (before the DSP chain and
  // before any AI enhancement), trimmed to the detected speech region.
  function playTakeRaw(take, { onEnded } = {}) {
    stopTake();
    const ac = AudioEngine.getCtx();
    playSource = ac.createBufferSource();
    playSource.buffer = take.rawBuffer || take.buffer;
    playSource.connect(ac.destination);
    playSource.onended = () => { playSource = null; if (onEnded) onEnded(); };
    playSource.start(0, take.trimStart, Math.max(0.01, take.trimEnd - take.trimStart));
  }

  function stopTake() {
    if (playSource) { try { playSource.onended = null; playSource.stop(); } catch (e) {} playSource = null; }
  }

  /* ── FIT AUDIO TO TARGET (small time-stretch only) ─────
     Simple OLA time-stretch. Refuses ratios beyond ±12% to avoid
     audible distortion — recommend retake / AI rewrite instead.   */

  const MAX_STRETCH = 0.12;

  function canFit(take, targetDuration) {
    if (!take || take.duration <= 0) return { ok: false };
    const ratio = targetDuration / take.duration;
    return { ok: Math.abs(1 - ratio) <= MAX_STRETCH, ratio };
  }

  function fitToTarget(take, targetDuration) {
    const { ok, ratio } = canFit(take, targetDuration);
    if (!ok) throw new Error('The difference is too large for a clean time-stretch. Record again or use an AI rewrite.');
    const ac = AudioEngine.getCtx();
    // stretch the AI-enhanced audio when available, otherwise the raw take
    const useEnhanced = take.enhanced && take.enhancedBuffer;
    const src = useEnhanced ? take.enhancedBuffer : take.buffer;
    const sr = src.sampleRate;
    const inStart = useEnhanced ? 0 : Math.floor(take.trimStart * sr);
    const inLen = useEnhanced ? src.length : Math.floor((take.trimEnd - take.trimStart) * sr);
    const outLen = Math.floor(inLen * ratio);
    const out = ac.createBuffer(1, Math.max(1, outLen), sr);
    const inData = src.getChannelData(0);
    const outData = out.getChannelData(0);

    const frame = Math.floor(sr * 0.03);   // 30ms frames
    const hopOut = Math.floor(frame / 2);
    const hopIn = Math.floor(hopOut / ratio);
    const winFn = new Float32Array(frame);
    for (let i = 0; i < frame; i++) winFn[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frame - 1));

    let inPos = 0, outPos = 0;
    while (outPos + frame < outLen && inStart + inPos + frame < inStart + inLen) {
      for (let i = 0; i < frame; i++) {
        const s = inData[inStart + inPos + i] || 0;
        outData[outPos + i] += s * winFn[i];
      }
      inPos += hopIn; outPos += hopOut;
    }
    // normalize overlap gain (approx 1.0 for 50% hann overlap)
    take.fittedBuffer = out;
    take.fitted = true;
    take.fittedDuration = +out.duration.toFixed(3);
    return take;
  }

  /* ── AI TAKE EVALUATION & BEST-TAKE SELECTION ──────────
     Every take is already auto-trimmed (leading/trailing silence
     removed via analyzeTakeBuffer → trimStart/trimEnd). This scores
     each take on clarity and quality and picks the single best:
       • timing fit vs target duration      (45%)
       • clarity / SNR of the speech        (30%)
       • cleanliness: no clipping, no long
         internal gaps, sane level          (25%)                  */

  function scoreTake(take, targetDuration) {
    const a = take.analysis;
    if (!a || a.verdict === 'silent' || a.speechDuration <= 0) return { total: 0, why: 'silent take' };

    // timing fit: 1.0 at perfect, →0 as diff approaches 60% of target
    const diffRatio = Math.abs(a.diff) / Math.max(0.3, targetDuration * 0.6);
    const timing = Math.max(0, 1 - diffRatio);

    // clarity: SNR estimate from the trimmed buffer
    const snr = estimateSnr(take.buffer, take.trimStart, take.trimEnd);
    const clarity = Math.max(0, Math.min(1, (snr - 8) / 30)); // 8dB→0, 38dB→1

    // cleanliness
    let clean = 1;
    const why = [];
    if (a.clipping) { clean -= 0.5; why.push('clipping'); }
    if (a.longestGapSec > 1.0) { clean -= 0.3; why.push('long internal pause'); }
    if (a.leadingSilence > 1.5) { clean -= 0.1; why.push('slow start'); }
    clean = Math.max(0, clean);

    const total = timing * 0.45 + clarity * 0.30 + clean * 0.25;
    return {
      total: +total.toFixed(3),
      timing: +timing.toFixed(2), clarity: +clarity.toFixed(2), clean: +clean.toFixed(2),
      snrDb: +snr.toFixed(1),
      why: why.join(', ') || 'clean'
    };
  }

  function estimateSnr(buffer, from, to) {
    const sr = buffer.sampleRate;
    const data = buffer.getChannelData(0);
    const i0 = Math.floor(from * sr), i1 = Math.min(data.length, Math.ceil(to * sr));
    const win = Math.round(sr * 0.02);
    const frames = [];
    for (let i = i0; i < i1; i += win) {
      let s = 0; const e = Math.min(i + win, i1);
      for (let j = i; j < e; j++) s += data[j] * data[j];
      frames.push(Math.sqrt(s / Math.max(1, e - i)));
    }
    if (frames.length < 4) return 0;
    frames.sort((a, b) => a - b);
    const noise = frames[Math.floor(frames.length * 0.1)] || 1e-6;
    const speech = frames[Math.floor(frames.length * 0.9)] || 1e-5;
    return 20 * Math.log10(speech / Math.max(noise, 1e-6));
  }

  /**
   * Evaluate a list of takes and return the best one (or null).
   * Attaches take.aiScore to every take for UI display.
   */
  function selectBestTake(takes, targetDuration) {
    let best = null;
    for (const t of takes) {
      t.aiScore = scoreTake(t, targetDuration);
      if (!best || t.aiScore.total > best.aiScore.total) best = t;
    }
    return best && best.aiScore.total > 0 ? best : null;
  }

  /* ── OPEN RECORDING TRACK EDITING ─────────────────────
     A project-length AudioBuffer is used as a non-destructive timeline.
     Recording from a cursor overwrites only the captured range; deleting a
     selection writes silence without changing project/video duration. */

  function createOpenTrack(duration, sampleRate) {
    const ac = AudioEngine.getCtx();
    const sr = sampleRate || ac.sampleRate || 48000;
    return ac.createBuffer(1, Math.max(1, Math.ceil(duration * sr)), sr);
  }

  function overwriteTrack(track, source, atSeconds, sourceStart = 0, duration = null) {
    if (!track || !source) throw new Error('Audio track data is missing.');
    const at = Math.max(0, Math.min(track.duration, atSeconds || 0));
    const srcStart = Math.max(0, Math.min(source.duration, sourceStart || 0));
    const copyDuration = Math.max(0, Math.min(
      duration == null ? source.duration - srcStart : duration,
      track.duration - at,
      source.duration - srcStart
    ));
    const out = cloneBuffer(track);
    const dst = out.getChannelData(0);
    const src = source.getChannelData(0);
    const dstStart = Math.floor(at * out.sampleRate);
    const frames = Math.floor(copyDuration * out.sampleRate);
    const ratio = source.sampleRate / out.sampleRate;
    const srcBase = srcStart * source.sampleRate;
    for (let i = 0; i < frames && dstStart + i < dst.length; i++) {
      const pos = srcBase + i * ratio;
      const p0 = Math.floor(pos), p1 = Math.min(src.length - 1, p0 + 1);
      const frac = pos - p0;
      dst[dstStart + i] = (src[p0] || 0) * (1 - frac) + (src[p1] || 0) * frac;
    }
    return out;
  }

  function silenceTrackRange(track, fromSeconds, toSeconds) {
    if (!track) throw new Error('No open recording exists yet.');
    const from = Math.max(0, Math.min(track.duration, Math.min(fromSeconds, toSeconds)));
    const to = Math.max(from, Math.min(track.duration, Math.max(fromSeconds, toSeconds)));
    if (to - from < 0.01) throw new Error('Select an audio range before deleting.');
    const out = cloneBuffer(track);
    const data = out.getChannelData(0);
    data.fill(0, Math.floor(from * out.sampleRate), Math.ceil(to * out.sampleRate));
    return out;
  }

  function cloneBuffer(buffer) {
    const ac = AudioEngine.getCtx();
    const out = ac.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c), c);
    return out;
  }

  function releaseMic() {
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  }

  return { ensureMic, start, stop, isRecording, playTake, playTakeRaw, stopTake, canFit, fitToTarget, releaseMic, analyzeTakeBuffer, scoreTake, selectBestTake, createOpenTrack, overwriteTrack, silenceTrackRange, cloneBuffer, SAFETY_TAIL_MS };
})();
