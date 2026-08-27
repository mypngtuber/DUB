/* ═══════════════════════════════════════════════════════════════
   enhancer.js — AI-Powered Professional Audio Enhancement
   Fully automatic: the system ANALYZES the recorded voice, DECIDES
   what processing it needs, and APPLIES it. The user never touches
   technical audio parameters.

   Pipeline (applied only where the analysis says it is needed):
     1. Analysis        — noise floor, SNR, rumble, sibilance,
                          dynamics, clipping, spectral balance
     2. Decision        — deterministic audio-engineering rules
                          (optionally refined by Gemini when a key
                          is configured and the option is enabled)
     3. Processing      — high-pass rumble cut → adaptive noise
                          reduction (downward expander) → corrective
                          EQ → compression → de-esser → loudness
                          normalization → soft-knee limiter
   Output: take.enhancedBuffer + human-readable report of what the
   AI did and why. The original take buffer is always preserved.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Enhancer = (() => {

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dB = v => 20 * Math.log10(Math.max(v, 1e-8));
  const fromDB = d => Math.pow(10, d / 20);

  /* ══════════ 1. ANALYSIS ══════════ */

  async function analyze(buffer, from = 0, to = null) {
    const sr = buffer.sampleRate;
    const data = buffer.getChannelData(0);
    const start = Math.floor(from * sr);
    const end = to != null ? Math.min(data.length, Math.ceil(to * sr)) : data.length;
    const len = end - start;
    if (len < sr * 0.1) throw new Error('The take is too short to analyze.');

    const win = Math.round(sr * 0.02);
    const frames = [];
    let peak = 0, sumSq = 0, clipped = 0;
    for (let i = start; i < end; i += win) {
      let s = 0; const e = Math.min(i + win, end);
      for (let j = i; j < e; j++) {
        const v = data[j];
        s += v * v;
        const av = Math.abs(v);
        if (av > peak) peak = av;
        if (av > 0.985) clipped++;
        sumSq += v * v;
      }
      frames.push(Math.sqrt(s / (e - i)));
    }
    const rms = Math.sqrt(sumSq / len);
    const sorted = [...frames].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 1e-6;
    const speechRms = sorted[Math.floor(sorted.length * 0.85)] || rms;
    const snrDb = dB(speechRms) - dB(noiseFloor);
    const crestDb = dB(peak) - dB(rms);

    // spectral band energies via offline band-pass renders (trimmed slice)
    const slice = data.subarray(start, end);
    const [lowE, sibE, fullE] = await Promise.all([
      bandRms(slice, sr, [{ type: 'lowpass', frequency: 100, Q: 0.7 }]),
      bandRms(slice, sr, [{ type: 'bandpass', frequency: 6800, Q: 1.1 }]),
      Promise.resolve(rms)
    ]);
    const rumbleRatio = lowE / Math.max(fullE, 1e-8);
    const sibilanceRatio = sibE / Math.max(fullE, 1e-8);

    return {
      sampleRate: sr, duration: +(len / sr).toFixed(3),
      peak: +peak.toFixed(4), peakDb: +dB(peak).toFixed(1),
      rms: +rms.toFixed(5), rmsDb: +dB(rms).toFixed(1),
      noiseFloor: +noiseFloor.toFixed(6), noiseFloorDb: +dB(noiseFloor).toFixed(1),
      snrDb: +snrDb.toFixed(1), crestDb: +crestDb.toFixed(1),
      clippedRatio: +(clipped / len).toFixed(5),
      rumbleRatio: +rumbleRatio.toFixed(3),
      sibilanceRatio: +sibilanceRatio.toFixed(3)
    };
  }

  async function bandRms(mono, sr, filters) {
    const off = new OfflineAudioContext(1, mono.length, sr);
    const buf = off.createBuffer(1, mono.length, sr);
    buf.getChannelData(0).set(mono);
    const src = off.createBufferSource(); src.buffer = buf;
    let node = src;
    for (const f of filters) {
      const b = off.createBiquadFilter();
      b.type = f.type; b.frequency.value = f.frequency; b.Q.value = f.Q;
      node.connect(b); node = b;
    }
    node.connect(off.destination); src.start(0);
    const out = (await off.startRendering()).getChannelData(0);
    let s = 0; for (let i = 0; i < out.length; i++) s += out[i] * out[i];
    return Math.sqrt(s / out.length);
  }

  /* ══════════ 2. DECISION (the "AI brain") ══════════ */

  function decideSettings(m) {
    const s = { report: [] };

    // High-pass: always remove sub-speech rumble; stronger if rumble heavy
    s.highpass = m.rumbleRatio > 0.18 ? 110 : 85;
    if (m.rumbleRatio > 0.18) s.report.push(`Low-frequency rumble detected (${Math.round(m.rumbleRatio * 100)}% of energy) → high-pass at ${s.highpass} Hz.`);
    else s.report.push(`Applied gentle ${s.highpass} Hz high-pass to keep the low end clean.`);

    // Noise reduction: driven by SNR
    if (m.snrDb < 18) { s.noiseReductionDb = 18; s.report.push(`Noisy recording (SNR ${m.snrDb} dB) → strong adaptive noise reduction (−18 dB).`); }
    else if (m.snrDb < 30) { s.noiseReductionDb = 12; s.report.push(`Background noise detected (SNR ${m.snrDb} dB) → adaptive noise reduction (−12 dB).`); }
    else if (m.snrDb < 45) { s.noiseReductionDb = 7; s.report.push(`Light noise floor → gentle noise reduction (−7 dB).`); }
    else { s.noiseReductionDb = 0; s.report.push('Recording is already very clean → no noise reduction needed.'); }

    // Corrective EQ for voice clarity
    s.eq = [
      { type: 'peaking', frequency: 250, gain: m.rumbleRatio > 0.12 ? -2.5 : -1.2, Q: 1.0 },  // mud
      { type: 'peaking', frequency: 3000, gain: 2.2, Q: 0.9 },                                 // presence
      { type: 'highshelf', frequency: 9500, gain: 1.5, Q: 0.7 }                                // air
    ];
    s.report.push('Voice-clarity EQ: reduced mud around 250 Hz, added presence at 3 kHz and gentle air above 9.5 kHz.');

    // Compression: driven by crest factor (dynamics)
    if (m.crestDb > 20) { s.compressor = { threshold: -26, ratio: 3.5, attack: 0.004, release: 0.16, knee: 8 }; s.report.push(`Very dynamic performance (crest ${m.crestDb} dB) → firmer compression (3.5:1).`); }
    else if (m.crestDb > 14) { s.compressor = { threshold: -22, ratio: 2.5, attack: 0.005, release: 0.15, knee: 10 }; s.report.push('Moderate dynamics → smooth 2.5:1 compression for consistent dialogue level.'); }
    else { s.compressor = { threshold: -18, ratio: 1.8, attack: 0.006, release: 0.15, knee: 12 }; s.report.push('Even performance → light 1.8:1 leveling compression.'); }

    // De-esser only when sibilance is actually harsh
    if (m.sibilanceRatio > 0.20) { s.deEsser = { freq: 6800, maxReductionDb: 9, threshold: 0.16 }; s.report.push(`Harsh S/SH sounds detected → de-esser at ~6.8 kHz (up to −9 dB).`); }
    else if (m.sibilanceRatio > 0.13) { s.deEsser = { freq: 6800, maxReductionDb: 5, threshold: 0.14 }; s.report.push('Mild sibilance → gentle de-esser (up to −5 dB).'); }
    else { s.deEsser = null; s.report.push('No harsh sibilance → de-esser not needed.'); }

    // Loudness target + safety limiter
    s.targetRmsDb = -17;   // dialogue-friendly loudness
    s.ceiling = 0.97;
    s.report.push(`Loudness normalized to ≈${s.targetRmsDb} dBFS RMS with a soft limiter at −0.3 dB to prevent clipping.`);

    if (m.clippedRatio > 0.001) s.report.push(`⚠ Source clipping detected (${(m.clippedRatio * 100).toFixed(2)}% of samples) — limited what enhancement can repair; consider lowering mic gain.`);

    return s;
  }

  /* Optional: let Gemini refine the deterministic decision.
     Falls back silently to the rule-based settings on any failure. */
  async function refineWithGemini(metrics, settings) {
    if (!window.Gemini || !Gemini.isConfigured()) return settings;
    if (localStorage.getItem('dubstudio.aiEnhanceGemini') === 'off') return settings;
    try {
      const prompt =
`You are a professional dialogue mixing engineer. A voice-over take was measured:
${JSON.stringify(metrics)}

Proposed automatic processing:
${JSON.stringify({ highpass: settings.highpass, noiseReductionDb: settings.noiseReductionDb, eq: settings.eq, compressor: settings.compressor, deEsser: settings.deEsser, targetRmsDb: settings.targetRmsDb })}

Adjust these values ONLY if clearly beneficial for a clean, natural, professional dubbing voice. Stay conservative; keep the voice natural. Allowed ranges: highpass 60-140, noiseReductionDb 0-20, eq gains -6..6, compressor ratio 1.2-6 threshold -35..-10, deEsser maxReductionDb 0-12 (or null), targetRmsDb -20..-14.
Respond ONLY with JSON in the same shape (no extra keys, no commentary).`;
      const out = await Gemini.call(prompt, { json: true, temperature: 0.2 });
      const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
      const merged = { ...settings };
      if (typeof j.highpass === 'number') merged.highpass = clamp(j.highpass, 60, 140);
      if (typeof j.noiseReductionDb === 'number') merged.noiseReductionDb = clamp(j.noiseReductionDb, 0, 20);
      if (Array.isArray(j.eq) && j.eq.length) merged.eq = j.eq.slice(0, 4).map(e => ({
        type: ['peaking', 'highshelf', 'lowshelf'].includes(e.type) ? e.type : 'peaking',
        frequency: clamp(+e.frequency || 1000, 80, 16000),
        gain: clamp(+e.gain || 0, -6, 6),
        Q: clamp(+e.Q || 1, 0.3, 4)
      }));
      if (j.compressor) merged.compressor = {
        threshold: clamp(+j.compressor.threshold || -22, -35, -10),
        ratio: clamp(+j.compressor.ratio || 2.5, 1.2, 6),
        attack: clamp(+j.compressor.attack || 0.005, 0.001, 0.03),
        release: clamp(+j.compressor.release || 0.15, 0.05, 0.4),
        knee: clamp(+j.compressor.knee || 10, 0, 20)
      };
      if (j.deEsser === null) merged.deEsser = null;
      else if (j.deEsser && typeof j.deEsser.maxReductionDb === 'number') merged.deEsser = {
        freq: clamp(+j.deEsser.freq || 6800, 4000, 10000),
        maxReductionDb: clamp(j.deEsser.maxReductionDb, 0, 12),
        threshold: clamp(+j.deEsser.threshold || 0.15, 0.08, 0.3)
      };
      if (typeof j.targetRmsDb === 'number') merged.targetRmsDb = clamp(j.targetRmsDb, -20, -14);
      merged.report = [...settings.report, `Gemini (${Gemini.getModel()}) reviewed the measurements and fine-tuned the processing chain.`];
      merged.geminiRefined = true;
      return merged;
    } catch (e) {
      console.warn('Gemini enhancement refinement skipped:', e.message);
      return settings; // deterministic settings remain fully valid
    }
  }

  /* ══════════ 3. PROCESSING ══════════ */

  async function process(buffer, settings, from = 0, to = null) {
    const sr = buffer.sampleRate;
    const src = buffer.getChannelData(0);
    const start = Math.floor(from * sr);
    const end = to != null ? Math.min(src.length, Math.ceil(to * sr)) : src.length;
    let data = new Float32Array(src.subarray(start, end)); // work on a copy

    // 3a. adaptive noise reduction — smoothed downward expander
    if (settings.noiseReductionDb > 0) data = downwardExpand(data, sr, settings.noiseReductionDb);

    // 3b. filter/EQ/compression chain via OfflineAudioContext
    data = await renderChain(data, sr, settings);

    // 3c. de-esser — dynamic band cut on sibilant frames
    if (settings.deEsser) data = await deEss(data, sr, settings.deEsser);

    // 3d. loudness normalization + soft-knee limiter (no clipping)
    data = normalizeAndLimit(data, settings.targetRmsDb, settings.ceiling);

    const ac = AudioEngine.getCtx();
    const out = ac.createBuffer(1, data.length, sr);
    out.getChannelData(0).set(data);
    return out;
  }

  function downwardExpand(data, sr, reductionDb) {
    const win = Math.round(sr * 0.02);
    const nFrames = Math.ceil(data.length / win);
    const frameRms = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let s = 0; const i0 = f * win, i1 = Math.min(i0 + win, data.length);
      for (let i = i0; i < i1; i++) s += data[i] * data[i];
      frameRms[f] = Math.sqrt(s / Math.max(1, i1 - i0));
    }
    const sorted = [...frameRms].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 1e-6;
    const threshold = noiseFloor * 2.5;
    const floorGain = fromDB(-reductionDb);

    // per-frame target gain, then per-sample smoothing (attack/release)
    const frameGain = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      if (frameRms[f] >= threshold) frameGain[f] = 1;
      else frameGain[f] = Math.max(floorGain, Math.pow(frameRms[f] / threshold, 1.5));
    }
    const out = new Float32Array(data.length);
    let g = frameGain[0] || 1;
    const attack = Math.exp(-1 / (sr * 0.005)), release = Math.exp(-1 / (sr * 0.06));
    for (let i = 0; i < data.length; i++) {
      const target = frameGain[Math.min(nFrames - 1, (i / win) | 0)];
      g = target < g ? target + (g - target) * release : target + (g - target) * attack;
      out[i] = data[i] * g;
    }
    return out;
  }

  async function renderChain(data, sr, settings) {
    const off = new OfflineAudioContext(1, data.length + Math.round(sr * 0.05), sr);
    const buf = off.createBuffer(1, data.length, sr);
    buf.getChannelData(0).set(data);
    const src = off.createBufferSource(); src.buffer = buf;
    let node = src;

    const hp = off.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = settings.highpass; hp.Q.value = 0.71;
    node.connect(hp); node = hp;

    for (const e of settings.eq) {
      const f = off.createBiquadFilter();
      f.type = e.type; f.frequency.value = e.frequency; f.gain.value = e.gain; f.Q.value = e.Q;
      node.connect(f); node = f;
    }

    const c = settings.compressor;
    const comp = off.createDynamicsCompressor();
    comp.threshold.value = c.threshold; comp.ratio.value = c.ratio;
    comp.attack.value = c.attack; comp.release.value = c.release; comp.knee.value = c.knee;
    node.connect(comp); node = comp;

    node.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return new Float32Array(rendered.getChannelData(0).subarray(0, data.length));
  }

  async function deEss(data, sr, cfg) {
    // isolate the sibilance band
    const off = new OfflineAudioContext(1, data.length, sr);
    const buf = off.createBuffer(1, data.length, sr);
    buf.getChannelData(0).set(data);
    const src = off.createBufferSource(); src.buffer = buf;
    const bp = off.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = cfg.freq; bp.Q.value = 1.0;
    src.connect(bp).connect(off.destination); src.start(0);
    const band = (await off.startRendering()).getChannelData(0);

    const win = Math.round(sr * 0.01); // 10ms detection windows
    const out = new Float32Array(data.length);
    const maxCut = 1 - fromDB(-cfg.maxReductionDb); // fraction of band signal to subtract
    let smooth = 0;
    const rel = Math.exp(-1 / (sr * 0.04)), atk = Math.exp(-1 / (sr * 0.002));
    for (let f = 0; f < data.length; f += win) {
      const e = Math.min(f + win, data.length);
      let sb = 0, st = 0;
      for (let i = f; i < e; i++) { sb += band[i] * band[i]; st += data[i] * data[i]; }
      const ratio = Math.sqrt(sb) / Math.max(Math.sqrt(st), 1e-8);
      const over = ratio > cfg.threshold ? Math.min(1, (ratio - cfg.threshold) / cfg.threshold) : 0;
      const targetCut = over * maxCut;
      for (let i = f; i < e; i++) {
        smooth = targetCut > smooth ? targetCut + (smooth - targetCut) * atk : targetCut + (smooth - targetCut) * rel;
        out[i] = data[i] - band[i] * smooth;
      }
    }
    return out;
  }

  function normalizeAndLimit(data, targetRmsDb, ceiling) {
    let sum = 0, peak = 0;
    for (let i = 0; i < data.length; i++) { sum += data[i] * data[i]; peak = Math.max(peak, Math.abs(data[i])); }
    const rms = Math.sqrt(sum / data.length) || 1e-8;
    let gain = fromDB(targetRmsDb) / rms;
    gain = Math.min(gain, fromDB(20)); // sanity cap

    const knee = ceiling * 0.85;
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      let v = data[i] * gain;
      const a = Math.abs(v);
      if (a > knee) {
        // soft-knee limiter: smoothly approach the ceiling, never exceed it
        const soft = knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee));
        v = Math.sign(v) * soft;
      }
      out[i] = v;
    }
    return out;
  }

  /* ══════════ PUBLIC: one-click enhancement of a take ══════════ */

  /**
   * AI Auto Enhance — analyze, decide, process. Stores result on the
   * take (enhancedBuffer, enhanceReport, enhanceMetrics) and returns it.
   * onStatus(label) reports progress for the UI.
   */
  async function enhanceTake(take, { onStatus } = {}) {
    if (!take || !take.buffer) throw new Error('No recorded audio to enhance.');
    if (take.analysis && take.analysis.verdict === 'silent') throw new Error('The take is silent — nothing to enhance.');
    const st = s => { if (onStatus) onStatus(s); };
    try {
      st('Analyzing voice…');
      const metrics = await analyze(take.buffer, take.trimStart, take.trimEnd);
      st('Deciding processing chain…');
      let settings = decideSettings(metrics);
      settings = await refineWithGemini(metrics, settings);
      st('Cleaning & enhancing…');
      const enhanced = await process(take.buffer, settings, take.trimStart, take.trimEnd);
      take.enhancedBuffer = enhanced;
      take.enhanced = true;
      take.enhanceReport = settings.report;
      take.enhanceMetrics = metrics;
      take.enhanceGemini = !!settings.geminiRefined;
      // a previous fit was computed from the raw audio → recompute from enhanced
      if (take.fitted) { take.fitted = false; take.fittedBuffer = null; }
      st('Done');
      return take;
    } catch (e) {
      throw new Error('Audio enhancement failed: ' + e.message);
    }
  }

  /**
   * Resolve which audio to actually play/place for a take:
   * fitted (time-stretched) > enhanced > raw-trimmed.
   * Returns {buffer, start, duration}.
   */
  function effectiveAudio(take) {
    if (take.fitted && take.fittedBuffer) return { buffer: take.fittedBuffer, start: 0, duration: take.fittedBuffer.duration };
    if (take.enhanced && take.enhancedBuffer) return { buffer: take.enhancedBuffer, start: 0, duration: take.enhancedBuffer.duration };
    return { buffer: take.buffer, start: take.trimStart, duration: Math.max(0.01, take.trimEnd - take.trimStart) };
  }

  return { analyze, decideSettings, process, enhanceTake, effectiveAudio };
})();
