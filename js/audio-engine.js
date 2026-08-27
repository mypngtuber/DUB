/* ═══════════════════════════════════════════════════════════════
   audio-engine.js — Original audio processing & reference playback
   - Extracts audio from the uploaded video
   - Separates it into EXACTLY TWO stems: VOICE_STEM + MUSIC_STEM
     (modular: the separation function can be swapped for a server/ML
      engine later without touching the UI — see `separateStems`)
   - Analyzes VOICE_STEM speech timing per segment (deterministic VAD)
   - Plays: original-voice reference per segment, background music
     synced to the video clock, with volume + auto-ducking
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const AudioEngine = (() => {
  let ctx = null;

  let originalBuffer = null;  // full original audio
  let voiceStem = null;       // VOICE_STEM (AudioBuffer)
  let musicStem = null;       // MUSIC_STEM (AudioBuffer)

  // playback nodes
  let musicSource = null, musicGain = null;
  let voiceSource = null, voiceGain = null;
  let musicVolume = 0.7;
  let duckingEnabled = true;
  let onVoiceEnded = null;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ── 1. EXTRACTION ─────────────────────────────────── */

  async function extractAudioFromVideo(file) {
    const ac = getCtx();
    const arrayBuf = await file.arrayBuffer();
    try {
      originalBuffer = await ac.decodeAudioData(arrayBuf.slice(0));
    } catch (e) {
      throw new Error('Could not decode the audio track of this video. The container/codec may be unsupported by the browser (try MP4/H.264+AAC or WebM).');
    }
    if (!originalBuffer || originalBuffer.duration === 0) {
      throw new Error('The video appears to have no audio track.');
    }
    return originalBuffer;
  }

  /* ── 2. TWO-STEM SEPARATION (VOICE_STEM + MUSIC_STEM) ─
     Client-side DSP approximation:
     • VOICE_STEM  = center channel (mid − correlated side) band-passed
                     to the speech range (≈120 Hz – 6.5 kHz)
     • MUSIC_STEM  = original − voice estimate (sides + residual)
     This is intentionally modular: replace this one function with a
     call to a real ML separation service to upgrade quality.        */

  async function separateStems(buffer, onProgress) {
    const ac = getCtx();
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const chL = buffer.getChannelData(0);
    const chR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : chL;

    const mid = new Float32Array(len);
    const side = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      mid[i] = (chL[i] + chR[i]) * 0.5;
      side[i] = (chL[i] - chR[i]) * 0.5;
      if ((i & 0xFFFFF) === 0 && onProgress) onProgress(0.1 * i / len);
    }

    // Band-pass the mid channel to the speech band via OfflineAudioContext
    const voiceData = await filterOffline(mid, sr, [
      { type: 'highpass', frequency: 120, Q: 0.7 },
      { type: 'lowpass', frequency: 6500, Q: 0.7 },
    ]);
    if (onProgress) onProgress(0.55);

    // Voice stem (mono → stereo buffer)
    voiceStem = ac.createBuffer(2, len, sr);
    voiceStem.getChannelData(0).set(voiceData.subarray(0, len));
    voiceStem.getChannelData(1).set(voiceData.subarray(0, len));

    // Music stem = original − voice estimate (per channel), plus side energy
    musicStem = ac.createBuffer(2, len, sr);
    const mL = musicStem.getChannelData(0), mR = musicStem.getChannelData(1);
    for (let i = 0; i < len; i++) {
      const v = voiceData[i] || 0;
      mL[i] = clamp(chL[i] - v * 0.9 + side[i] * 0.1, -1, 1);
      mR[i] = clamp(chR[i] - v * 0.9 - side[i] * 0.1, -1, 1);
      if ((i & 0xFFFFF) === 0 && onProgress) onProgress(0.55 + 0.4 * i / len);
    }
    computeAutoMix();
    if (onProgress) onProgress(1);
    return { voiceStem, musicStem };
  }

  /* ── AI AUTO-MIX (auto-leveling) ─────────────────────
     No manual volume control: the engine measures the separated
     MUSIC_STEM loudness and the original VOICE_STEM speech level,
     then sets the music bed gain so it sits ~12 dB under dialogue
     (professional dialogue-forward balance). While the dub voice
     is actually playing/recording, ducking drops it further.     */
  let autoMusicGain = 0.7;

  function computeAutoMix() {
    if (!musicStem || !voiceStem) return autoMusicGain;
    const musicRms = percentileRms(musicStem.getChannelData(0), 0.7);   // typical music level
    const voiceRms = percentileRms(voiceStem.getChannelData(0), 0.9);   // speech level
    const targetVoiceRms = Math.max(voiceRms, 0.03);                    // assume dialogue-level voice
    const targetMusicRms = targetVoiceRms * Math.pow(10, -12 / 20);     // music −12 dB vs voice
    autoMusicGain = clamp(targetMusicRms / Math.max(musicRms, 1e-5), 0.12, 0.9);
    musicVolume = autoMusicGain;
    duckingEnabled = true; // voice-aware ducking is always on under auto-mix
    return autoMusicGain;
  }

  function percentileRms(data, pct) {
    const win = 4410; // ~100ms at 44.1k
    const frames = [];
    for (let i = 0; i < data.length; i += win * 4) { // sample every 4th frame for speed
      let s = 0; const e = Math.min(i + win, data.length);
      for (let j = i; j < e; j++) s += data[j] * data[j];
      frames.push(Math.sqrt(s / Math.max(1, e - i)));
    }
    frames.sort((a, b) => a - b);
    return frames[Math.floor(frames.length * pct)] || 1e-5;
  }

  function getAutoMusicGain() { return autoMusicGain; }

  async function filterOffline(mono, sampleRate, filters) {
    const off = new OfflineAudioContext(1, mono.length, sampleRate);
    const buf = off.createBuffer(1, mono.length, sampleRate);
    buf.getChannelData(0).set(mono);
    const src = off.createBufferSource();
    src.buffer = buf;
    let node = src;
    for (const f of filters) {
      const biq = off.createBiquadFilter();
      biq.type = f.type; biq.frequency.value = f.frequency; biq.Q.value = f.Q;
      node.connect(biq); node = biq;
    }
    node.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ── 3. VOICE_STEM SPEECH ANALYSIS (deterministic VAD) ─
     For each segment (SRT window ± padding) find actual speech
     start/end, silence padding, and whether SRT timing looks right. */

  function analyzeSegmentSpeech(segment, pad = 0.35) {
    if (!voiceStem) return null;
    const sr = voiceStem.sampleRate;
    const data = voiceStem.getChannelData(0);
    const from = Math.max(0, Math.floor((segment.startTime - pad) * sr));
    const to = Math.min(data.length, Math.ceil((segment.endTime + pad) * sr));
    if (to <= from) return null;

    const win = Math.round(sr * 0.02); // 20ms windows
    const energies = [];
    for (let i = from; i < to; i += win) {
      let sum = 0;
      const end = Math.min(i + win, to);
      for (let j = i; j < end; j++) sum += data[j] * data[j];
      energies.push(Math.sqrt(sum / (end - i)));
    }
    const sorted = [...energies].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.15)] || 0.0005;
    const peak = sorted[sorted.length - 1] || 0;
    const threshold = Math.max(noiseFloor * 3.2, peak * 0.12, 0.004);

    let firstIdx = -1, lastIdx = -1;
    for (let i = 0; i < energies.length; i++) {
      if (energies[i] >= threshold) { if (firstIdx < 0) firstIdx = i; lastIdx = i; }
    }
    if (firstIdx < 0) {
      return { hasSpeech: false, speechStart: null, speechEnd: null, speechDuration: 0,
               silenceBefore: null, silenceAfter: null, srtTimingOk: false,
               note: 'No clear speech detected in this window.' };
    }
    const speechStart = (from + firstIdx * win) / sr;
    const speechEnd = Math.min((from + (lastIdx + 1) * win) / sr, to / sr);
    const speechDuration = +(speechEnd - speechStart).toFixed(3);
    const silenceBefore = +(speechStart - segment.startTime).toFixed(3);
    const silenceAfter = +(segment.endTime - speechEnd).toFixed(3);
    // SRT timing considered OK if actual speech starts/ends within 300ms of SRT bounds
    const srtTimingOk = Math.abs(silenceBefore) <= 0.3 && Math.abs(silenceAfter) <= 0.3;

    return { hasSpeech: true, speechStart: +speechStart.toFixed(3), speechEnd: +speechEnd.toFixed(3),
             speechDuration, silenceBefore, silenceAfter, srtTimingOk };
  }

  /* ── 4. REFERENCE PLAYBACK ─────────────────────────── */

  // Listen to the original voice for one segment (reference, no timeline)
  function playOriginalVoice(segment, { onEnded } = {}) {
    stopOriginalVoice();
    if (!voiceStem) return false;
    const ac = getCtx();
    voiceGain = ac.createGain();
    voiceGain.gain.value = 1.0;
    voiceSource = ac.createBufferSource();
    voiceSource.buffer = voiceStem;
    voiceSource.connect(voiceGain).connect(ac.destination);
    const dur = Math.max(0.05, segment.endTime - segment.startTime);
    onVoiceEnded = onEnded || null;
    voiceSource.onended = () => { if (onVoiceEnded) onVoiceEnded(); onVoiceEnded = null; };
    // duck music under the reference voice
    duckMusic(0.15);
    voiceSource.start(0, Math.max(0, segment.startTime), dur + 0.05);
    setTimeout(() => restoreMusic(), (dur + 0.1) * 1000);
    return true;
  }

  function stopOriginalVoice() {
    if (voiceSource) { try { voiceSource.onended = null; voiceSource.stop(); } catch (e) {} voiceSource = null; }
    restoreMusic();
  }

  // Background music synced to a given media time
  function playMusicFrom(timeSec, durationSec = null) {
    stopMusic();
    if (!musicStem) return false;
    const ac = getCtx();
    musicGain = ac.createGain();
    musicGain.gain.value = effectiveMusicGain();
    musicSource = ac.createBufferSource();
    musicSource.buffer = musicStem;
    musicSource.connect(musicGain).connect(ac.destination);
    if (durationSec != null) musicSource.start(0, Math.max(0, timeSec), durationSec);
    else musicSource.start(0, Math.max(0, timeSec));
    return true;
  }

  function stopMusic() {
    if (musicSource) { try { musicSource.stop(); } catch (e) {} musicSource = null; musicGain = null; }
  }

  let ducked = false;
  function effectiveMusicGain() { return ducked && duckingEnabled ? musicVolume * 0.25 : musicVolume; }
  function duckMusic() { ducked = true; applyMusicGain(); }
  function restoreMusic() { ducked = false; applyMusicGain(); }
  function applyMusicGain() {
    if (musicGain) musicGain.gain.setTargetAtTime(effectiveMusicGain(), getCtx().currentTime, 0.08);
  }
  function setMusicVolume(v) { musicVolume = clamp(v, 0, 1); applyMusicGain(); }
  function setDucking(on) { duckingEnabled = !!on; applyMusicGain(); }
  // recording ducking: while the actor records, keep music low if auto-duck on
  function setRecordingDuck(on) { ducked = on; applyMusicGain(); }

  /* ── helpers for other modules ─────────────────────── */
  function getStems() { return { voiceStem, musicStem }; }
  function getOriginalBuffer() { return originalBuffer; }
  function hasStems() { return !!(voiceStem && musicStem); }

  return {
    getCtx, extractAudioFromVideo, separateStems, analyzeSegmentSpeech,
    playOriginalVoice, stopOriginalVoice,
    playMusicFrom, stopMusic, setMusicVolume, setDucking, setRecordingDuck,
    computeAutoMix, getAutoMusicGain,
    getStems, getOriginalBuffer, hasStems
  };
})();
