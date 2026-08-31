/* ═══════════════════════════════════════════════════════════════
   exporter.js — Export mixes (deterministic, no AI)
   Mixes are rendered offline from:
     • accepted takes placed at their EXACT segment start times
     • MUSIC_STEM (separated background music)
   The original VOICE_STEM is never included unless explicitly
   requested (it is not offered in the export UI by default).
   MP3: lamejs encode. Video: browser capture → WebM (or MP4 where
   the browser supports H.264 MediaRecorder); for guaranteed H.264
   MP4 mastering, import the exported assets into Premiere.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Exporter = (() => {

  /* ── offline mix rendering ─────────────────────────── */

  /**
   * mix: 'full' (dub+music) | 'dub' | 'music'
   * Returns AudioBuffer (stereo, 44.1kHz).
   */
  async function renderMix(segments, mix, duration, musicVolume, openRecordingBuffer = null) {
    const sr = 44100;
    const len = Math.max(1, Math.ceil(duration * sr));
    const off = new OfflineAudioContext(2, len, sr);

    if (mix === 'full' || mix === 'music') {
      const { musicStem } = AudioEngine.getStems();
      if (!musicStem) throw new Error('Music stem is not available.');
      const src = off.createBufferSource();
      src.buffer = musicStem;
      const g = off.createGain();
      const bed = mix === 'music' ? 1.0 : (musicVolume ?? AudioEngine.getAutoMusicGain());
      g.gain.value = bed;
      if (mix === 'full') {
        // AI auto-mix: sidechain-style ducking automation — the music dips
        // ~6 dB under every accepted voice segment (80ms dip / 250ms recover)
        const duck = bed * 0.5;
        for (const s of segments) {
          if (!openRecordingBuffer && !s.acceptedTakeId) continue;
          const t0 = Math.max(0, s.startTime - 0.08);
          const t1 = Math.min(duration, s.endTime + 0.05);
          g.gain.setValueAtTime(bed, Math.max(0, t0 - 0.001));
          g.gain.linearRampToValueAtTime(duck, t0 + 0.08);
          g.gain.setValueAtTime(duck, t1);
          g.gain.linearRampToValueAtTime(bed, Math.min(duration, t1 + 0.25));
        }
      }
      src.connect(g).connect(off.destination);
      src.start(0);
    }

    if (mix === 'full' || mix === 'dub') {
      let placed = 0;
      if (openRecordingBuffer) {
        const src = off.createBufferSource();
        src.buffer = openRecordingBuffer;
        src.connect(off.destination);
        src.start(0, 0, Math.min(duration, openRecordingBuffer.duration));
        placed = 1;
      } else {
        for (const seg of segments) {
          if (!seg.acceptedTakeId) continue;
          const take = seg.takes.find(t => t.id === seg.acceptedTakeId);
          if (!take) continue;
          // fitted > AI-enhanced > raw-trimmed
          const eff = (window.Enhancer && Enhancer.effectiveAudio)
            ? Enhancer.effectiveAudio(take)
            : { buffer: take.buffer, start: take.trimStart, duration: take.trimEnd - take.trimStart };
          const src = off.createBufferSource();
          src.buffer = eff.buffer;
          src.connect(off.destination);
          // exact segment placement — the segment's start time is authoritative
          src.start(seg.startTime, eff.start, Math.min(eff.duration, seg.targetDuration + 0.4));
          placed++;
        }
      }
      if ((mix === 'dub') && placed === 0) throw new Error('No accepted takes yet — record and accept at least one line first.');
    }

    return off.startRendering();
  }

  /* ── MP3 encoding (lamejs) ─────────────────────────── */

  function encodeMP3(buffer, onProgress) {
    if (typeof lamejs === 'undefined') throw new Error('MP3 encoder failed to load (lamejs CDN unreachable).');
    const sr = buffer.sampleRate;
    const l = f2i(buffer.getChannelData(0));
    const r = f2i(buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0));
    const enc = new lamejs.Mp3Encoder(2, sr, 192);
    const block = 1152;
    const out = [];
    for (let i = 0; i < l.length; i += block) {
      const bl = enc.encodeBuffer(l.subarray(i, i + block), r.subarray(i, i + block));
      if (bl.length) out.push(bl);
      if (onProgress && (i % (block * 200) === 0)) onProgress(i / l.length);
    }
    const end = enc.flush();
    if (end.length) out.push(end);
    if (onProgress) onProgress(1);
    return new Blob(out, { type: 'audio/mpeg' });
  }

  function f2i(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
    }
    return out;
  }

  /* ── video export (capture) ────────────────────────── */

  /**
   * Re-plays the video muted while capturing canvas + mixed audio.
   * Prefers H.264 MP4 when the browser's MediaRecorder supports it,
   * otherwise falls back to WebM (still importable in Premiere via
   * conversion, and all audio stems export separately as MP3).
   */
  async function exportVideo(videoEl, mixBuffer, onProgress) {
    const ac = AudioEngine.getCtx();
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const g = canvas.getContext('2d');

    const canvasStream = canvas.captureStream(30);
    const dest = ac.createMediaStreamDestination();
    const audioSrc = ac.createBufferSource();
    audioSrc.buffer = mixBuffer;
    audioSrc.connect(dest);

    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    let mime = '';
    for (const m of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
                     'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm']) {
      if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    }
    if (!mime) throw new Error('This browser cannot record video (MediaRecorder unsupported).');
    const isMp4 = mime.startsWith('video/mp4');
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

    const wasMuted = videoEl.muted, wasTime = videoEl.currentTime;
    videoEl.muted = true;
    videoEl.currentTime = 0;
    await new Promise(r => { videoEl.onseeked = r; setTimeout(r, 800); });

    return new Promise((resolve, reject) => {
      const duration = Math.min(videoEl.duration, mixBuffer.duration + 1);
      let raf;
      const draw = () => {
        g.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        if (onProgress && duration) onProgress(Math.min(1, videoEl.currentTime / duration));
        if (videoEl.currentTime >= duration - 0.05 || videoEl.ended) { finish(); return; }
        raf = requestAnimationFrame(draw);
      };
      const finish = () => {
        cancelAnimationFrame(raf);
        try { audioSrc.stop(); } catch (e) {}
        videoEl.pause();
        rec.onstop = () => {
          videoEl.muted = wasMuted; videoEl.currentTime = wasTime;
          resolve({ blob: new Blob(chunks, { type: mime }), ext: isMp4 ? 'mp4' : 'webm', isMp4 });
        };
        try { rec.stop(); } catch (e) { reject(new Error('Video capture failed to finalize.')); }
      };
      rec.onerror = e => reject(new Error('Video recording error: ' + (e.error?.message || 'unknown')));
      rec.start(500);
      audioSrc.start(0);
      videoEl.play().then(() => draw()).catch(err => reject(new Error('Could not play the video for capture: ' + err.message)));
    });
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  return { renderMix, encodeMP3, exportVideo, download };
})();
