/* ═══════════════════════════════════════════════════════════════
   dsp-chain.js — Fixed recording DSP chain
   Applied automatically to EVERY microphone take right after
   capture, BEFORE analysis/enhancement/placement. Exact spec:

   1. Overall Gain            : −9 dB
   2. Noise Suppression (VAD) : threshold 0.60,
                                grace 200 ms (20 × 10 ms frames),
                                retroactive grace 0
   3. EQ Filter 1             : High-pass 70.0 Hz, 0.0 dB,
                                BW 1.60 oct → Q ≈ 0.8574
   4. EQ Filter 2             : Peaking 150.0 Hz, +4.0 dB,
                                BW 0.40 oct → Q ≈ 3.5957
   5. Noise Gate (downward expander):
                                threshold −inf dB (gate stays open),
                                attack 3 ms, hold 0 ms, release 100 ms,
                                hysteresis 0.0 dB,
                                sidechain LP 20 000 Hz / HP 0 Hz

   Q conversion:  Q = √(2^BW) / (2^BW − 1)
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const DspChain = (() => {

  /* ── exact parameters ─────────────────────────────── */
  const PARAMS = {
    gainDb: -9,
    vad: {
      threshold: 0.60,
      graceFrames: 20,        // 20 × 10 ms = 200 ms
      retroGraceFrames: 0,    // retroactive grace period
      frameMs: 10
    },
    eq1: { type: 'highpass', frequency: 70.0, gainDb: 0.0, bwOct: 1.60 },
    eq2: { type: 'peaking',  frequency: 150.0, gainDb: 4.0, bwOct: 0.40 },
    gate: {
      thresholdDb: -Infinity, // effectively always open
      attackMs: 3,
      holdMs: 0,
      releaseMs: 100,
      hysteresisDb: 0.0,
      sidechainLp: 20000,
      sidechainHp: 0
    }
  };

  const fromDB = d => (d === -Infinity ? 0 : Math.pow(10, d / 20));
  // bandwidth (octaves) → Q :  Q = sqrt(2^BW) / (2^BW − 1)
  function bwToQ(bw) {
    const p = Math.pow(2, bw);
    return Math.sqrt(p) / (p - 1);
  }

  /* ── 1. overall gain (−9 dB) ──────────────────────── */
  function applyGain(data, gainDb) {
    const g = fromDB(gainDb);
    for (let i = 0; i < data.length; i++) data[i] *= g;
    return data;
  }

  /* ── 2. VAD-based noise suppression ────────────────────
     RNNoise-style behaviour approximated in pure JS:
     • split into 10 ms frames
     • per-frame voice-activity probability from RMS energy +
       zero-crossing rate, scaled against the measured noise
       floor and speech peak of the take
     • frames with probability < 0.60 are muted UNLESS they fall
       within the 200 ms grace period after the last voiced frame
     • retroactive grace = 0 → no frames re-opened before speech
     • gains are ramped over 2 ms to avoid clicks               */
  function vadSuppress(data, sr, cfg) {
    const frameLen = Math.max(1, Math.round(sr * cfg.frameMs / 1000));
    const nFrames = Math.ceil(data.length / frameLen);
    if (nFrames < 3) return data;

    // frame features
    const rms = new Float32Array(nFrames);
    const zcr = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const i0 = f * frameLen, i1 = Math.min(i0 + frameLen, data.length);
      let s = 0, z = 0;
      for (let i = i0; i < i1; i++) {
        s += data[i] * data[i];
        if (i > i0 && (data[i] >= 0) !== (data[i - 1] >= 0)) z++;
      }
      const n = Math.max(1, i1 - i0);
      rms[f] = Math.sqrt(s / n);
      zcr[f] = z / n;
    }

    // adaptive scale: noise floor (10th pct) → speech level (90th pct)
    const sorted = [...rms].sort((a, b) => a - b);
    const floor = sorted[Math.floor(nFrames * 0.10)] || 1e-6;
    const speech = Math.max(sorted[Math.floor(nFrames * 0.90)] || 1e-5, floor * 4);

    // voice-activity probability per frame (0..1)
    const prob = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const energyScore = Math.min(1, Math.max(0, (rms[f] - floor) / (speech - floor)));
      // very high ZCR with low energy ⇒ hiss/noise, damp the score
      const noisiness = zcr[f] > 0.35 && energyScore < 0.5 ? 0.6 : 1.0;
      prob[f] = Math.pow(energyScore, 0.5) * noisiness;
    }

    // gating decision: threshold 0.60, grace 20 frames, retro 0
    const keep = new Uint8Array(nFrames);
    let grace = 0;
    for (let f = 0; f < nFrames; f++) {
      if (prob[f] >= cfg.threshold) {
        keep[f] = 1;
        grace = cfg.graceFrames;
        // retroactive grace period (0 per spec — loop no-ops)
        for (let b = 1; b <= cfg.retroGraceFrames && f - b >= 0; b++) keep[f - b] = 1;
      } else if (grace > 0) {
        keep[f] = 1;
        grace--;
      }
    }

    // apply with 2 ms ramps to avoid clicks
    const ramp = Math.max(1, Math.round(sr * 0.002));
    const out = new Float32Array(data.length);
    let g = keep[0] ? 1 : 0;
    for (let i = 0; i < data.length; i++) {
      const target = keep[Math.min(nFrames - 1, (i / frameLen) | 0)] ? 1 : 0;
      g += (target - g) / ramp * 4;
      if (g < 0) g = 0; else if (g > 1) g = 1;
      out[i] = data[i] * g;
    }
    return out;
  }

  /* ── 3+4. EQ via OfflineAudioContext biquads ───────── */
  async function applyEQ(data, sr) {
    const off = new OfflineAudioContext(1, data.length, sr);
    const buf = off.createBuffer(1, data.length, sr);
    buf.getChannelData(0).set(data);
    const src = off.createBufferSource();
    src.buffer = buf;

    // Filter 1 — High-pass 70 Hz, BW 1.60 oct → Q ≈ 0.857 (gain 0 dB: HP has no gain)
    const f1 = off.createBiquadFilter();
    f1.type = 'highpass';
    f1.frequency.value = PARAMS.eq1.frequency;
    f1.Q.value = bwToQ(PARAMS.eq1.bwOct);

    // Filter 2 — Peaking 150 Hz, +4 dB, BW 0.40 oct → Q ≈ 3.596
    const f2 = off.createBiquadFilter();
    f2.type = 'peaking';
    f2.frequency.value = PARAMS.eq2.frequency;
    f2.gain.value = PARAMS.eq2.gainDb;
    f2.Q.value = bwToQ(PARAMS.eq2.bwOct);

    src.connect(f1).connect(f2).connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return new Float32Array(rendered.getChannelData(0).subarray(0, data.length));
  }

  /* ── 5. Noise gate (downward expander) ─────────────────
     Faithful implementation of the envelope logic even though
     threshold = −inf dB keeps the gate permanently open.
     Sidechain: HP 0 Hz + LP 20 kHz = full band (identity at
     44.1/48 kHz, so the detector reads the signal directly).   */
  async function noiseGate(data, sr, cfg) {
    // sidechain detector signal
    let det = data;
    const nyquist = sr / 2;
    const needsLp = cfg.sidechainLp < nyquist;
    const needsHp = cfg.sidechainHp > 0;
    if (needsLp || needsHp) {
      const off = new OfflineAudioContext(1, data.length, sr);
      const buf = off.createBuffer(1, data.length, sr);
      buf.getChannelData(0).set(data);
      const src = off.createBufferSource(); src.buffer = buf;
      let node = src;
      if (needsHp) { const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = cfg.sidechainHp; node.connect(hp); node = hp; }
      if (needsLp) { const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cfg.sidechainLp; node.connect(lp); node = lp; }
      node.connect(off.destination); src.start(0);
      det = (await off.startRendering()).getChannelData(0);
    }

    const openTh = fromDB(cfg.thresholdDb);                       // 0 for −inf ⇒ always open
    const closeTh = fromDB(cfg.thresholdDb - cfg.hysteresisDb);   // hysteresis 0 ⇒ same
    const attack = Math.exp(-1 / (sr * cfg.attackMs / 1000));
    const release = Math.exp(-1 / (sr * cfg.releaseMs / 1000));
    const holdSamples = Math.round(sr * cfg.holdMs / 1000);

    const out = new Float32Array(data.length);
    let env = 0, gain = 1, open = true, hold = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(det[i]);
      env = a > env ? a + (env - a) * 0.9 : a + (env - a) * 0.999; // simple peak follower
      if (open) {
        if (env < closeTh) {
          if (hold >= holdSamples) open = false;
          else hold++;
        } else hold = 0;
      } else if (env >= openTh) { open = true; hold = 0; }
      const target = open ? 1 : 0;
      gain = target > gain ? target + (gain - target) * attack
                           : target + (gain - target) * release;
      out[i] = data[i] * gain;
    }
    return out;
  }

  /* ── public: run the full chain on a decoded AudioBuffer ── */
  async function process(buffer) {
    const sr = buffer.sampleRate;
    // work on a mono copy (mic input is mono; keeps chain deterministic)
    let data = new Float32Array(buffer.getChannelData(0));

    data = applyGain(data, PARAMS.gainDb);                 // 1. −9 dB
    data = vadSuppress(data, sr, PARAMS.vad);              // 2. VAD suppression
    data = await applyEQ(data, sr);                        // 3+4. HP 70 Hz + peak 150 Hz
    data = await noiseGate(data, sr, PARAMS.gate);         // 5. gate (open per spec)

    const ac = AudioEngine.getCtx();
    const out = ac.createBuffer(1, data.length, sr);
    out.getChannelData(0).set(data);
    return out;
  }

  function describe() {
    return [
      'Gain −9 dB',
      'VAD noise suppression (threshold 0.60, grace 200 ms, retro 0)',
      `EQ: high-pass 70 Hz (BW 1.60 oct, Q ${bwToQ(1.6).toFixed(3)})`,
      `EQ: peaking 150 Hz +4 dB (BW 0.40 oct, Q ${bwToQ(0.4).toFixed(3)})`,
      'Noise gate: −inf dB threshold (open), attack 3 ms, hold 0 ms, release 100 ms, hysteresis 0 dB, sidechain 0 Hz–20 kHz'
    ];
  }

  return { process, describe, PARAMS, bwToQ };
})();
