/* ═══════════════════════════════════════════════════════════════
   project-store.js — Save / Open project bundles for collaboration
   A saved project is ONE compressed archive (.dubproj.zip) that
   packages ALL physical media assets with the project data:

     project.json            — full project state: segments, takes
                               metadata, characters, users, statuses
     media/video.<ext>       — the ORIGINAL uploaded video file
     takes/<takeId>.webm     — every recorded take (original capture blob)
     script/source.txt       — reconstructed character/dialogue script
     subtitles/source.srt    — reconstructed SRT (authoritative timing)

   Opening a bundle restores everything: the video is reloaded, stems
   are re-separated locally, take blobs are re-decoded and re-run
   through the DSP chain state stored in metadata, and all statuses,
   accepted takes and AI suggestions come back — so a teammate can
   continue working seamlessly.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const ProjectStore = (() => {

  const FORMAT_VERSION = 1;

  /* ── SAVE ──────────────────────────────────────────── */

  async function save(state, { onProgress } = {}) {
    if (typeof JSZip === 'undefined') throw new Error('The archive library (JSZip) failed to load — check your connection.');
    const p = state.project;
    if (!p) throw new Error('No project to save.');
    const zip = new JSZip();
    const prog = (v, l) => { if (onProgress) onProgress(v, l); };

    prog(0.05, 'Collecting project data…');

    // serializable segment/take metadata (buffers stay out; blobs go to files)
    const segments = p.segments.map(s => ({
      id: s.id, lineNumber: s.lineNumber, character: s.character,
      text: s.text, activeText: s.activeText,
      startTime: s.startTime, endTime: s.endTime, targetDuration: s.targetDuration,
      originalSpeechStart: s.originalSpeechStart, originalSpeechEnd: s.originalSpeechEnd,
      speechAnalysis: s.speechAnalysis || null, srtTimingOk: s.srtTimingOk,
      status: s.status === 'recording' || s.status === 'processing' ? 'needs_review' : s.status,
      matchScore: s.matchScore, needsCharacterReview: s.needsCharacterReview,
      acceptedTakeId: s.acceptedTakeId, aiBestTakeId: s.aiBestTakeId || null,
      aiSuggestions: s.aiSuggestions,
      takes: s.takes.map(t => ({
        id: t.id, segmentId: t.segmentId,
        rawDuration: t.rawDuration, duration: t.duration,
        trimStart: t.trimStart, trimEnd: t.trimEnd,
        analysis: t.analysis, status: t.status,
        dspApplied: !!t.dspApplied, dspChain: t.dspChain || [],
        enhanced: !!t.enhanced, enhanceReport: t.enhanceReport || [],
        enhanceGemini: !!t.enhanceGemini,
        fitted: !!t.fitted, fittedDuration: t.fittedDuration || null,
        aiScore: t.aiScore || null,
        createdAt: t.createdAt,
        file: 'takes/' + t.id + guessExt(t.blob)
      }))
    }));

    const manifest = {
      format: 'dubproj', version: FORMAT_VERSION,
      savedAt: Date.now(),
      name: p.name, duration: p.duration,
      videoFile: 'media/video' + guessExt(p.videoFile, p.videoFile && p.videoFile.name),
      videoName: p.videoFile ? p.videoFile.name : 'video.mp4',
      characters: p.characters,
      userMode: state.userMode, assignments: state.assignments,
      activeUser: state.activeUser, ownerView: state.ownerView,
      srtErrors: p.srtErrors || [], scriptErrors: p.scriptErrors || [],
      segments
    };
    zip.file('project.json', JSON.stringify(manifest, null, 1));

    // reconstructed source files (useful outside the app too)
    zip.file('subtitles/source.srt', buildSrt(p.segments));
    zip.file('script/source.txt', buildScript(p.segments));

    prog(0.15, 'Packing video…');
    if (!p.videoFile) throw new Error('The original video file is not available in memory — cannot bundle it.');
    zip.file(manifest.videoFile, p.videoFile);

    // every recorded take (original capture blob = smallest faithful source)
    let done = 0;
    const allTakes = p.segments.flatMap(s => s.takes);
    for (const t of allTakes) {
      if (t.blob) zip.file('takes/' + t.id + guessExt(t.blob), t.blob);
      done++;
      prog(0.15 + 0.25 * (done / Math.max(1, allTakes.length)), `Packing takes… ${done}/${allTakes.length}`);
    }

    prog(0.45, 'Compressing archive…');
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      meta => prog(0.45 + 0.5 * (meta.percent / 100), `Compressing… ${Math.round(meta.percent)}%`)
    );
    prog(1, 'Done');
    const fname = p.name.replace(/[^\w\u0600-\u06FF-]+/g, '_') + '.dubproj.zip';
    return { blob, filename: fname };
  }

  function guessExt(blobOrFile, name) {
    const n = name || (blobOrFile && blobOrFile.name) || '';
    const m = n.match(/\.[A-Za-z0-9]+$/);
    if (m) return m[0].toLowerCase();
    const t = blobOrFile && blobOrFile.type || '';
    if (t.includes('webm')) return '.webm';
    if (t.includes('mp4')) return '.mp4';
    if (t.includes('quicktime')) return '.mov';
    if (t.includes('ogg')) return '.ogg';
    return '.bin';
  }

  function buildSrt(segments) {
    return segments.map((s, i) =>
      `${i + 1}\n${toSrtTime(s.startTime)} --> ${toSrtTime(s.endTime)}\n${s.text}\n`
    ).join('\n');
  }
  function toSrtTime(sec) {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.round((sec % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  }
  function buildScript(segments) {
    let out = '', lastChar = null;
    for (const s of segments) {
      if (s.character !== lastChar) { out += `\n[${s.character}]\n\n`; lastChar = s.character; }
      out += s.activeText + '\n\n';
    }
    return out.trim() + '\n';
  }

  /* ── OPEN ──────────────────────────────────────────── */

  /**
   * Load a .dubproj.zip bundle. Returns {manifest, videoFile, takeBlobs}
   * where takeBlobs is a Map takeId → Blob. Decoding/DSP re-application
   * is done by the caller (app.js) which owns the AudioContext flow.
   */
  async function open(file, { onProgress } = {}) {
    if (typeof JSZip === 'undefined') throw new Error('The archive library (JSZip) failed to load — check your connection.');
    const prog = (v, l) => { if (onProgress) onProgress(v, l); };
    prog(0.05, 'Reading archive…');
    let zip;
    try { zip = await JSZip.loadAsync(file); }
    catch (e) { throw new Error('This file is not a valid project archive (.dubproj.zip).'); }

    const manEntry = zip.file('project.json');
    if (!manEntry) throw new Error('The archive has no project.json — not a Dubbing Studio project.');
    let manifest;
    try { manifest = JSON.parse(await manEntry.async('string')); }
    catch (e) { throw new Error('The project data inside the archive is corrupted.'); }
    if (manifest.format !== 'dubproj') throw new Error('Unknown project format.');
    if (manifest.version > FORMAT_VERSION) throw new Error('This project was saved with a newer version of Dubbing Studio.');

    prog(0.15, 'Extracting video…');
    const vEntry = zip.file(manifest.videoFile);
    if (!vEntry) throw new Error('The bundled video file is missing from the archive.');
    const vBlob = await vEntry.async('blob');
    const videoFile = new File([vBlob], manifest.videoName || 'video.mp4',
      { type: mimeFromExt(manifest.videoFile) });

    const takeBlobs = new Map();
    const takeMetas = manifest.segments.flatMap(s => s.takes);
    let done = 0;
    for (const tm of takeMetas) {
      const e = zip.file(tm.file);
      if (e) takeBlobs.set(tm.id, await e.async('blob'));
      done++;
      prog(0.2 + 0.7 * (done / Math.max(1, takeMetas.length)), `Extracting takes… ${done}/${takeMetas.length}`);
    }
    prog(1, 'Done');
    return { manifest, videoFile, takeBlobs };
  }

  function mimeFromExt(path) {
    if (/\.webm$/i.test(path)) return 'video/webm';
    if (/\.mov$/i.test(path)) return 'video/quicktime';
    return 'video/mp4';
  }

  return { save, open };
})();
