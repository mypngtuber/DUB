/* ═══════════════════════════════════════════════════════════════
   app.js — Dubbing Studio main application
   State + workflow glue between:
   parsers (deterministic) · audio-engine · recorder · gemini (AI)
   enhancer (AI audio enhancement) · timeline · exporter
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────── state ─────────────── */
const State = {
  project: null,          // {name, videoURL, videoFile, duration, segments[], characters[], srtErrors, scriptErrors}
  currentSegmentId: null,
  filterCharacter: null,  // null = all
  recording: false,
  userMode: 'single',     // 'single' | 'multi'
  assignments: {},        // character → user name
  activeUser: null,
  ownerView: false,
  playStopTimer: null,
  mergeMode: false,
  mergeSelection: new Set(),
  exportVoiceSource: 'segments',
  autoEnhance: localStorage.getItem('dubstudio.autoEnhance') === 'on'
};

const $ = id => document.getElementById(id);

/* ─────────────── toast ─────────────── */
function toast(msg, type = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'error' ? 'err' : type);
  const icon = { error: 'fa-circle-exclamation', ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', info: 'fa-circle-info' }[type] || 'fa-circle-info';
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
  el.querySelector('span').textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ═══════════════ SETUP WIZARD ═══════════════ */
const setupFiles = { video: null, srt: null, script: null };

function bindDrop(zoneId, inputId, nameId, key, accept) {
  const zone = $(zoneId), input = $(inputId);
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) setFile(input.files[0]); });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; });
  zone.addEventListener('dragleave', () => zone.style.borderColor = '');
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.style.borderColor = '';
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  function setFile(f) {
    if (accept && !accept(f)) { toast(`"${f.name}" doesn't look like a valid ${key} file.`, 'error'); return; }
    setupFiles[key] = f;
    $(nameId).textContent = f.name;
    zone.classList.add('has-file');
    checkSetupReady();
  }
}

function checkSetupReady() {
  $('btn-create-project').disabled = !(setupFiles.video && setupFiles.srt && setupFiles.script);
}

function pipelineStep(step, state) { // state: 'active' | 'done'
  const li = document.querySelector(`#pipeline-steps li[data-step="${step}"]`);
  if (!li) return;
  li.classList.remove('active', 'done');
  li.classList.add(state);
  li.querySelector('i').className = state === 'done' ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-notch fa-spin';
}

async function createProject() {
  const name = $('input-project-name').value.trim() || setupFiles.video.name.replace(/\.[^.]+$/, '');
  $('setup-error').style.display = 'none';
  $('processing-screen').style.display = 'flex';
  const note = t => { $('pipeline-note').textContent = t; };

  try {
    /* 1 — load video + extract original audio */
    pipelineStep('load', 'active');
    const videoURL = URL.createObjectURL(setupFiles.video);
    const video = $('video-player');
    video.src = videoURL;
    const duration = await new Promise((res, rej) => {
      video.onloadedmetadata = () => res(video.duration);
      video.onerror = () => rej(new Error('This video format is not supported by the browser. Try MP4 (H.264), MOV or WebM.'));
      setTimeout(() => rej(new Error('Timed out loading the video metadata.')), 30000);
    });
    note('Decoding audio track…');
    await AudioEngine.extractAudioFromVideo(setupFiles.video);
    pipelineStep('load', 'done');

    /* 2 — voice separation → VOICE_STEM + MUSIC_STEM */
    pipelineStep('separate', 'active');
    note('Separating voice and music (this can take a moment on long videos)…');
    try {
      await AudioEngine.separateStems(AudioEngine.getOriginalBuffer(), p => note(`Separating stems… ${Math.round(p * 100)}%`));
    } catch (e) {
      throw new Error('Audio separation failed: ' + e.message);
    }
    pipelineStep('separate', 'done');

    /* 3 — SRT */
    pipelineStep('srt', 'active');
    const srtText = await setupFiles.srt.text();
    const srt = Parsers.parseSRT(srtText);
    srt.errors.forEach(e => console.warn('[SRT]', e));
    pipelineStep('srt', 'done');

    /* 4 — script */
    pipelineStep('script', 'active');
    const scriptText = await setupFiles.script.text();
    const script = Parsers.parseScript(scriptText);
    script.errors.forEach(e => console.warn('[Script]', e));
    if (!script.characters.length) toast('No [CHARACTER] headers were found in the script — all lines will need review.', 'warn', 7000);
    pipelineStep('script', 'done');

    /* 5 — deterministic matching (+ optional AI resolution) */
    pipelineStep('match', 'active');
    note('Matching subtitle lines to script characters…');
    const matches = Parsers.matchCuesToScript(srt.cues, script.lines);
    const segments = Parsers.buildSegments(srt.cues, matches);

    const ambiguous = segments.filter(s => s.needsCharacterReview);
    if (ambiguous.length && Gemini.isConfigured() && localStorage.getItem('dubstudio.aiMatching') !== 'off') {
      note(`Asking Gemini to resolve ${ambiguous.length} ambiguous line(s)…`);
      try {
        const resolved = await Gemini.resolveAmbiguousCharacters(ambiguous, script.characters, script.lines);
        for (const r of resolved) {
          const seg = segments.find(s => s.id === r.id);
          if (!seg) continue;
          if (r.character && r.character !== 'UNKNOWN' && r.confidence >= 0.75 && script.characters.includes(Parsers.normalizeCharName(r.character))) {
            seg.character = Parsers.normalizeCharName(r.character);
            seg.needsCharacterReview = false;
            seg.status = 'empty';
          }
        }
      } catch (e) {
        console.warn('AI matching failed:', e);
        toast('Gemini matching failed (' + e.message + ') — ambiguous lines stay marked NEEDS REVIEW.', 'warn', 6500);
      }
    }
    pipelineStep('match', 'done');

    /* 6 — voice-stem speech timing analysis */
    pipelineStep('vad', 'active');
    note('Analyzing original speech timing vs SRT…');
    let srtWarnings = 0;
    for (const seg of segments) {
      const a = AudioEngine.analyzeSegmentSpeech(seg);
      if (a) {
        seg.originalSpeechStart = a.speechStart;
        seg.originalSpeechEnd = a.speechEnd;
        seg.speechAnalysis = a;
        seg.srtTimingOk = a.srtTimingOk;
        if (a.hasSpeech && !a.srtTimingOk) srtWarnings++;
      }
      await new Promise(r => setTimeout(r, 0));
    }
    pipelineStep('vad', 'done');

    /* 7 — dubbing timeline (pre-timed segments, BEFORE recording) */
    pipelineStep('timeline', 'active');
    State.project = {
      name, videoURL, videoFile: setupFiles.video, duration,
      segments, characters: buildCharacterIndex(segments),
      srtErrors: srt.errors, scriptErrors: script.errors,
      openRecording: createOpenRecordingState(duration)
    };
    resetOpenRecordingSession();
    pipelineStep('timeline', 'done');

    setTimeout(() => {
      $('processing-screen').style.display = 'none';
      enterWorkspace();
      const unknown = segments.filter(s => s.character === 'UNKNOWN').length;
      if (unknown) toast(`${unknown} line(s) could not be matched to a character — marked UNKNOWN / NEEDS REVIEW.`, 'warn', 7000);
      if (srtWarnings) toast(`${srtWarnings} line(s): original speech timing differs from SRT by >0.3s — flagged in Speech Analysis.`, 'warn', 7000);
      toast(`Dubbing timeline ready: ${segments.length} pre-timed segments created.`, 'ok');
    }, 350);

  } catch (err) {
    console.error(err);
    $('processing-screen').style.display = 'none';
    $('setup-error').style.display = 'block';
    $('setup-error').textContent = '⚠ ' + err.message;
  }
}

function buildCharacterIndex(segments) {
  const map = new Map();
  for (const s of segments) {
    if (!map.has(s.character)) map.set(s.character, { name: s.character, total: 0 });
    map.get(s.character).total++;
  }
  return [...map.values()].sort((a, b) =>
    (a.name === 'UNKNOWN') - (b.name === 'UNKNOWN') || b.total - a.total);
}

/* ═══════════════ WORKSPACE ═══════════════ */

const CHAR_COLORS = ['#4f8cff', '#3ecf8e', '#ffb02e', '#ff6b9d', '#22d3ee', '#a78bfa', '#f97362', '#84cc16'];
function charColor(name) {
  if (name === 'UNKNOWN') return '#c084fc';
  const chars = State.project.characters.filter(c => c.name !== 'UNKNOWN').map(c => c.name);
  return CHAR_COLORS[Math.max(0, chars.indexOf(name)) % CHAR_COLORS.length];
}

function enterWorkspace() {
  $('setup-screen').style.display = 'none';
  $('workspace').style.display = 'grid';
  $('topbar-progress').style.display = '';
  $('project-name-label').textContent = State.project.name;
  ['btn-focus-mode', 'btn-export', 'btn-user-mode', 'btn-preview-all', 'btn-open-recording', 'btn-save-project'].forEach(id => $(id).style.display = '');
  if (!State.project.openRecording) State.project.openRecording = createOpenRecordingState(State.project.duration);

  Timeline.init({ onSelect: id => selectSegment(id) });
  Timeline.setData(State.project.segments, State.project.duration);

  renderCharacters();
  renderQueue();
  renderProgress();

  const first = visibleSegments()[0];
  if (first) selectSegment(first.id);
}

/* which characters/segments the active user may see */
function allowedCharacters() {
  const all = State.project.characters.map(c => c.name);
  if (State.userMode !== 'multi' || State.ownerView || !State.activeUser) return all;
  return all.filter(c => State.assignments[c] === State.activeUser);
}
function visibleSegments() {
  const allowed = allowedCharacters();
  return State.project.segments.filter(s =>
    allowed.includes(s.character) &&
    (!State.filterCharacter || s.character === State.filterCharacter));
}
function getSegment(id) { return State.project.segments.find(s => s.id === id); }
function currentSegment() { return getSegment(State.currentSegmentId); }

/* ── left panel ── */
function renderCharacters() {
  const wrap = $('character-list');
  wrap.innerHTML = '';
  const allowed = allowedCharacters();

  const mk = (label, char, count, extra) => {
    const el = document.createElement('div');
    el.className = 'char-item' + (State.filterCharacter === char ? ' active' : '') + (char === 'UNKNOWN' ? ' unknown-char' : '');
    el.innerHTML = `<span class="c-name"><span class="c-dot"></span><span class="cn"></span>${extra || ''}</span><span class="c-count">${count}</span>`;
    el.querySelector('.cn').textContent = label;
    el.querySelector('.c-dot').style.background = char ? charColor(char) : 'var(--text-faint)';
    el.addEventListener('click', () => {
      State.filterCharacter = char;
      renderCharacters(); renderQueue();
      Timeline.setFilter(char);
      const first = visibleSegments()[0];
      if (first) selectSegment(first.id);
    });
    wrap.appendChild(el);
  };

  const total = State.project.segments.filter(s => allowed.includes(s.character));
  mk('ALL', null, `${total.filter(s => s.status === 'accepted').length} / ${total.length}`);

  for (const c of State.project.characters) {
    if (!allowed.includes(c.name)) continue;
    const segs = State.project.segments.filter(s => s.character === c.name);
    const acc = segs.filter(s => s.status === 'accepted').length;
    let tag = '';
    if (State.userMode === 'multi' && State.assignments[c.name]) {
      tag = `<span class="c-user-tag">${escapeHtml(State.assignments[c.name])}</span>`;
    }
    mk(c.name, c.name, `${acc} / ${segs.length}`, tag);
  }
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

const STATUS_QICON = {
  accepted: ['✓', 'st-accepted'], recording: ['●', 'st-recording'], processing: ['…', 'st-current'],
  needs_review: ['?', 'st-review'], timing_mismatch: ['⚠', 'st-mismatch'], retake: ['↻', 'st-retake'], empty: ['○', 'st-empty']
};

function renderQueue() {
  const wrap = $('dialogue-queue');
  wrap.innerHTML = '';
  $('queue-title').innerHTML = `<i class="fa-solid fa-list-ol"></i> ${State.filterCharacter ? escapeHtml(State.filterCharacter) + ' DIALOGUE' : 'ALL DIALOGUE'}`;
  for (const seg of visibleSegments()) {
    const [icon, cls] = STATUS_QICON[seg.status] || STATUS_QICON.empty;
    const el = document.createElement('div');
    const picked = State.mergeSelection.has(seg.id);
    el.className = 'q-item' + (seg.id === State.currentSegmentId ? ' current' : '') + (picked ? ' merge-picked' : '');
    const mergedCount = (seg.sourceLineNumbers || []).length;
    el.innerHTML = `${State.mergeMode ? `<input class="q-merge-check" type="checkbox" ${picked ? 'checked' : ''} aria-label="Select line for merge">` : ''}` +
      `<span class="q-num">${String(seg.lineNumber).padStart(3, '0')}</span><span class="q-text"></span>` +
      `${mergedCount > 1 ? `<span class="q-merged-badge">${mergedCount} lines</span>` : ''}<span class="q-status ${cls}">${icon}</span>`;
    el.querySelector('.q-text').textContent = seg.activeText;
    el.title = `${seg.character} — ${Timeline.statusLabel(seg.status)}`;
    el.addEventListener('click', e => {
      if (State.mergeMode) {
        e.preventDefault();
        if (State.mergeSelection.has(seg.id)) State.mergeSelection.delete(seg.id); else State.mergeSelection.add(seg.id);
        renderQueue();
      } else selectSegment(seg.id);
    });
    wrap.appendChild(el);
  }
}

function initMergeControls() {
  $('btn-merge-mode').addEventListener('click', () => {
    if (State.recording) return;
    State.mergeMode = true;
    State.mergeSelection.clear();
    $('btn-merge-mode').style.display = 'none';
    $('btn-merge-selected').style.display = '';
    $('btn-merge-cancel').style.display = '';
    renderQueue();
    toast('Select two or more consecutive lines for the same character, then press Merge selected.', 'info', 6000);
  });
  $('btn-merge-cancel').addEventListener('click', exitMergeMode);
  $('btn-merge-selected').addEventListener('click', () => {
    try {
      const result = Parsers.mergeSegments(State.project.segments, [...State.mergeSelection]);
      State.project.segments = result.segments;
      State.project.characters = buildCharacterIndex(result.segments);
      exitMergeMode(false);
      Timeline.setData(result.segments, State.project.duration);
      renderCharacters(); renderQueue(); renderProgress();
      selectSegment(result.merged.id);
      const lines = result.merged.sourceLineNumbers.join(', ');
      toast(`Merged SRT lines ${lines} into one ${result.merged.targetDuration.toFixed(2)}s recording performance.`, 'ok', 6500);
    } catch (e) { toast(e.message, 'error', 6500); }
  });
}

function exitMergeMode(render = true) {
  State.mergeMode = false;
  State.mergeSelection.clear();
  $('btn-merge-mode').style.display = '';
  $('btn-merge-selected').style.display = 'none';
  $('btn-merge-cancel').style.display = 'none';
  if (render) renderQueue();
}

function renderProgress() {
  const segs = State.project.segments;
  const acc = segs.filter(s => s.status === 'accepted').length;
  const pct = segs.length ? Math.round(acc / segs.length * 100) : 0;
  $('global-progress-fill').style.width = pct + '%';
  $('global-progress-text').textContent = pct + '%';

  const wrap = $('progress-panel');
  wrap.innerHTML = '';
  for (const c of State.project.characters) {
    const cs = segs.filter(s => s.character === c.name);
    const ca = cs.filter(s => s.status === 'accepted').length;
    const cp = cs.length ? Math.round(ca / cs.length * 100) : 0;
    const row = document.createElement('div');
    row.className = 'pp-row';
    row.innerHTML = `<label><span></span><span class="mono">${cp}%</span></label><div class="pp-bar"><div class="${cp === 100 ? 'full' : ''}" style="width:${cp}%"></div></div>`;
    row.querySelector('label span').textContent = c.name;
    wrap.appendChild(row);
  }
  const stats = document.createElement('div');
  stats.className = 'pp-stats';
  const review = segs.filter(s => s.status === 'needs_review').length;
  const retake = segs.filter(s => s.status === 'retake' || s.status === 'timing_mismatch').length;
  stats.innerHTML = `<span>Accepted <b>${acc}</b></span><span>Review <b>${review}</b></span>` +
                    `<span>Retake <b>${retake}</b></span><span>Remaining <b>${segs.length - acc}</b></span>`;
  wrap.appendChild(stats);
}

/* ── segment selection ── */
function selectSegment(id) {
  if (State.recording) { toast('Stop the current recording first.', 'warn'); return; }
  stopSegmentPlayback();
  AudioEngine.stopOriginalVoice();
  Recorder.stopTake();

  State.currentSegmentId = id;
  const seg = getSegment(id);
  if (!seg) return;

  // video follows the segment
  const video = $('video-player');
  if (video.readyState >= 1) video.currentTime = seg.startTime;

  renderDialogueStage(seg);
  renderQueue();
  renderTakes(seg);
  renderSpeechAnalysis(seg);
  renderAIPanel(seg);
  Timeline.setCurrent(id);
  updateFocusView();
  $('video-seg-badge').textContent =
    `#${String(seg.lineNumber).padStart(3, '0')} · ${Parsers.secondsToClock(seg.startTime)} → ${Parsers.secondsToClock(seg.endTime)}`;
}

function renderDialogueStage(seg) {
  const sourceLines = seg.sourceLineNumbers || [seg.lineNumber];
  $('ds-line').textContent = sourceLines.length > 1
    ? `Lines ${sourceLines.join(' + ')}`
    : 'Line ' + String(seg.lineNumber).padStart(3, '0');
  $('ds-character').textContent = seg.character;
  $('ds-character').style.color = charColor(seg.character);
  $('ds-text').textContent = seg.activeText;
  $('ds-target').textContent = seg.targetDuration.toFixed(2) + ' sec';
  $('ds-times').textContent = `${Parsers.secondsToClock(seg.startTime)} → ${Parsers.secondsToClock(seg.endTime)}`;
  const chip = $('ds-status');
  chip.textContent = Timeline.statusLabel(seg.status);
  chip.className = 'seg-status-chip chip-' + seg.status;
}

function renderSpeechAnalysis(seg) {
  const el = $('speech-analysis');
  const a = seg.speechAnalysis;
  if (!a) { el.textContent = 'No analysis available.'; return; }
  if (!a.hasSpeech) { el.innerHTML = '<span class="sa-warn">No clear speech detected in the original voice stem for this line.</span>'; return; }
  el.innerHTML =
    `Speech: <b>${Parsers.secondsToClock(a.speechStart)}</b> → <b>${Parsers.secondsToClock(a.speechEnd)}</b><br>` +
    `Duration: <b>${a.speechDuration.toFixed(2)}s</b> (SRT window ${seg.targetDuration.toFixed(2)}s)<br>` +
    `Silence before: ${a.silenceBefore.toFixed(2)}s · after: ${a.silenceAfter.toFixed(2)}s<br>` +
    (a.srtTimingOk
      ? '<span class="sa-ok">✓ SRT timing matches actual speech</span>'
      : '<span class="sa-warn">⚠ SRT timing differs from actual speech — needs review</span>');
}

/* ═══════════════ VIDEO ═══════════════ */

function initVideo() {
  const video = $('video-player');
  const playBtn = $('v-play');

  playBtn.addEventListener('click', () => togglePlay());
  video.addEventListener('click', () => togglePlay());
  video.addEventListener('play', () => playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>');
  video.addEventListener('pause', () => playBtn.innerHTML = '<i class="fa-solid fa-play"></i>');
  video.addEventListener('timeupdate', () => {
    $('v-time').textContent = Parsers.secondsToClock(video.currentTime);
    if (video.duration) $('v-seek').value = Math.round(video.currentTime / video.duration * 1000);
    Timeline.updatePlayhead(video.currentTime);
  });
  $('v-seek').addEventListener('input', e => {
    if (video.duration) video.currentTime = e.target.value / 1000 * video.duration;
  });
  $('v-volume').addEventListener('input', e => video.volume = e.target.value / 100);
  $('v-prev-frame').addEventListener('click', () => { video.pause(); video.currentTime = Math.max(0, video.currentTime - 1 / 24); });
  $('v-next-frame').addEventListener('click', () => { video.pause(); video.currentTime = Math.min(video.duration, video.currentTime + 1 / 24); });
  $('v-fullscreen').addEventListener('click', () => {
    const wrap = $('video-wrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
  });
  $('ar-switch').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    document.querySelectorAll('#ar-switch button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const wrap = $('video-wrap');
    wrap.className = wrap.className.replace(/ar-[\w-]+/g, '').trim() + ' ar-' + btn.dataset.ar;
  });
}

function togglePlay() {
  const video = $('video-player');
  if (video.paused && !State.dubPreviewing) playDubPreview(); else stopSegmentPlayback();
}

/* ▶ PLAY — strictly plays the NEWLY RECORDED audio for this segment,
   ACAPELLA (voice only) over the MUTED video. No background music:
   the current source-separation causes vocal bleed, so the music bed
   is dropped from the whole recording/preview workflow. The original
   audio is available only through the 🎤 Listen Original button. */
function playDubPreview() {
  const seg = currentSegment(); if (!seg) return;
  const take = seg.acceptedTakeId ? seg.takes.find(t => t.id === seg.acceptedTakeId) : latestTake(seg);
  if (!take || take.analysis.verdict === 'silent') {
    toast('No recording for this line yet — press RECORD first. (Use 🎤 Listen for the original voice.)', 'warn');
    return;
  }
  stopSegmentPlayback();
  State.dubPreviewing = true;
  const video = $('video-player');
  video.muted = true;                       // never leak original audio here
  video.currentTime = seg.startTime;
  video.play().catch(() => {});

  // acapella: dub voice only — no music bed
  Recorder.playTake(take);

  const stopAt = seg.endTime + 0.6;
  const check = () => {
    if (video.currentTime >= stopAt || video.paused) { stopSegmentPlayback(); return; }
    State.playStopTimer = requestAnimationFrame(check);
  };
  State.playStopTimer = requestAnimationFrame(check);
}

function stopSegmentPlayback() {
  if (State.playStopTimer) cancelAnimationFrame(State.playStopTimer);
  const video = $('video-player');
  if (!video.paused) video.pause();
  Recorder.stopTake();
  AudioEngine.stopMusic();
  AudioEngine.setRecordingDuck(false);
  stopFullPreview(false);
  if (State.dubPreviewing) { video.muted = false; State.dubPreviewing = false; }
}

/* ═════════════ PREVIEW FULL PROJECT ═════════════
   Plays the whole video (muted) from the start with ALL accepted
   dubbing takes fired sequentially at their exact segment times —
   strictly acapella: no original audio, no background music.      */

const FullPreview = { active: false, sources: [], raf: null };

function toggleFullPreview() {
  if (FullPreview.active) { stopFullPreview(true); return; }
  if (State.recording) { toast('Stop the current recording first.', 'warn'); return; }
  const accepted = State.project.segments.filter(s => s.acceptedTakeId);
  if (!accepted.length) { toast('No accepted takes yet — record and ACCEPT at least one line first.', 'warn'); return; }

  stopSegmentPlayback();
  AudioEngine.stopOriginalVoice();

  const video = $('video-player');
  const ac = AudioEngine.getCtx();
  FullPreview.active = true;
  FullPreview.sources = [];
  State.dubPreviewing = true;
  video.muted = true;                    // no original audio
  video.currentTime = 0;

  setFullPreviewUI(true);
  toast(`▶ Full project preview — ${accepted.length} accepted line(s), acapella dub over muted video.`, 'info');

  video.play().then(() => {
    const t0 = ac.currentTime + 0.08;
    // schedule every accepted take at its exact segment start
    for (const seg of accepted) {
      const take = seg.takes.find(t => t.id === seg.acceptedTakeId);
      if (!take) continue;
      const eff = (window.Enhancer && Enhancer.effectiveAudio)
        ? Enhancer.effectiveAudio(take)
        : { buffer: take.buffer, start: take.trimStart, duration: take.trimEnd - take.trimStart };
      const src = ac.createBufferSource();
      src.buffer = eff.buffer;
      src.connect(ac.destination);
      src.start(t0 + seg.startTime, eff.start, Math.min(eff.duration, seg.targetDuration + 0.4));
      FullPreview.sources.push(src);
    }
    const watch = () => {
      if (!FullPreview.active) return;
      if (video.ended || video.paused) { stopFullPreview(true); return; }
      FullPreview.raf = requestAnimationFrame(watch);
    };
    FullPreview.raf = requestAnimationFrame(watch);
  }).catch(err => {
    stopFullPreview(true);
    toast('Could not start the full preview: ' + err.message, 'error');
  });
}

function stopFullPreview(restoreUI) {
  if (!FullPreview.active) return;
  FullPreview.active = false;
  if (FullPreview.raf) cancelAnimationFrame(FullPreview.raf);
  for (const s of FullPreview.sources) { try { s.stop(); } catch (e) {} }
  FullPreview.sources = [];
  const video = $('video-player');
  if (restoreUI) {
    if (!video.paused) video.pause();
    video.muted = false;
    State.dubPreviewing = false;
    const seg = currentSegment();
    if (seg) video.currentTime = seg.startTime;
  }
  setFullPreviewUI(false);
}

function setFullPreviewUI(on) {
  const b = $('btn-preview-all');
  b.innerHTML = on ? '<i class="fa-solid fa-stop"></i> Stop Preview'
                   : '<i class="fa-solid fa-play"></i> Preview Full Project';
  b.classList.toggle('tb-btn-accent', on);
}

/* ═══════════════ ORIGINAL VOICE / MUSIC ═══════════════ */

function listenOriginal() {
  const seg = currentSegment(); if (!seg) return;
  const btns = [$('btn-listen-original'), $('f-listen')];
  const playing = btns[0].classList.contains('playing');
  if (playing) { AudioEngine.stopOriginalVoice(); btns.forEach(b => setListen(b, false)); return; }
  const ok = AudioEngine.playOriginalVoice(seg, { onEnded: () => btns.forEach(b => setListen(b, false)) });
  if (!ok) { toast('The voice stem is not available.', 'error'); return; }
  btns.forEach(b => setListen(b, true));
}
function setListen(btn, on) {
  btn.classList.toggle('playing', on);
  btn.innerHTML = on ? '<i class="fa-solid fa-stop"></i> Stop' :
    (btn.id === 'btn-listen-original' ? '<i class="fa-solid fa-play"></i> Listen <span class="kbd">L</span>' : '<i class="fa-solid fa-play"></i> Original Voice');
}

function initReferenceControls() {
  $('btn-listen-original').addEventListener('click', listenOriginal);
  $('f-listen').addEventListener('click', listenOriginal);
  // No manual volume UI: music level comes from AI auto-mix
  // (AudioEngine.computeAutoMix, run right after stem separation)
  // and voice-aware ducking is always on.
  AudioEngine.setDucking(true);
}

/* ═══════════════ PRE-RECORD COUNTDOWN ═══════════════ */

let countdownCancel = null;

function runCountdown(seconds = 3, label = 'GET READY…') {
  return new Promise(resolve => {
    const overlay = $('countdown-overlay');
    const num = $('countdown-number');
    overlay.style.display = 'flex';
    $('countdown-label').textContent = label;
    num.classList.remove('rec-go');
    let n = seconds;
    num.textContent = n;
    let timer = null;
    const finish = ok => {
      clearInterval(timer);
      overlay.style.display = 'none';
      document.removeEventListener('keydown', onKey, true);
      countdownCancel = null;
      resolve(ok);
    };
    countdownCancel = () => finish(false);
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    document.addEventListener('keydown', onKey, true);
    $('countdown-cancel').onclick = () => finish(false);
    timer = setInterval(() => {
      n--;
      if (n > 0) { num.textContent = n; }
      else {
        num.textContent = '● REC';
        num.classList.add('rec-go');
        clearInterval(timer);
        setTimeout(() => finish(true), 320);
      }
    }, 1000);
  });
}

/* ═══════════════ RECORDING ═══════════════ */

async function toggleRecord() {
  if (State.recording) {
    // in a multi-take session the RECORD button ends the take and rolls the next one
    if (MultiTake.active) { await nextMultiTake(); return; }
    await stopRecording();
    return;
  }
  const seg = currentSegment();
  if (!seg) { toast('Select a dialogue segment first.', 'warn'); return; }
  // Pre-record countdown (safety time to get ready)
  const go = await runCountdown(3, 'GET READY…');
  if (!go) return;
  try {
    await startRecording(seg);
  } catch (e) {
    toast(e.message, 'error', 6500);
    State.recording = false;
    setRecordUI(false);
  }
}

/* ═══════════════ MULTI-TAKE SESSION ═══════════════
   One session → several consecutive takes without restarting:
   MULTI starts the session · RECORD/MULTI (or M) rolls the next take ·
   FINISH ends it. Every take is auto-trimmed; the AI then scores all
   session takes (timing fit + clarity/SNR + cleanliness) and
   pre-selects the best one. */

const MultiTake = { active: false, segId: null, takeIds: [] };

async function toggleMultiTake() {
  if (MultiTake.active) { await finishMultiTake(); return; }
  if (State.recording) { toast('Stop the current recording first.', 'warn'); return; }
  const seg = currentSegment();
  if (!seg) { toast('Select a dialogue segment first.', 'warn'); return; }
  MultiTake.active = true;
  MultiTake.segId = seg.id;
  MultiTake.takeIds = [];
  setMultiTakeUI(true);
  toast('Multi-Take session: RECORD/M rolls the next take, FINISH ends the session and the AI picks the best take.', 'info', 5200);
  const go = await runCountdown(3, `TAKE 1 — GET READY…`);
  if (!go) { endMultiTakeSession(seg, false); return; }
  try { await startRecording(seg); }
  catch (e) { toast(e.message, 'error', 6500); endMultiTakeSession(seg, false); }
}

async function nextMultiTake() {
  const seg = getSegment(MultiTake.segId);
  await stopRecording({ keepMultiTake: true });
  if (!MultiTake.active || !seg) return;
  const n = MultiTake.takeIds.length + 1;
  const go = await runCountdown(2, `TAKE ${n} — GET READY…`);
  if (!go) { await finishMultiTake(); return; }
  try { await startRecording(seg); }
  catch (e) { toast(e.message, 'error', 6500); endMultiTakeSession(seg, false); }
}

async function finishMultiTake() {
  const seg = getSegment(MultiTake.segId);
  if (State.recording) await stopRecording({ keepMultiTake: true });
  endMultiTakeSession(seg, true);
}

function endMultiTakeSession(seg, evaluate) {
  const ids = [...MultiTake.takeIds];
  MultiTake.active = false;
  MultiTake.segId = null;
  MultiTake.takeIds = [];
  setMultiTakeUI(false);
  if (!seg) return;
  if (evaluate && ids.length) {
    const sessionTakes = seg.takes.filter(t => ids.includes(t.id));
    const best = Recorder.selectBestTake(sessionTakes, seg.targetDuration);
    if (best) {
      seg.aiBestTakeId = best.id;
      const idx = seg.takes.indexOf(best) + 1;
      toast(`✨ AI reviewed ${sessionTakes.length} take(s) — Take ${idx} is the best (score ${(best.aiScore.total * 100).toFixed(0)}%: ${best.aiScore.why}). Press ACCEPT to use it.`, 'ok', 7000);
      renderAll(seg);
      renderAIPanel(seg, best);
    } else if (sessionTakes.length) {
      toast('All session takes were silent or unusable — try again.', 'warn');
    }
  }
  renderAll(seg);
}

function setMultiTakeUI(on) {
  const b = $('btn-multitake');
  b.classList.toggle('multitake-active', on);
  b.querySelector('span').textContent = on ? 'FINISH' : 'MULTI';
  b.querySelector('i').className = on ? 'fa-solid fa-flag-checkered' : 'fa-solid fa-layer-group';
}

async function startRecording(seg) {
  await Recorder.ensureMic();
  stopSegmentPlayback();
  AudioEngine.stopOriginalVoice();

  State.recording = true;
  seg.prevStatus = seg.status;
  seg.status = 'recording';
  setRecordUI(true, seg);

  // acapella recording workflow: NO background music while recording
  // (source-separation vocal bleed would contaminate the take/monitoring)

  // video follows silently
  const video = $('video-player');
  video.muted = true;
  video.currentTime = seg.startTime;
  video.play().catch(() => {});

  const target = seg.targetDuration;
  const meterMax = Math.max(target * 1.6, target + 1);
  $('rec-meter-target-mark').style.left = (target / meterMax * 100) + '%';

  await Recorder.start(seg, {
    onTick: el => {
      const fill = Math.min(100, el / meterMax * 100);
      $('rec-meter-fill').style.width = fill + '%';
      $('rt-actual').textContent = el.toFixed(2) + 's';
      $('f-rt-actual').textContent = el.toFixed(2) + 's';
      const tol = Math.max(0.12, target * 0.06);
      let verdict, cls, color;
      if (el < target - tol) { verdict = 'KEEP GOING — UNDER TARGET'; cls = 'rv-near'; color = 'var(--accent)'; }
      else if (el <= target + tol) { verdict = '✓ WITHIN TARGET'; cls = 'rv-ok'; color = 'var(--ok)'; }
      else if (el <= target + tol * 2.5) { verdict = '⚠ NEAR LIMIT'; cls = 'rv-near'; color = 'var(--warn)'; }
      else { verdict = '⚠ TOO LONG'; cls = 'rv-bad'; color = 'var(--rec)'; }
      $('rec-meter-fill').style.background = color;
      const v = $('rec-timer-verdict'); v.textContent = verdict; v.className = 'rec-verdict ' + cls;
      const fv = $('f-rt-verdict'); fv.textContent = verdict; fv.className = cls;
      if (el > Math.max(30, target * 4)) stopRecording(); // safety cap
    },
    onLevel: l => { $('mic-level-fill').style.width = Math.min(100, l * 130) + '%'; }
  });

  renderQueue(); Timeline.render();
}

async function stopRecording({ keepMultiTake = false } = {}) {
  if (!keepMultiTake && MultiTake.active) { setMultiTakeUI(false); MultiTake.active = false; MultiTake.segId = null; MultiTake.takeIds = []; }
  const seg = currentSegment();
  if (!seg || !Recorder.isRecording()) { State.recording = false; setRecordUI(false); return; }
  seg.status = 'processing';
  const video = $('video-player');
  video.pause(); video.muted = false;
  AudioEngine.stopMusic();
  AudioEngine.setRecordingDuck(false);

  let take;
  try {
    take = await Recorder.stop(seg, {
      // Post-recording SAFETY TAIL: the mic keeps rolling briefly after
      // STOP so the end of the last word is never clipped/destroyed.
      onSafetyTail: ms => {
        const v1 = $('rec-timer-verdict');
        if (v1) { v1.textContent = `⏳ SAFETY TAIL… (+${(ms / 1000).toFixed(1)}s)`; v1.className = 'rec-verdict rv-ok'; }
        const v2 = $('f-rt-verdict');
        if (v2) { v2.textContent = `⏳ SAFETY TAIL…`; v2.className = 'rv-ok'; }
      }
    });
  } catch (e) {
    State.recording = false;
    seg.status = seg.prevStatus || 'empty';
    setRecordUI(false);
    renderAll(seg);
    toast('Recording failed: ' + e.message, 'error', 6500);
    return;
  }
  State.recording = false;
  setRecordUI(false);
  $('mic-level-fill').style.width = '0';

  seg.takes.push(take);
  if (keepMultiTake && MultiTake.active) MultiTake.takeIds.push(take.id);
  // status from analysis (take exists but NOT accepted yet)
  if (take.analysis.verdict === 'silent') {
    seg.status = 'retake';
    toast('The take was silent — check your microphone and try again.', 'error');
  } else if (take.analysis.verdict === 'perfect' || take.analysis.verdict === 'near') {
    seg.status = 'needs_review';
  } else {
    seg.status = 'timing_mismatch';
  }
  renderAll(seg);
  renderAIPanel(seg, take);

  // AI Auto Enhance every new take when enabled (fully automatic)
  if (State.autoEnhance && take.analysis.verdict !== 'silent') {
    enhanceTakeUI(seg, take, { silent: false });
  }
}

function setRecordUI(on, seg) {
  const rb = $('btn-record'), fb = $('f-record');
  [rb, fb].forEach(b => {
    b.classList.toggle('recording', on);
    b.querySelector('span').textContent = on ? 'STOP' : 'RECORD';
    b.querySelector('i').className = on ? 'fa-solid fa-square' : 'fa-solid fa-circle';
  });
  ['btn-prev', 'btn-next', 'btn-play-seg', 'btn-accept', 'btn-rerecord', 'f-prev', 'f-next', 'f-accept']
    .forEach(id => $(id).disabled = on);
  // MULTI stays enabled during a session (it becomes FINISH)
  $('btn-multitake').disabled = on && !MultiTake.active;
  $('rec-timer').style.visibility = on ? 'visible' : 'hidden';
  $('focus-rec-timer').style.visibility = on ? 'visible' : 'hidden';
  if (on && seg) {
    $('rt-target').textContent = seg.targetDuration.toFixed(2) + 's';
    $('f-rt-target').textContent = seg.targetDuration.toFixed(2) + 's';
    $('rt-actual').textContent = '0.00s'; $('f-rt-actual').textContent = '0.00s';
    $('rec-meter-fill').style.width = '0';
  }
}

function renderAll(seg) {
  renderDialogueStage(seg);
  renderQueue();
  renderProgress();
  renderTakes(seg);
  Timeline.render();
  renderCharacters();
  updateFocusView();
}

/* ═══════════════ AI AUDIO ENHANCEMENT ═══════════════ */

async function enhanceTakeUI(seg, take, { silent = false } = {}) {
  if (take._enhancing) return;
  take._enhancing = true;
  renderTakes(seg);
  try {
    await Enhancer.enhanceTake(take, {
      onStatus: s => {
        const lbl = document.querySelector(`[data-enh-status="${take.id}"]`);
        if (lbl) lbl.textContent = s;
      }
    });
    if (!silent) toast('✨ AI enhancement complete — noise cleaned, EQ, compression, de-essing and loudness applied automatically.', 'ok', 5000);
  } catch (e) {
    toast(e.message, 'error', 6000);
  } finally {
    take._enhancing = false;
    renderTakes(seg);
    Timeline.render();
    if (seg.id === State.currentSegmentId) renderAIPanel(seg, take);
  }
}

/* ═══════════════ TAKES ═══════════════ */

const VERDICT_LABEL = {
  perfect: ['✓ Perfect', 'st-accepted'], near: ['≈ Slightly Off', 'st-retake'],
  too_long: ['⚠ Too Long', 'st-mismatch'], too_short: ['⚠ Too Short', 'st-mismatch'],
  silent: ['✕ Silent', 'st-recording']
};

function renderTakes(seg) {
  const wrap = $('takes-list');
  $('takes-line-label').textContent = seg ? `LINE ${String(seg.lineNumber).padStart(3, '0')} — ${seg.character}` : '';
  wrap.innerHTML = '';
  if (!seg || !seg.takes.length) {
    wrap.innerHTML = '<div class="takes-empty">No takes yet for this line.</div>';
    return;
  }
  seg.takes.forEach((take, i) => {
    const [vLabel, vCls] = VERDICT_LABEL[take.status] || ['—', ''];
    const isAccepted = seg.acceptedTakeId === take.id;
    const card = document.createElement('div');
    card.className = 'take-card' + (isAccepted ? ' accepted' : '') + (seg.aiBestTakeId === take.id ? ' best-take' : '');
    const durTxt = take.fitted ? `${take.fittedDuration.toFixed(2)}s (fitted)` : `${take.duration.toFixed(2)}s`;
    const bestBadge = seg.aiBestTakeId === take.id
      ? `<span class="best-badge" title="AI pick — score ${take.aiScore ? (take.aiScore.total * 100).toFixed(0) + '%' : ''}: timing ${take.aiScore?.timing ?? '-'}, clarity ${take.aiScore?.clarity ?? '-'} (SNR ${take.aiScore?.snrDb ?? '-'}dB), cleanliness ${take.aiScore?.clean ?? '-'} — ${escapeHtml(take.aiScore?.why || '')}">⭐ AI BEST</span>` : '';
    const dspBadge = take.dspApplied
      ? `<span class="enh-badge dsp-badge" title="${escapeHtml((take.dspChain || []).join('\n'))}">DSP</span>` : '';
    const enhBadge = (take.enhanced
      ? `<span class="enh-badge" title="${escapeHtml((take.enhanceReport || []).join('\n'))}">✨ ENHANCED${take.enhanceGemini ? ' +AI' : ''}</span>` : '') + dspBadge;
    card.innerHTML =
      `<div class="take-head"><b>Take ${i + 1}${isAccepted ? ' — ✓ ACCEPTED' : ''}</b><span class="take-dur">${durTxt} / ${seg.targetDuration.toFixed(2)}s</span></div>` +
      `<div class="take-verdict ${vCls}">${vLabel} (${take.analysis.diff >= 0 ? '+' : ''}${take.analysis.diff.toFixed(2)}s) ${bestBadge}${enhBadge}</div>` +
      `<canvas class="take-canvas"></canvas>` +
      (take._enhancing
        ? `<div class="enh-progress"><i class="fa-solid fa-circle-notch fa-spin"></i> <span data-enh-status="${take.id}">Enhancing…</span></div>`
        : '') +
      `<div class="take-actions">
         <button class="prev-btn" title="Preview"><i class="fa-solid fa-play"></i> Preview</button>
         <button class="enh-btn" title="AI analyzes this take and automatically cleans, EQs, compresses, de-esses and normalizes it" ${take._enhancing || take.status === 'silent' ? 'disabled' : ''}>
           <i class="fa-solid fa-wand-magic-sparkles"></i> ${take.enhanced ? 'Re-Enhance' : 'AI Enhance'}</button>
         <button class="use-btn"><i class="fa-solid fa-check"></i> Use</button>
         <button class="del-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
       </div>` +
      (take.enhanced && !take._enhancing ? renderEnhanceReport(take) : '');
    const canvas = card.querySelector('.take-canvas');
    requestAnimationFrame(() => Timeline.drawWave(canvas, take, isAccepted ? '#3ecf8e' : (take.enhanced ? '#c084fc' : '#4f8cff')));
    card.querySelector('.prev-btn').addEventListener('click', () => Recorder.playTake(take));
    card.querySelector('.enh-btn').addEventListener('click', () => enhanceTakeUI(seg, take));
    card.querySelector('.use-btn').addEventListener('click', () => acceptTake(seg, take.id));
    card.querySelector('.del-btn').addEventListener('click', () => {
      seg.takes = seg.takes.filter(t => t.id !== take.id);
      if (seg.acceptedTakeId === take.id) {
        seg.acceptedTakeId = null;
        seg.status = seg.takes.length ? 'needs_review' : 'empty';
      }
      if (seg.aiBestTakeId === take.id) {
        seg.aiBestTakeId = null;
        const best = Recorder.selectBestTake(seg.takes, seg.targetDuration);
        if (best) seg.aiBestTakeId = best.id;
      }
      renderAll(seg);
    });
    const repToggle = card.querySelector('.enh-report-toggle');
    if (repToggle) repToggle.addEventListener('click', () => {
      card.querySelector('.enh-report').classList.toggle('open');
      repToggle.querySelector('i').classList.toggle('fa-rotate-180');
    });
    const abBtn = card.querySelector('.enh-ab');
    if (abBtn) abBtn.addEventListener('click', () => {
      // A/B: play the raw take once (enhanced plays via Preview)
      Recorder.playTakeRaw(take);
    });
    wrap.appendChild(card);
  });
}

function renderEnhanceReport(take) {
  const items = (take.enhanceReport || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
  const m = take.enhanceMetrics;
  const metrics = m ? `<div class="enh-metrics mono">SNR ${m.snrDb}dB · peak ${m.peakDb}dB · crest ${m.crestDb}dB · sibilance ${(m.sibilanceRatio * 100).toFixed(0)}%</div>` : '';
  return `<div class="enh-wrap">
    <button class="enh-report-toggle">✨ What the AI did <i class="fa-solid fa-chevron-down"></i></button>
    <button class="enh-ab" title="Play the original (unenhanced) recording for comparison"><i class="fa-solid fa-headphones"></i> Hear Original</button>
    <div class="enh-report">${metrics}<ul>${items}</ul></div>
  </div>`;
}

/* ── ACCEPT TAKE — explicit, never silent ── */
function acceptTake(seg, takeId) {
  // default: the AI-selected best take (multi-take session), else the latest
  const take = takeId ? seg.takes.find(t => t.id === takeId)
             : (seg.aiBestTakeId && seg.takes.find(t => t.id === seg.aiBestTakeId)) || latestTake(seg);
  if (!take) { toast('No take to accept — record one first.', 'warn'); return; }
  if (take.analysis.verdict === 'silent') { toast('This take is silent and cannot be accepted.', 'error'); return; }
  seg.acceptedTakeId = take.id;
  seg.status = 'accepted';
  renderAll(seg);
  renderAIPanel(seg);
  toast(`Take accepted → placed into segment #${String(seg.lineNumber).padStart(3, '0')} (${Parsers.secondsToClock(seg.startTime)} → ${Parsers.secondsToClock(seg.endTime)}).`, 'ok');
  const vis = visibleSegments();
  const idx = vis.findIndex(s => s.id === seg.id);
  const next = vis.slice(idx + 1).find(s => s.status !== 'accepted');
  if (next) selectSegment(next.id);
}

function latestTake(seg) { return seg.takes.length ? seg.takes[seg.takes.length - 1] : null; }

/* ═══════════════ AI TIMING ASSISTANT ═══════════════ */

function renderAIPanel(seg, take) {
  const panel = $('ai-panel');
  panel.innerHTML = '';
  if (!seg) { panel.innerHTML = '<div class="ai-idle">Select a dialogue segment.</div>'; return; }
  take = take || latestTake(seg);

  if (seg.needsCharacterReview) {
    const w = document.createElement('div');
    w.className = 'ai-mismatch';
    w.innerHTML = `<h4>? CHARACTER NEEDS REVIEW</h4><div style="font-size:11.5px">This line could not be confidently matched to a script character${seg.character !== 'UNKNOWN' ? ` (best guess: <b>${escapeHtml(seg.character)}</b>)` : ''}. Verify before recording.</div>`;
    panel.appendChild(w);
  }

  if (!take) {
    const idle = document.createElement('div');
    idle.className = 'ai-idle';
    idle.textContent = 'Record a take and the assistant will compare it with the target duration.';
    panel.appendChild(idle);
    renderSuggestions(panel, seg, null);
    return;
  }

  const a = take.analysis;
  const isOk = a.verdict === 'perfect';
  const card = document.createElement('div');
  card.className = 'ai-mismatch' + (isOk ? ' ok' : '');
  const title = isOk ? '✓ TIMING OK' :
    a.verdict === 'silent' ? '✕ NO SPEECH DETECTED' :
    a.verdict === 'near' ? '≈ SLIGHTLY OFF TARGET' : '⚠ TIMING MISMATCH';
  card.innerHTML =
    `<h4>${title}</h4>
     <div class="ai-nums">
       <div><label>TARGET</label><b>${seg.targetDuration.toFixed(2)}s</b></div>
       <div><label>YOUR RECORDING</label><b>${a.speechDuration.toFixed(2)}s</b></div>
       <div><label>DIFFERENCE</label><b style="color:${Math.abs(a.diff) <= 0.15 ? 'var(--ok)' : 'var(--warn)'}">${a.diff >= 0 ? '+' : ''}${a.diff.toFixed(2)}s</b></div>
     </div>`;
  if (a.flags.length) {
    const fl = document.createElement('div');
    fl.className = 'ai-flags';
    fl.innerHTML = a.flags.map(f => `<span class="flag-warn">• ${escapeHtml(f)}</span>`).join('');
    card.appendChild(fl);
  } else if (isOk) {
    const fl = document.createElement('div');
    fl.className = 'ai-flags';
    fl.innerHTML = '<span class="flag-ok">• Clean take — press ACCEPT to place it into the segment.</span>';
    card.appendChild(fl);
  }
  panel.appendChild(card);

  // AI AUTO ENHANCE quick action (when not yet enhanced)
  if (a.verdict !== 'silent' && !take.enhanced && !take._enhancing) {
    const eBox = document.createElement('div');
    eBox.className = 'ai-fit-box';
    eBox.innerHTML = 'Let the AI analyze this take and automatically clean noise, EQ, compress, de-ess and normalize the voice.<br>';
    const eb = document.createElement('button');
    eb.className = 'btn-ghost enh-cta';
    eb.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI Auto Enhance';
    eb.addEventListener('click', () => enhanceTakeUI(seg, take));
    eBox.appendChild(eb);
    panel.appendChild(eBox);
  } else if (take.enhanced) {
    const done = document.createElement('div');
    done.className = 'ai-fit-box';
    done.innerHTML = `<span style="color:var(--review)">✨ Take enhanced${take.enhanceGemini ? ' (Gemini-refined)' : ''}.</span> Preview it in the Takes panel, then Accept.`;
    panel.appendChild(done);
  }

  // FIT AUDIO TO TARGET (small differences only, optional)
  if (!isOk && a.verdict !== 'silent') {
    const fit = Recorder.canFit(take, seg.targetDuration);
    const box = document.createElement('div');
    box.className = 'ai-fit-box';
    if (fit.ok && !take.fitted) {
      box.innerHTML = `The difference is small (${(Math.abs(1 - fit.ratio) * 100).toFixed(0)}%). A gentle time-stretch can fit this take to the target without obvious distortion.<br>`;
      const b = document.createElement('button');
      b.className = 'btn-ghost';
      b.innerHTML = '<i class="fa-solid fa-arrows-left-right-to-line"></i> Fit Audio to Target';
      b.addEventListener('click', () => {
        try {
          Recorder.fitToTarget(take, seg.targetDuration);
          take.status = 'perfect';
          seg.status = 'needs_review';
          toast(`Take fitted to ${seg.targetDuration.toFixed(2)}s. Preview it, then Accept.`, 'ok');
          renderAll(seg); renderAIPanel(seg, take);
        } catch (e) { toast(e.message, 'error'); }
      });
      box.appendChild(b);
    } else if (take.fitted) {
      box.innerHTML = `<span style="color:var(--ok)">✓ Fitted to ${take.fittedDuration.toFixed(2)}s.</span> Preview the fitted take, then Accept.`;
    } else {
      box.innerHTML = 'The difference is too large for a clean time-stretch — <b>record again</b> or use an <b>AI rewrite</b> below.';
    }
    panel.appendChild(box);
  }

  renderSuggestions(panel, seg, take, a);
}

function renderSuggestions(panel, seg, take, analysis) {
  // group existing variations: condensed first, then expanded
  const shorter = seg.aiSuggestions.filter(s => s.direction === 'shorter');
  const longer = seg.aiSuggestions.filter(s => s.direction === 'longer');
  if (shorter.length || longer.length) {
    const head = document.createElement('div');
    head.className = 'ai-variations-head';
    head.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> AI VARIATIONS — pick what fits your pace`;
    panel.appendChild(head);
  }
  if (shorter.length) {
    const lbl = document.createElement('div');
    lbl.className = 'ai-dir-label';
    lbl.innerHTML = '<i class="fa-solid fa-down-left-and-up-right-to-center"></i> CONDENSED (shorter)';
    panel.appendChild(lbl);
    for (const sug of shorter) appendSuggestionCard(panel, seg, sug);
  }
  if (longer.length) {
    const lbl = document.createElement('div');
    lbl.className = 'ai-dir-label';
    lbl.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i> EXPANDED (longer)';
    panel.appendChild(lbl);
    for (const sug of longer) appendSuggestionCard(panel, seg, sug);
  }

  // on ANY timing mismatch: generate BOTH directions in one shot
  if (take && analysis && (analysis.verdict === 'too_long' || analysis.verdict === 'too_short' || analysis.verdict === 'near')) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-actions';
    wrap.style.gridTemplateColumns = '1fr';
    const gen = document.createElement('button');
    gen.className = 'primary';
    gen.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> AI: Suggest shorter + longer variations (${Gemini.getModel()})`;
    gen.addEventListener('click', async () => {
      if (!Gemini.isConfigured()) { toast('Add your Gemini API key in Settings first.', 'warn'); openModal('modal-settings'); populateSettings(); return; }
      const loading = document.createElement('div');
      loading.className = 'ai-loading';
      loading.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Asking Gemini for condensed & expanded character-faithful variations…';
      panel.appendChild(loading);
      gen.disabled = true;
      try {
        const context = State.project.segments
          .filter(s => s.character === seg.character && s.id !== seg.id).slice(0, 6)
          .map(s => '• ' + s.text).join('\n');
        const sugs = await Gemini.suggestTimedRewrites(seg, take, context);
        seg.aiSuggestions.push(...sugs);
        renderAIPanel(seg, take);
      } catch (e) {
        loading.remove(); gen.disabled = false;
        toast(e.message, 'error', 7000);
      }
    });
    wrap.appendChild(gen);
    panel.appendChild(wrap);
  }
}

function appendSuggestionCard(panel, seg, sug) {
  const card = document.createElement('div');
  card.className = 'ai-suggestion';
  card.innerHTML =
    `<h4><i class="fa-solid fa-wand-magic-sparkles"></i> AI SUGGESTED VERSION (${sug.direction})</h4>
     <div class="ai-sug-text"></div>
     <div class="ai-sug-est">Estimated duration: <b>${sug.estimatedDuration != null ? '~' + sug.estimatedDuration.toFixed(2) + 's' : 'n/a'}</b> · target ${seg.targetDuration.toFixed(2)}s</div>
     ${sug.note ? `<div class="ai-sug-est" style="margin-top:4px">${escapeHtml(sug.note)}</div>` : ''}
     <div class="ai-actions">
       <button class="primary use-sug">USE AI SUGGESTION</button>
       <button class="edit-sug">EDIT TEXT</button>
       <button class="rerec-sug">RECORD AGAIN</button>
       <button class="keep-sug">KEEP ORIGINAL</button>
     </div>`;
  card.querySelector('.ai-sug-text').textContent = sug.text;

  // Explicit approval required — never auto-replace
  card.querySelector('.use-sug').addEventListener('click', () => {
    seg.activeText = sug.text;
    seg.status = 'retake';
    toast('AI version approved. The segment text was updated — record the new version.', 'ok');
    renderAll(seg); renderAIPanel(seg);
  });
  card.querySelector('.edit-sug').addEventListener('click', () => {
    if (card.querySelector('.edit-text-area')) return;
    const ta = document.createElement('textarea');
    ta.className = 'edit-text-area';
    ta.value = sug.text;
    const save = document.createElement('button');
    save.className = 'btn-ghost';
    save.innerHTML = '<i class="fa-solid fa-check"></i> Apply edited text';
    save.addEventListener('click', () => {
      if (!ta.value.trim()) { toast('Text cannot be empty.', 'warn'); return; }
      seg.activeText = ta.value.trim();
      seg.status = 'retake';
      toast('Edited text applied — record the new version.', 'ok');
      renderAll(seg); renderAIPanel(seg);
    });
    card.appendChild(ta); card.appendChild(save);
    ta.focus();
  });
  card.querySelector('.rerec-sug').addEventListener('click', () => toggleRecord());
  card.querySelector('.keep-sug').addEventListener('click', () => {
    seg.aiSuggestions = seg.aiSuggestions.filter(s => s.id !== sug.id);
    if (seg.activeText !== seg.text) {
      seg.activeText = seg.text;
      toast('Original text restored.', 'info');
    }
    renderAll(seg); renderAIPanel(seg);
  });
  panel.appendChild(card);
}

/* ═══════════════ NAVIGATION ═══════════════ */

function navigate(delta) {
  const vis = visibleSegments();
  if (!vis.length) return;
  const idx = vis.findIndex(s => s.id === State.currentSegmentId);
  const next = vis[Math.min(vis.length - 1, Math.max(0, (idx < 0 ? 0 : idx + delta)))];
  if (next) selectSegment(next.id);
}

function initTransport() {
  $('btn-prev').addEventListener('click', () => navigate(-1));
  $('btn-next').addEventListener('click', () => navigate(1));
  $('btn-play-seg').addEventListener('click', () => togglePlay());
  $('btn-record').addEventListener('click', toggleRecord);
  $('btn-multitake').addEventListener('click', toggleMultiTake);
  $('btn-rerecord').addEventListener('click', () => { if (!State.recording) toggleRecord(); });
  $('btn-accept').addEventListener('click', () => { const s = currentSegment(); if (s) acceptTake(s, null); });
  $('f-prev').addEventListener('click', () => navigate(-1));
  $('f-next').addEventListener('click', () => navigate(1));
  $('f-record').addEventListener('click', toggleRecord);
  $('f-accept').addEventListener('click', () => { const s = currentSegment(); if (s) acceptTake(s, null); });

  document.addEventListener('keydown', e => {
    if (!State.project) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    switch (e.key) {
      case ' ': e.preventDefault(); if (!State.recording) togglePlay(); break;
      case 'r': case 'R': e.preventDefault(); toggleRecord(); break;
      case 'Enter': e.preventDefault(); if (!State.recording) { const s = currentSegment(); if (s) acceptTake(s, null); } break;
      case 'ArrowLeft': e.preventDefault(); if (!State.recording) navigate(-1); break;
      case 'ArrowRight': e.preventDefault(); if (!State.recording) navigate(1); break;
      case 'l': case 'L': e.preventDefault(); if (!State.recording) listenOriginal(); break;
      case 'm': case 'M': e.preventDefault(); toggleMultiTake(); break;
      case 'p': case 'P': e.preventDefault(); if (!State.recording) toggleFullPreview(); break;
      case 'f': case 'F': e.preventDefault(); toggleFocusMode(); break;
    }
  });
}

/* ═══════════════ FOCUS MODE ═══════════════ */
let focusOn = false;

function toggleFocusMode() {
  if (!State.project) return;
  focusOn = !focusOn;
  const overlay = $('focus-overlay');
  const videoWrap = $('video-wrap');
  if (focusOn) {
    $('focus-video-slot').appendChild(videoWrap);
    overlay.style.display = 'block';
    updateFocusView();
  } else {
    $('panel-center').insertBefore(videoWrap, $('dialogue-stage'));
    overlay.style.display = 'none';
  }
}

function updateFocusView() {
  if (!focusOn) return;
  const seg = currentSegment(); if (!seg) return;
  $('focus-character').textContent = seg.character;
  $('focus-character').style.color = charColor(seg.character);
  $('focus-text').textContent = seg.activeText;
  $('focus-text').style.fontSize = Math.min(96, (+$('text-size').value) + 12) + 'px';
  $('focus-target').textContent = `Target: ${seg.targetDuration.toFixed(2)}s · ${Parsers.secondsToClock(seg.startTime)} → ${Parsers.secondsToClock(seg.endTime)}`;
  $('focus-segment').textContent =
    `SEGMENT #${String(seg.lineNumber).padStart(3, '0')} · ${Timeline.statusLabel(seg.status)} · ${seg.takes.length} take(s)`;
}

/* ═══════════════ OPEN RECORDING — FULL CLIP ═══════════════ */

const OpenRec = { recording: false, stopping: false, cursor: 0, recordStart: 0, selection: [0, 0], replaceEnd: null, playSource: null, history: [], dragStart: null };

function createOpenRecordingState(duration) {
  return { buffer: null, hasAudio: false, duration, edits: [] };
}

function resetOpenRecordingSession() {
  stopOpenPlayback();
  OpenRec.recording = false; OpenRec.stopping = false; OpenRec.cursor = 0; OpenRec.recordStart = 0;
  OpenRec.selection = [0, 0]; OpenRec.replaceEnd = null; OpenRec.history = [];
}

function openRecordingEditor() {
  if (!State.project || State.recording) return;
  const video = $('open-rec-video');
  video.src = State.project.videoURL;
  video.currentTime = Math.min(OpenRec.cursor, State.project.duration);
  $('open-sel-start').max = State.project.duration;
  $('open-sel-end').max = State.project.duration;
  openModal('modal-open-recording');
  updateOpenRecordingUI();
  drawOpenWaveform();
}

function initOpenRecording() {
  $('btn-open-recording').addEventListener('click', openRecordingEditor);
  const video = $('open-rec-video');
  video.addEventListener('timeupdate', () => {
    OpenRec.cursor = video.currentTime;
    updateOpenRecordingUI();
    if (OpenRec.recording && OpenRec.replaceEnd != null && video.currentTime >= OpenRec.replaceEnd) stopOpenRecording();
  });
  video.addEventListener('ended', () => { if (OpenRec.recording) stopOpenRecording(); else stopOpenPlayback(); });
  $('open-seek').addEventListener('input', e => setOpenCursor((+e.target.value / 1000) * State.project.duration));
  $('open-play-video').addEventListener('click', () => {
    if (OpenRec.playSource) { stopOpenPlayback(); return; }
    video.muted = true;
    if (video.paused) video.play().catch(() => {}); else video.pause();
    updateOpenTransport();
  });
  $('open-to-start').addEventListener('click', () => setOpenCursor(0));
  $('open-play-track').addEventListener('click', playOpenTrack);
  $('open-record').addEventListener('click', () => startOpenRecording(false));
  $('open-record-selection').addEventListener('click', () => startOpenRecording(true));
  $('open-stop').addEventListener('click', () => OpenRec.recording ? stopOpenRecording() : stopOpenPlayback());
  $('open-set-in').addEventListener('click', () => setOpenSelection(OpenRec.cursor, OpenRec.selection[1]));
  $('open-set-out').addEventListener('click', () => setOpenSelection(OpenRec.selection[0], OpenRec.cursor));
  $('open-sel-start').addEventListener('change', readOpenSelectionInputs);
  $('open-sel-end').addEventListener('change', readOpenSelectionInputs);
  $('open-delete-selection').addEventListener('click', deleteOpenSelection);
  $('open-clear').addEventListener('click', clearOpenTrack);
  $('open-undo').addEventListener('click', undoOpenEdit);
  bindOpenWaveSelection();
}

function setOpenCursor(seconds) {
  const duration = State.project.duration;
  OpenRec.cursor = Math.max(0, Math.min(duration, seconds || 0));
  const video = $('open-rec-video');
  video.pause();
  video.currentTime = OpenRec.cursor;
  stopOpenPlayback();
  updateOpenRecordingUI();
}

function updateOpenRecordingUI() {
  if (!State.project) return;
  const duration = State.project.duration;
  const video = $('open-rec-video');
  const time = Number.isFinite(video.currentTime) ? video.currentTime : OpenRec.cursor;
  $('open-rec-time').textContent = `${Parsers.secondsToClock(time)} / ${Parsers.secondsToClock(duration)}`;
  $('open-seek').value = duration ? Math.round(time / duration * 1000) : 0;
  updateOpenScript(time);
  updateOpenTransport();
  drawOpenWaveform();
}

function updateOpenScript(time) {
  const segs = State.project.segments;
  const index = segs.findIndex(s => time >= s.startTime && time < s.endTime);
  const seg = index >= 0 ? segs[index] : null;
  if (!seg) {
    $('open-script-character').textContent = '—';
    $('open-script-text').textContent = '…';
    $('open-script-next').textContent = '';
    $('open-script-progress-fill').style.width = '0%';
    return;
  }
  $('open-script-character').textContent = seg.character;
  $('open-script-character').style.color = charColor(seg.character);
  $('open-script-text').textContent = seg.activeText;
  const progress = (time - seg.startTime) / Math.max(0.01, seg.endTime - seg.startTime);
  $('open-script-progress-fill').style.width = Math.max(0, Math.min(100, progress * 100)) + '%';
  const next = segs[index + 1];
  $('open-script-next').textContent = next ? `التالي: ${next.activeText}` : '';
}

function updateOpenTransport() {
  const recording = OpenRec.recording;
  const playing = !$('open-rec-video').paused;
  $('open-record').disabled = recording;
  $('open-record-selection').disabled = recording;
  $('open-play-video').disabled = recording;
  $('open-play-track').disabled = recording;
  $('open-stop').disabled = !recording && !playing && !OpenRec.playSource;
  $('open-record').classList.toggle('recording', recording);
  $('open-record').innerHTML = recording ? '<i class="fa-solid fa-circle"></i> Recording…' : '<i class="fa-solid fa-circle"></i> Record from cursor';
  $('open-play-video').innerHTML = playing && !OpenRec.playSource ? '<i class="fa-solid fa-pause"></i> Pause video' : '<i class="fa-solid fa-play"></i> Play video';
  $('open-undo').disabled = !OpenRec.history.length;
}

function ensureOpenBuffer() {
  const state = State.project.openRecording || (State.project.openRecording = createOpenRecordingState(State.project.duration));
  if (!state.buffer) state.buffer = Recorder.createOpenTrack(State.project.duration);
  return state;
}

async function startOpenRecording(selectionOnly) {
  if (OpenRec.recording || State.recording) return;
  readOpenSelectionInputs();
  if (selectionOnly) {
    const [a, b] = normalizedOpenSelection();
    if (b - a < 0.05) { toast('Select the part you want to re-record first.', 'warn'); return; }
    OpenRec.cursor = a; OpenRec.replaceEnd = b;
  } else OpenRec.replaceEnd = null;
  const go = await runCountdown(3, selectionOnly ? 'RE-RECORD SELECTION…' : 'OPEN RECORDING…');
  if (!go) return;
  try {
    await Recorder.ensureMic();
    stopOpenPlayback();
    const video = $('open-rec-video');
    video.currentTime = OpenRec.cursor;
    OpenRec.recordStart = OpenRec.cursor;
    video.muted = true;
    const pseudoSegment = { id: 'open-recording', targetDuration: Math.max(0.1, (OpenRec.replaceEnd || State.project.duration) - OpenRec.cursor) };
    OpenRec.recording = true;
    OpenRec.stopping = false;
    State.recording = true;
    updateOpenTransport();
    $('open-rec-status').className = 'settings-status err';
    $('open-rec-status').textContent = `● Recording from ${Parsers.secondsToClock(OpenRec.cursor)} — press Stop at any time.`;
    await Recorder.start(pseudoSegment, {
      onTick: elapsed => {
        const end = OpenRec.replaceEnd || State.project.duration;
        if (OpenRec.recordStart + elapsed >= end && !OpenRec.stopping) stopOpenRecording();
      }
    });
    await video.play();
  } catch (e) {
    if (Recorder.isRecording()) {
      try { await Recorder.stop({ id: 'open-recording', targetDuration: 1 }, { safetyTailMs: 0 }); } catch (_) {}
    }
    OpenRec.recording = false; State.recording = false; updateOpenTransport();
    toast(e.message, 'error', 6500);
  }
}

async function stopOpenRecording() {
  if (!OpenRec.recording || OpenRec.stopping) return;
  OpenRec.stopping = true;
  const video = $('open-rec-video');
  video.pause();
  const insertAt = OpenRec.recordStart;
  try {
    const pseudoSegment = { id: 'open-recording', targetDuration: Math.max(0.1, State.project.duration - insertAt) };
    const take = await Recorder.stop(pseudoSegment, { safetyTailMs: 0 });
    const state = ensureOpenBuffer();
    pushOpenHistory();
    let base = state.buffer;
    if (OpenRec.replaceEnd != null) base = Recorder.silenceTrackRange(base, insertAt, OpenRec.replaceEnd);
    const maxDuration = (OpenRec.replaceEnd || State.project.duration) - insertAt;
    state.buffer = Recorder.overwriteTrack(base, take.buffer, insertAt, 0, Math.min(take.buffer.duration, maxDuration));
    state.hasAudio = true;
    state.edits.push({ type: OpenRec.replaceEnd != null ? 'rerecord' : 'record', at: insertAt, end: +(insertAt + Math.min(take.buffer.duration, maxDuration)).toFixed(3), createdAt: Date.now() });
    OpenRec.cursor = Math.min(State.project.duration, insertAt + Math.min(take.buffer.duration, maxDuration));
    video.currentTime = OpenRec.cursor;
    $('open-rec-status').className = 'settings-status ok';
    $('open-rec-status').textContent = `✓ Audio saved on the full-clip track. Continue from ${Parsers.secondsToClock(OpenRec.cursor)} or select any part to edit.`;
  } catch (e) {
    toast('Open recording failed: ' + e.message, 'error', 6500);
  } finally {
    OpenRec.recording = false; OpenRec.stopping = false; OpenRec.replaceEnd = null; State.recording = false;
    updateOpenRecordingUI();
  }
}

function pushOpenHistory() {
  const state = ensureOpenBuffer();
  OpenRec.history.push({ buffer: Recorder.cloneBuffer(state.buffer), hasAudio: state.hasAudio, edits: [...state.edits] });
  if (OpenRec.history.length > 8) OpenRec.history.shift();
}

function undoOpenEdit() {
  const prev = OpenRec.history.pop();
  if (!prev) return;
  const state = ensureOpenBuffer();
  state.buffer = prev.buffer; state.hasAudio = prev.hasAudio; state.edits = prev.edits;
  $('open-rec-status').className = 'settings-status ok';
  $('open-rec-status').textContent = '✓ Last open-track edit was undone.';
  updateOpenRecordingUI();
}

function normalizedOpenSelection() {
  return [Math.min(...OpenRec.selection), Math.max(...OpenRec.selection)];
}
function setOpenSelection(a, b) {
  const d = State.project.duration;
  OpenRec.selection = [Math.max(0, Math.min(d, +a || 0)), Math.max(0, Math.min(d, +b || 0))];
  $('open-sel-start').value = OpenRec.selection[0].toFixed(2);
  $('open-sel-end').value = OpenRec.selection[1].toFixed(2);
  drawOpenWaveform();
}
function readOpenSelectionInputs() { setOpenSelection(+$('open-sel-start').value, +$('open-sel-end').value); }

function deleteOpenSelection() {
  try {
    const state = ensureOpenBuffer(), [a, b] = normalizedOpenSelection();
    if (b - a < 0.01) throw new Error('Select an audio range before deleting.');
    pushOpenHistory();
    state.buffer = Recorder.silenceTrackRange(state.buffer, a, b);
    state.edits.push({ type: 'delete', at: a, end: b, createdAt: Date.now() });
    OpenRec.cursor = a; $('open-rec-video').currentTime = a;
    $('open-rec-status').className = 'settings-status ok';
    $('open-rec-status').textContent = `✓ Deleted audio from ${Parsers.secondsToClock(a)} to ${Parsers.secondsToClock(b)}. The video timing did not move.`;
    updateOpenRecordingUI();
  } catch (e) { toast(e.message, 'warn'); }
}
function clearOpenTrack() {
  const state = ensureOpenBuffer();
  if (state.hasAudio && !confirm('Clear the entire open recording track? You can undo this once.')) return;
  pushOpenHistory();
  state.buffer = Recorder.createOpenTrack(State.project.duration, state.buffer.sampleRate);
  state.hasAudio = false; state.edits.push({ type: 'clear', createdAt: Date.now() });
  updateOpenRecordingUI();
}

function playOpenTrack() {
  const state = ensureOpenBuffer();
  if (!state.hasAudio) { toast('The open recording track is empty. Record from the cursor first.', 'warn'); return; }
  stopOpenPlayback();
  const ac = AudioEngine.getCtx();
  const video = $('open-rec-video');
  const src = ac.createBufferSource();
  src.buffer = state.buffer; src.connect(ac.destination);
  OpenRec.playSource = src;
  video.currentTime = OpenRec.cursor; video.muted = true;
  src.start(0, OpenRec.cursor);
  src.onended = stopOpenPlayback;
  video.play().catch(() => {});
  updateOpenTransport();
}
function stopOpenPlayback() {
  if (OpenRec.playSource) { try { OpenRec.playSource.onended = null; OpenRec.playSource.stop(); } catch (e) {} OpenRec.playSource = null; }
  const video = $('open-rec-video');
  if (video && !video.paused) video.pause();
  updateOpenTransport();
}

function bindOpenWaveSelection() {
  const canvas = $('open-wave-canvas');
  const timeAt = e => {
    const r = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(State.project.duration, ((e.clientX - r.left) / r.width) * State.project.duration));
  };
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); OpenRec.dragStart = timeAt(e); setOpenSelection(OpenRec.dragStart, OpenRec.dragStart); });
  canvas.addEventListener('pointermove', e => { if (OpenRec.dragStart != null) setOpenSelection(OpenRec.dragStart, timeAt(e)); });
  canvas.addEventListener('pointerup', e => {
    const t = timeAt(e), moved = Math.abs(t - OpenRec.dragStart);
    if (moved < 0.05) setOpenCursor(t); else setOpenSelection(OpenRec.dragStart, t);
    OpenRec.dragStart = null;
  });
}

function drawOpenWaveform() {
  if (!State.project || !$('modal-open-recording') || $('modal-open-recording').style.display === 'none') return;
  const canvas = $('open-wave-canvas'), rect = canvas.getBoundingClientRect();
  const w = Math.max(300, Math.floor(rect.width * devicePixelRatio)), h = Math.floor(120 * devicePixelRatio);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d'); g.clearRect(0, 0, w, h); g.fillStyle = '#0f1012'; g.fillRect(0, 0, w, h);
  const state = State.project.openRecording;
  if (state && state.buffer && state.hasAudio) {
    const data = state.buffer.getChannelData(0), step = Math.max(1, Math.floor(data.length / w));
    g.strokeStyle = '#4f8cff'; g.lineWidth = Math.max(1, devicePixelRatio); g.beginPath();
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      for (let i = x * step; i < Math.min(data.length, (x + 1) * step); i++) { min = Math.min(min, data[i]); max = Math.max(max, data[i]); }
      g.moveTo(x, h / 2 + min * h * .44); g.lineTo(x, h / 2 + max * h * .44);
    }
    g.stroke();
  }
  const [a, b] = normalizedOpenSelection(), duration = State.project.duration;
  if (b > a) { g.fillStyle = 'rgba(255,176,46,.22)'; g.fillRect(a / duration * w, 0, (b - a) / duration * w, h); }
  const cursor = (($('open-rec-video').currentTime || OpenRec.cursor) / duration) * w;
  g.strokeStyle = '#ff4d4d'; g.lineWidth = 2 * devicePixelRatio; g.beginPath(); g.moveTo(cursor, 0); g.lineTo(cursor, h); g.stroke();
}

/* ═══════════════ SETTINGS ═══════════════ */

function openModal(id) { $(id).style.display = 'flex'; }
function closeModal(id) {
  if (id === 'modal-open-recording') {
    if (OpenRec.recording) { toast('Stop the open recording before closing the editor.', 'warn'); return; }
    stopOpenPlayback();
  }
  $(id).style.display = 'none';
}

function initSettings() {
  $('btn-settings').addEventListener('click', () => { populateSettings(); openModal('modal-settings'); });
  document.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  document.querySelectorAll('.modal-backdrop').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); }));

  $('toggle-key-visibility').addEventListener('click', () => {
    const inp = $('setting-api-key');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('btn-add-model').addEventListener('click', () => {
    const v = $('custom-model-input').value.trim();
    if (!v) { toast('Enter a model name first.', 'warn'); return; }
    Gemini.addCustomModel(v);
    $('custom-model-input').value = '';
    populateModelSelect(v);
    toast(`Custom model "${v}" added.`, 'ok');
  });
  $('btn-save-settings').addEventListener('click', () => {
    Gemini.setKey($('setting-api-key').value);
    Gemini.setModel($('setting-model').value);
    localStorage.setItem('dubstudio.aiMatching', $('setting-ai-matching').checked ? 'on' : 'off');
    State.autoEnhance = $('setting-auto-enhance').checked;
    localStorage.setItem('dubstudio.autoEnhance', State.autoEnhance ? 'on' : 'off');
    localStorage.setItem('dubstudio.aiEnhanceGemini', $('setting-enhance-gemini').checked ? 'on' : 'off');
    const st = $('settings-status');
    st.className = 'settings-status ok';
    st.textContent = '✓ Settings saved' + (Gemini.isConfigured() ? ` — model: ${Gemini.getModel()}` : ' (no API key set — AI text features disabled)');
  });
  $('btn-test-api').addEventListener('click', async () => {
    Gemini.setKey($('setting-api-key').value);
    Gemini.setModel($('setting-model').value);
    const st = $('settings-status');
    st.className = 'settings-status'; st.textContent = 'Testing connection…';
    try {
      await Gemini.testConnection();
      st.className = 'settings-status ok';
      st.textContent = `✓ Connected — ${Gemini.getModel()} responded.`;
    } catch (e) {
      st.className = 'settings-status err';
      st.textContent = '✕ ' + e.message;
    }
  });
}

function populateSettings() {
  $('setting-api-key').value = Gemini.getKey();
  $('setting-ai-matching').checked = localStorage.getItem('dubstudio.aiMatching') !== 'off';
  $('setting-auto-enhance').checked = State.autoEnhance;
  $('setting-enhance-gemini').checked = localStorage.getItem('dubstudio.aiEnhanceGemini') !== 'off';
  populateModelSelect(Gemini.getModel());
  $('settings-status').textContent = '';
}

function populateModelSelect(selected) {
  const sel = $('setting-model');
  sel.innerHTML = '';
  for (const m of Gemini.allModels()) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + (m === 'gemini-3.6-flash' ? '  (recommended)' : '');
    if (m === selected) o.selected = true;
    sel.appendChild(o);
  }
}

/* ═══════════════ USER MODE ═══════════════ */

function initUserMode() {
  $('btn-user-mode').addEventListener('click', () => { populateUserModal(); openModal('modal-users'); });
  document.querySelectorAll('input[name="user-mode"]').forEach(r =>
    r.addEventListener('change', () => $('multi-user-config').style.display = r.value === 'multi' && r.checked ? 'block' : 'none'));
  $('btn-save-users').addEventListener('click', () => {
    const mode = document.querySelector('input[name="user-mode"]:checked').value;
    State.userMode = mode;
    if (mode === 'multi') {
      State.assignments = {};
      document.querySelectorAll('.user-assign-row input').forEach(inp => {
        if (inp.value.trim()) State.assignments[inp.dataset.char] = inp.value.trim();
      });
      State.activeUser = $('active-user-select').value || null;
      State.ownerView = $('owner-view').checked;
    } else { State.assignments = {}; State.activeUser = null; State.ownerView = false; }
    $('user-mode-label').textContent = mode === 'multi'
      ? (State.ownerView ? 'Owner View' : 'User: ' + (State.activeUser || '—')) : 'Single User';
    $('btn-user-mode').querySelector('i').className = mode === 'multi' ? 'fa-solid fa-users' : 'fa-solid fa-user';
    State.filterCharacter = null;
    Timeline.setFilter(null);
    renderCharacters(); renderQueue(); renderProgress();
    const first = visibleSegments()[0];
    if (first) selectSegment(first.id);
    else toast('No characters are assigned to the active user.', 'warn');
    closeModal('modal-users');
  });
}

function populateUserModal() {
  document.querySelector(`input[name="user-mode"][value="${State.userMode}"]`).checked = true;
  $('multi-user-config').style.display = State.userMode === 'multi' ? 'block' : 'none';
  const wrap = $('user-assignments');
  wrap.innerHTML = '';
  for (const c of State.project.characters) {
    const row = document.createElement('div');
    row.className = 'user-assign-row';
    row.innerHTML = `<span class="ua-char"></span><input type="text" placeholder="user name">`;
    row.querySelector('.ua-char').textContent = c.name;
    const inp = row.querySelector('input');
    inp.dataset.char = c.name;
    inp.value = State.assignments[c.name] || '';
    inp.addEventListener('input', refreshActiveUserOptions);
    wrap.appendChild(row);
  }
  $('owner-view').checked = State.ownerView;
  refreshActiveUserOptions();
}

function refreshActiveUserOptions() {
  const users = new Set();
  document.querySelectorAll('.user-assign-row input').forEach(i => { if (i.value.trim()) users.add(i.value.trim()); });
  const sel = $('active-user-select');
  const prev = State.activeUser;
  sel.innerHTML = '';
  for (const u of users) {
    const o = document.createElement('option');
    o.value = u; o.textContent = u;
    if (u === prev) o.selected = true;
    sel.appendChild(o);
  }
}

/* ═══════════════ EXPORT ═══════════════ */

let exportFormat = 'mp3';

function initExport() {
  $('btn-export').addEventListener('click', () => openModal('modal-export'));
  $('export-voice-source').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    State.exportVoiceSource = b.dataset.source;
    document.querySelectorAll('#export-voice-source button').forEach(x => x.classList.toggle('active', x === b));
  });
  $('export-format').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    exportFormat = b.dataset.fmt;
    document.querySelectorAll('#export-format button').forEach(x => x.classList.toggle('active', x === b));
    $('export-fmt-hint').textContent = exportFormat === 'mp3'
      ? 'MP3 · 44.1kHz stereo · mixed from accepted takes at exact segment positions.'
      : 'Captures the original video with the selected mix. Uses H.264 MP4 when the browser supports it, otherwise WebM (convert or import assets directly in Premiere). Original resolution & frame rate.';
  });
  $('btn-do-export').addEventListener('click', doExport);
}

async function doExport() {
  const mix = document.querySelector('input[name="export-mix"]:checked').value;
  const seg = State.project.segments;
  const btn = $('btn-do-export');
  const prog = $('export-progress'), fill = $('export-progress-fill'), txt = $('export-progress-text');
  const status = $('export-status');
  status.textContent = ''; status.className = 'settings-status';
  prog.style.display = 'flex'; btn.disabled = true;
  const setP = (p, label) => { fill.style.width = Math.round(p * 100) + '%'; txt.textContent = label || Math.round(p * 100) + '%'; };

  try {
    setP(0.02, 'Rendering mix…');
    const dur = Math.min(State.project.duration, (AudioEngine.getOriginalBuffer()?.duration) || State.project.duration);
    // AI auto-mix level for the music bed (no manual volume control)
    const musicVol = AudioEngine.getAutoMusicGain();
    const openState = State.project.openRecording;
    if (State.exportVoiceSource === 'open' && mix !== 'music' && (!openState || !openState.hasAudio || !openState.buffer)) {
      throw new Error('The open recording track is empty. Open the full-clip recorder and record audio first.');
    }
    const openBuffer = State.exportVoiceSource === 'open' ? openState.buffer : null;
    const buffer = await Exporter.renderMix(seg, mix, dur, musicVol, openBuffer);
    const base = State.project.name.replace(/[^\w\u0600-\u06FF-]+/g, '_');
    const mixName = { full: 'full-dub', dub: 'dubbing-only', music: 'music-only' }[mix];

    if (exportFormat === 'mp3') {
      setP(0.3, 'Encoding MP3…');
      const blob = Exporter.encodeMP3(buffer, p => setP(0.3 + p * 0.65, 'Encoding MP3…'));
      Exporter.download(blob, `${base}-${mixName}.mp3`);
      setP(1, 'Done');
      status.className = 'settings-status ok';
      status.textContent = `✓ Exported ${mixName}.mp3`;
    } else {
      setP(0.1, 'Capturing video (plays through once)…');
      const res = await Exporter.exportVideo($('video-player'), buffer, p => setP(0.1 + p * 0.85, 'Capturing video…'));
      Exporter.download(res.blob, `${base}-${mixName}.${res.ext}`);
      setP(1, 'Done');
      status.className = 'settings-status ok';
      status.textContent = res.isMp4
        ? '✓ Exported H.264 MP4 — ready for Premiere.'
        : '✓ Exported WebM (this browser cannot encode H.264). For Premiere, export the MP3 stems and the original video, or convert the WebM.';
    }
  } catch (e) {
    console.error(e);
    status.className = 'settings-status err';
    status.textContent = '✕ Export failed: ' + e.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => { prog.style.display = 'none'; }, 1500);
  }
}

/* ═══════════════ MISC UI ═══════════════ */

function initMisc() {
  $('text-size').addEventListener('input', e => {
    $('ds-text').style.fontSize = e.target.value + 'px';
    $('text-size-val').textContent = e.target.value + 'px';
    updateFocusView();
  });
  $('btn-focus-mode').addEventListener('click', toggleFocusMode);
  $('focus-exit').addEventListener('click', toggleFocusMode);
  $('btn-preview-all').addEventListener('click', toggleFullPreview);
}

/* ═══════════════ SAVE / OPEN PROJECT (.dubproj.zip) ═══════════════ */

function initProjectStore() {
  const saveBtn = $('btn-save-project');
  const openBtn = $('btn-open-project');
  const fileInp = $('file-open-project');

  saveBtn.addEventListener('click', async () => {
    if (!State.project) return;
    if (State.recording) { toast('Stop the current recording first.', 'warn'); return; }
    const original = saveBtn.innerHTML;
    saveBtn.disabled = true;
    try {
      const { blob, filename } = await ProjectStore.save(State, {
        onProgress: (v, label) => {
          saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label || Math.round(v * 100) + '%'}`;
        }
      });
      Exporter.download(blob, filename);
      const mb = (blob.size / 1048576).toFixed(1);
      toast(`✓ Project saved — ${filename} (${mb} MB). Share this file with your team; opening it restores everything.`, 'ok', 8000);
    } catch (e) {
      console.error(e);
      toast('Saving the project failed: ' + e.message, 'error', 8000);
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = original;
    }
  });

  openBtn.addEventListener('click', () => {
    if (State.recording) { toast('Stop the current recording first.', 'warn'); return; }
    if (State.project && !confirm('Opening a project bundle will replace the current project. Unsaved work will be lost — continue?')) return;
    fileInp.value = '';
    fileInp.click();
  });

  fileInp.addEventListener('change', async () => {
    const f = fileInp.files && fileInp.files[0];
    if (!f) return;
    try {
      await openProjectBundle(f);
    } catch (e) {
      console.error(e);
      $('processing-screen').style.display = 'none';
      if ($('setup-screen').style.display !== 'none') {
        $('setup-error').style.display = 'block';
        $('setup-error').textContent = '⚠ ' + e.message;
      }
      toast('Opening the project failed: ' + e.message, 'error', 9000);
    }
  });
}

/* Full state restore: reload video, re-separate stems, re-decode every
   take blob, re-run the fixed DSP chain, and bring back all statuses,
   accepted takes and AI suggestions from the manifest. */
async function openProjectBundle(file) {
  stopFullPreview(false);
  AudioEngine.stopOriginalVoice();

  // reset + show the pipeline overlay (reused from project creation)
  document.querySelectorAll('#pipeline-steps li').forEach(li => {
    li.classList.remove('active', 'done');
    li.querySelector('i').className = 'fa-regular fa-circle';
  });
  $('processing-screen').style.display = 'flex';
  const note = t => { $('pipeline-note').textContent = t; };

  /* 1 — read the archive */
  pipelineStep('load', 'active');
  note('Reading project bundle…');
  const { manifest, videoFile, takeBlobs } = await ProjectStore.open(file, {
    onProgress: (v, label) => note(label || `Reading… ${Math.round(v * 100)}%`)
  });

  /* 2 — reload the bundled video + decode its audio */
  const videoURL = URL.createObjectURL(videoFile);
  const video = $('video-player');
  video.src = videoURL;
  const duration = await new Promise((res, rej) => {
    video.onloadedmetadata = () => res(video.duration);
    video.onerror = () => rej(new Error('The bundled video could not be loaded in this browser.'));
    setTimeout(() => rej(new Error('Timed out loading the bundled video.')), 30000);
  });
  note('Decoding audio track…');
  await AudioEngine.extractAudioFromVideo(videoFile);
  pipelineStep('load', 'done');

  /* 3 — re-separate stems locally (buffers are never stored in the bundle) */
  pipelineStep('separate', 'active');
  await AudioEngine.separateStems(AudioEngine.getOriginalBuffer(), p => note(`Separating stems… ${Math.round(p * 100)}%`));
  pipelineStep('separate', 'done');
  pipelineStep('srt', 'done');
  pipelineStep('script', 'done');
  pipelineStep('match', 'done');
  pipelineStep('vad', 'done');

  /* 4 — rebuild segments & takes from the manifest */
  pipelineStep('timeline', 'active');
  const ac = AudioEngine.getCtx();
  const totalTakes = manifest.segments.reduce((n, s) => n + s.takes.length, 0);
  let doneTakes = 0, failedTakes = 0;

  const segments = [];
  for (const sm of manifest.segments) {
    const seg = {
      id: sm.id, lineNumber: sm.lineNumber, character: sm.character,
      text: sm.text, activeText: sm.activeText,
      startTime: sm.startTime, endTime: sm.endTime, targetDuration: sm.targetDuration,
      originalSpeechStart: sm.originalSpeechStart, originalSpeechEnd: sm.originalSpeechEnd,
      speechAnalysis: sm.speechAnalysis || null, srtTimingOk: sm.srtTimingOk,
      status: sm.status, matchScore: sm.matchScore,
      needsCharacterReview: sm.needsCharacterReview,
      acceptedTakeId: sm.acceptedTakeId || null, aiBestTakeId: sm.aiBestTakeId || null,
      aiSuggestions: sm.aiSuggestions || [],
      sourceLineNumbers: sm.sourceLineNumbers || [sm.lineNumber],
      sourceSegmentIds: sm.sourceSegmentIds || [sm.id],
      takes: []
    };

    for (const tm of sm.takes) {
      doneTakes++;
      note(`Restoring takes… ${doneTakes}/${totalTakes}`);
      const blob = takeBlobs.get(tm.id);
      if (!blob) { failedTakes++; continue; }
      let rawBuf;
      try { rawBuf = await ac.decodeAudioData(await blob.arrayBuffer()); }
      catch (e) { console.warn('Take decode failed:', tm.id, e); failedTakes++; continue; }

      // re-run the fixed DSP chain when it was applied at record time
      let buf = rawBuf, dspApplied = false;
      if (tm.dspApplied && window.DspChain) {
        try { buf = await DspChain.process(rawBuf); dspApplied = true; }
        catch (e) { console.warn('DSP re-apply failed — using raw capture:', e); }
      }

      seg.takes.push({
        id: tm.id, segmentId: tm.segmentId,
        blob, buffer: buf, rawBuffer: rawBuf,
        dspApplied, dspChain: dspApplied ? DspChain.describe() : [],
        rawDuration: tm.rawDuration, duration: tm.duration,
        trimStart: tm.trimStart, trimEnd: tm.trimEnd,
        analysis: tm.analysis, status: tm.status,
        aiScore: tm.aiScore || null,
        // enhanced/fitted buffers are not serializable → flags reset;
        // re-run AI Auto Enhance / Fit after opening if needed.
        enhanced: false, fitted: false,
        createdAt: tm.createdAt
      });
      await new Promise(r => setTimeout(r, 0));
    }

    // an accepted take must physically exist after restore
    if (seg.acceptedTakeId && !seg.takes.some(t => t.id === seg.acceptedTakeId)) {
      seg.acceptedTakeId = null;
      seg.status = seg.takes.length ? 'needs_review' : 'empty';
    }
    segments.push(seg);
  }

  resetOpenRecordingSession();
  State.project = {
    name: manifest.name, videoURL, videoFile, duration,
    segments, characters: buildCharacterIndex(segments),
    srtErrors: manifest.srtErrors || [], scriptErrors: manifest.scriptErrors || [],
    openRecording: createOpenRecordingState(duration)
  };
  if (manifest.openRecording && manifest.openRecording.hasAudio && takeBlobs.has('__open_recording__')) {
    try {
      State.project.openRecording.buffer = await ac.decodeAudioData(await takeBlobs.get('__open_recording__').arrayBuffer());
      State.project.openRecording.hasAudio = true;
      State.project.openRecording.edits = manifest.openRecording.edits || [];
    } catch (e) { console.warn('Open recording track could not be restored:', e); }
  }
  State.userMode = manifest.userMode || 'single';
  State.assignments = manifest.assignments || {};
  State.activeUser = manifest.activeUser || null;
  State.ownerView = !!manifest.ownerView;
  State.filterCharacter = null;
  State.currentSegmentId = null;
  pipelineStep('timeline', 'done');

  setTimeout(() => {
    $('processing-screen').style.display = 'none';
    enterWorkspace();
    $('user-mode-label').textContent = State.userMode === 'multi'
      ? (State.ownerView ? 'Owner View' : 'User: ' + (State.activeUser || '—')) : 'Single User';
    $('btn-user-mode').querySelector('i').className = State.userMode === 'multi' ? 'fa-solid fa-users' : 'fa-solid fa-user';
    const accepted = segments.filter(s => s.acceptedTakeId).length;
    toast(`✓ Project "${manifest.name}" restored — ${segments.length} segments, ${totalTakes - failedTakes} take(s), ${accepted} accepted. AI-enhanced/fitted versions can be regenerated per take.`, 'ok', 9000);
    if (failedTakes) toast(`${failedTakes} take(s) could not be restored from the bundle.`, 'warn', 8000);
  }, 350);
}

/* ═══════════════ BOOT ═══════════════ */

document.addEventListener('DOMContentLoaded', () => {
  bindDrop('drop-video', 'file-video', 'video-file-name', 'video',
    f => /\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name) || f.type.startsWith('video/'));
  bindDrop('drop-srt', 'file-srt', 'srt-file-name', 'srt',
    f => /\.srt$/i.test(f.name) || f.type === 'text/plain');
  bindDrop('drop-script', 'file-script', 'script-file-name', 'script',
    f => /\.(txt|text)$/i.test(f.name) || f.type === 'text/plain');
  $('btn-create-project').addEventListener('click', createProject);

  initVideo();
  initReferenceControls();
  initTransport();
  initMergeControls();
  initOpenRecording();
  initSettings();
  initUserMode();
  initExport();
  initMisc();
  initProjectStore();
});
