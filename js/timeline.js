/* ═══════════════════════════════════════════════════════════════
   timeline.js — THE Dubbing Timeline (the only visible timeline)
   - Rendered from pre-built dubbing segments (one per dialogue line)
   - Segment width ∝ duration; gaps between lines stay visible
   - Status colours, current-segment highlight, character filter dim
   - Accepted takes draw a real waveform inside their exact segment
   - Playhead follows the video clock
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Timeline = (() => {
  let container, ruler, track, playhead;
  let pxPerSec = 60;
  let totalDuration = 0;
  let segments = [];
  let currentId = null;
  let filterCharacter = null;
  let onSelect = null;

  function init(opts) {
    container = document.getElementById('timeline-scroll');
    ruler = document.getElementById('timeline-ruler');
    track = document.getElementById('timeline-track');
    playhead = document.getElementById('timeline-playhead');
    onSelect = opts.onSelect;

    document.getElementById('timeline-zoom').addEventListener('input', e => {
      pxPerSec = +e.target.value;
      render();
    });
    // click empty track → nothing; click segment handled per-element
  }

  function setData(segs, duration) {
    segments = segs;
    totalDuration = Math.max(duration || 0, segs.length ? segs[segs.length - 1].endTime + 2 : 10);
    render();
  }

  function setCurrent(id) { currentId = id; render(); scrollToCurrent(); }
  function setFilter(character) { filterCharacter = character; render(); }

  function render() {
    if (!track) return;
    const width = Math.max(container.clientWidth - 20, totalDuration * pxPerSec);
    track.style.width = width + 'px';
    ruler.style.width = width + 'px';

    // ruler ticks
    ruler.innerHTML = '';
    const step = pxPerSec >= 120 ? 1 : pxPerSec >= 50 ? 5 : pxPerSec >= 25 ? 10 : 30;
    for (let t = 0; t <= totalDuration; t += step) {
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = (t * pxPerSec) + 'px';
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      tick.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      ruler.appendChild(tick);
    }

    // segments
    track.querySelectorAll('.tl-seg').forEach(el => el.remove());
    for (const seg of segments) {
      const el = document.createElement('div');
      el.className = 'tl-seg status-' + seg.status;
      if (seg.id === currentId) el.classList.add('current');
      if (filterCharacter && seg.character !== filterCharacter) el.classList.add('dimmed');
      el.style.left = (seg.startTime * pxPerSec) + 'px';
      el.style.width = Math.max(14, (seg.endTime - seg.startTime) * pxPerSec - 2) + 'px';
      el.title = `#${String(seg.lineNumber).padStart(3,'0')} ${seg.character} — ${seg.activeText}\n` +
                 `${Parsers.secondsToClock(seg.startTime)} → ${Parsers.secondsToClock(seg.endTime)}  (${seg.targetDuration.toFixed(2)}s)\n` +
                 `Status: ${statusLabel(seg.status)}`;
      el.dataset.segId = seg.id;

      // waveform of the accepted take fills the segment
      if (seg.acceptedTakeId) {
        const take = seg.takes.find(t => t.id === seg.acceptedTakeId);
        if (take) {
          const canvas = document.createElement('canvas');
          el.appendChild(canvas);
          requestAnimationFrame(() => drawWave(canvas, take, '#3ecf8e'));
        }
      }

      const label = document.createElement('div');
      label.className = 'tl-label';
      label.textContent = `${String(seg.lineNumber).padStart(3,'0')} ${statusIcon(seg.status)} ${seg.character}`;
      const dur = document.createElement('div');
      dur.className = 'tl-dur';
      dur.textContent = seg.targetDuration.toFixed(2) + 's';
      el.appendChild(label); el.appendChild(dur);

      el.addEventListener('click', () => { if (onSelect) onSelect(seg.id); });
      track.appendChild(el);
    }
  }

  function drawWave(canvas, take, color) {
    // fitted > AI-enhanced > raw
    const useAlt = (take.fitted && take.fittedBuffer) || (take.enhanced && take.enhancedBuffer);
    const buf = take.fitted && take.fittedBuffer ? take.fittedBuffer
              : take.enhanced && take.enhancedBuffer ? take.enhancedBuffer
              : take.buffer;
    if (!buf || !canvas.isConnected) return;
    const w = canvas.clientWidth || 40, h = canvas.clientHeight || 40;
    canvas.width = w * 2; canvas.height = h * 2;
    const g = canvas.getContext('2d');
    g.scale(2, 2);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = color; g.globalAlpha = 0.55; g.lineWidth = 1;
    const data = buf.getChannelData(0);
    const from = useAlt ? 0 : Math.floor(take.trimStart * buf.sampleRate);
    const to = useAlt ? data.length : Math.floor(take.trimEnd * buf.sampleRate);
    const n = Math.max(1, to - from);
    const stepN = Math.max(1, Math.floor(n / w));
    g.beginPath();
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      const s0 = from + x * stepN, s1 = Math.min(to, s0 + stepN);
      for (let i = s0; i < s1; i++) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
      const mid = h / 2;
      g.moveTo(x, mid + min * mid * 0.9);
      g.lineTo(x, mid + max * mid * 0.9);
    }
    g.stroke();
  }

  function statusIcon(st) {
    return { accepted: '✓', recording: '●', processing: '…', needs_review: '?', timing_mismatch: '⚠', retake: '↻', empty: '○' }[st] || '○';
  }
  function statusLabel(st) {
    return { accepted: 'ACCEPTED', recording: 'RECORDING', processing: 'PROCESSING', needs_review: 'NEEDS REVIEW',
             timing_mismatch: 'TIMING MISMATCH', retake: 'RETAKE', empty: 'EMPTY' }[st] || st.toUpperCase();
  }

  function updatePlayhead(timeSec) {
    if (playhead) playhead.style.left = (timeSec * pxPerSec) + 'px';
  }

  function scrollToCurrent() {
    const seg = segments.find(s => s.id === currentId);
    if (!seg || !container) return;
    const x = seg.startTime * pxPerSec;
    const view = container.clientWidth;
    if (x < container.scrollLeft + 40 || x > container.scrollLeft + view - 120) {
      container.scrollTo({ left: Math.max(0, x - view * 0.3), behavior: 'smooth' });
    }
  }

  return { init, setData, setCurrent, setFilter, render, updatePlayhead, statusLabel, statusIcon, drawWave };
})();
