/* ═══════════════════════════════════════════════════════════════
   parsers.js — Deterministic parsing layer (NO AI here)
   - SRT parsing        → timing + text (authoritative timing)
   - Script parsing     → [CHARACTER] blocks → who speaks
   - Line matching      → SRT line ↔ script line ↔ character
   Ambiguous matches are flagged UNKNOWN / NEEDS REVIEW, never guessed.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Parsers = (() => {

  /* ── SRT ───────────────────────────────────────────── */

  // "00:00:01,800" or "00:00:01.800" → seconds (float)
  function srtTimeToSeconds(t) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
  }

  function secondsToClock(sec, withHours = false) {
    if (sec == null || isNaN(sec)) return '--:--.---';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    const mss = String(ms).padStart(3, '0');
    return (withHours || h > 0) ? `${String(h).padStart(2,'0')}:${mm}:${ss}.${mss}` : `${mm}:${ss}.${mss}`;
  }

  /**
   * Parse an SRT file text.
   * Returns { cues:[{index, lineNumber, start, end, text}], errors:[] }
   * Throws Error with a human message when the file is not usable.
   */
  function parseSRT(raw) {
    if (!raw || !raw.trim()) throw new Error('The SRT file is empty.');
    // normalize BOM + line endings
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const blocks = text.split(/\n{2,}/);
    const cues = [];
    const errors = [];

    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(l => l.length);
      if (!lines.length) continue;

      let i = 0;
      let lineNumber = null;
      // optional numeric index line
      if (/^\d+$/.test(lines[0])) { lineNumber = parseInt(lines[0], 10); i = 1; }

      if (i >= lines.length) continue;
      const tm = lines[i].match(/^(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/);
      if (!tm) { errors.push(`Skipped block (no timing line): "${lines[0].slice(0, 40)}"`); continue; }

      const start = srtTimeToSeconds(tm[1]);
      const end = srtTimeToSeconds(tm[2]);
      if (start == null || end == null) { errors.push(`Invalid timestamp in block ${lineNumber ?? '?'}`); continue; }
      if (end <= start) { errors.push(`Block ${lineNumber ?? '?'}: end time ≤ start time — kept but flagged.`); }

      const textLines = lines.slice(i + 1);
      const cueText = textLines.join('\n').trim();
      if (!cueText) { errors.push(`Block ${lineNumber ?? '?'} has no text — skipped.`); continue; }

      cues.push({
        index: cues.length,
        lineNumber: lineNumber ?? (cues.length + 1),
        start, end,
        text: cueText
      });
    }

    if (!cues.length) throw new Error('No valid subtitle entries were found in the SRT file. Check the file format.');
    cues.sort((a, b) => a.start - b.start);
    return { cues, errors };
  }

  /* ── SCRIPT ────────────────────────────────────────── */

  /**
   * Parse a script of the form:
   *   [MAOMAO]
   *   dialogue…
   *   dialogue…
   *   [JINSHI]
   *   dialogue…
   * Also tolerates "MAOMAO:" style headers.
   * Returns { lines:[{character, text, order}], characters:[names…], errors:[] }
   */
  function parseScript(raw) {
    if (!raw || !raw.trim()) throw new Error('The script file is empty.');
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const rows = text.split('\n');
    const lines = [];
    const characters = [];
    const errors = [];
    let current = null;

    const bracketHeader = /^\s*\[\s*([^\]]+?)\s*\]\s*$/;          // [MAOMAO]
    const colonHeader   = /^\s*([A-Z0-9 _\-\u0600-\u06FF]{1,30}):\s*$/; // MAOMAO:

    for (const row of rows) {
      const line = row.trim();
      if (!line) continue;
      let m = line.match(bracketHeader);
      if (!m) {
        const c = line.match(colonHeader);
        if (c) m = c;
      }
      if (m) {
        current = normalizeCharName(m[1]);
        if (!characters.includes(current)) characters.push(current);
        continue;
      }
      if (!current) {
        // dialogue before any character header → cannot attribute
        lines.push({ character: null, text: line, order: lines.length });
        errors.push(`Line before any character header: "${line.slice(0, 40)}"`);
      } else {
        lines.push({ character: current, text: line, order: lines.length });
      }
    }

    if (!lines.length) throw new Error('No dialogue lines were found in the script file.');
    if (!characters.length) errors.push('No [CHARACTER] headers found — all lines will need review.');
    return { lines, characters, errors };
  }

  function normalizeCharName(name) {
    return name.trim().replace(/\s+/g, ' ').toUpperCase();
  }

  /* ── TEXT NORMALIZATION for matching ───────────────── */

  function normalizeForMatch(s) {
    return (s || '')
      .replace(/[\u064B-\u0652\u0670]/g, '')       // Arabic diacritics
      .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[«»"'"'.,!?؟،؛:…\-–—()\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim().toLowerCase();
  }

  // similarity 0..1 via token overlap + length-normalized Levenshtein on short strings
  function similarity(a, b) {
    a = normalizeForMatch(a); b = normalizeForMatch(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const jaccard = inter / (ta.size + tb.size - inter);
    let lev = 0;
    if (a.length < 120 && b.length < 120) {
      lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    }
    return Math.max(jaccard, lev);
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      let cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /* ── MATCHING: SRT cue ↔ script line → character ───── */

  const MATCH_CONFIDENT = 0.72;
  const MATCH_WEAK = 0.45;

  /**
   * Deterministic matcher. For each SRT cue, find the best-matching script
   * line (monotonic order preferred). Confident → assign character.
   * Weak / none → character = 'UNKNOWN', needsReview = true.
   * Returns array of match results aligned with cues.
   */
  function matchCuesToScript(cues, scriptLines) {
    const results = [];
    let cursor = 0; // script position hint — dialogue order usually matches

    for (const cue of cues) {
      let best = { score: 0, idx: -1 };
      // search a window around the cursor first, then whole script
      const windowStart = Math.max(0, cursor - 3);
      const windowEnd = Math.min(scriptLines.length, cursor + 8);
      for (let i = windowStart; i < windowEnd; i++) {
        const sc = similarity(cue.text, scriptLines[i].text);
        if (sc > best.score) best = { score: sc, idx: i };
      }
      if (best.score < MATCH_CONFIDENT) {
        for (let i = 0; i < scriptLines.length; i++) {
          if (i >= windowStart && i < windowEnd) continue;
          const sc = similarity(cue.text, scriptLines[i].text);
          if (sc > best.score) best = { score: sc, idx: i };
        }
      }

      let character = 'UNKNOWN';
      let needsReview = true;
      let matchedScriptIdx = null;

      if (best.idx >= 0 && best.score >= MATCH_CONFIDENT && scriptLines[best.idx].character) {
        character = scriptLines[best.idx].character;
        needsReview = false;
        matchedScriptIdx = best.idx;
        cursor = best.idx + 1;
      } else if (best.idx >= 0 && best.score >= MATCH_WEAK && scriptLines[best.idx].character) {
        // weak match — keep candidate but flag for review (AI may resolve later)
        character = scriptLines[best.idx].character;
        needsReview = true;
        matchedScriptIdx = best.idx;
      }

      results.push({ cueIndex: cue.index, character, needsReview, score: best.score, matchedScriptIdx });
    }
    return results;
  }

  /* ── SEGMENT BUILDING (deterministic) ──────────────── */

  /**
   * Build dubbing segments — ONE SEGMENT PER DIALOGUE LINE — before recording.
   */
  function buildSegments(cues, matches) {
    return cues.map((cue, i) => {
      const m = matches[i];
      return {
        id: 'seg-' + String(cue.lineNumber).padStart(3, '0') + '-' + i,
        lineNumber: cue.lineNumber,
        sourceLineNumbers: [cue.lineNumber],
        sourceSegmentIds: ['seg-' + String(cue.lineNumber).padStart(3, '0') + '-' + i],
        character: m.character,
        text: cue.text,
        startTime: cue.start,
        endTime: cue.end,
        targetDuration: +(cue.end - cue.start).toFixed(3),
        originalSpeechStart: null,
        originalSpeechEnd: null,
        srtTimingOk: null,
        status: m.needsReview ? 'needs_review' : 'empty',
        matchScore: m.score,
        needsCharacterReview: m.needsReview,
        takes: [],
        acceptedTakeId: null,
        aiSuggestions: [],
        activeText: cue.text   // text currently shown (original unless user approved AI version)
      };
    });
  }

  /**
   * Merge two or more adjacent subtitle segments into one recording unit.
   * Timing remains authoritative: the merged window spans from the first cue
   * start to the last cue end, including any intentional pause between cues.
   * Existing takes are deliberately rejected so audio is never lost silently.
   */
  function mergeSegments(allSegments, ids) {
    const wanted = new Set(ids || []);
    const picked = allSegments.filter(s => wanted.has(s.id)).sort((a, b) => a.startTime - b.startTime);
    if (picked.length < 2) throw new Error('Select at least two dialogue lines to merge.');
    if (picked.some(s => (s.takes && s.takes.length) || s.acceptedTakeId)) {
      throw new Error('Lines with recorded takes cannot be merged. Delete their takes first so no audio is lost.');
    }
    const firstIndex = allSegments.indexOf(picked[0]);
    const indexes = picked.map(s => allSegments.indexOf(s));
    if (indexes.some((v, i) => i && v !== indexes[i - 1] + 1)) {
      throw new Error('Only consecutive dialogue lines can be merged.');
    }
    const characters = [...new Set(picked.map(s => s.character))];
    if (characters.length !== 1) throw new Error('Merged lines must belong to the same character.');

    const first = picked[0], last = picked[picked.length - 1];
    const sourceLineNumbers = picked.flatMap(s => s.sourceLineNumbers || [s.lineNumber]);
    const merged = {
      ...first,
      id: `seg-merged-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      lineNumber: sourceLineNumbers[0],
      sourceLineNumbers,
      sourceSegmentIds: picked.flatMap(s => s.sourceSegmentIds || [s.id]),
      // Keep complete source snapshots so a merge is always reversible.
      mergedSources: picked.flatMap(s => s.mergedSources || [cloneSegmentForMerge(s)]),
      text: picked.map(s => s.text).join('\n'),
      activeText: picked.map(s => s.activeText || s.text).join('\n'),
      startTime: first.startTime,
      endTime: last.endTime,
      targetDuration: +(last.endTime - first.startTime).toFixed(3),
      originalSpeechStart: first.originalSpeechStart,
      originalSpeechEnd: last.originalSpeechEnd,
      speechAnalysis: null,
      srtTimingOk: picked.every(s => s.srtTimingOk !== false),
      status: picked.some(s => s.needsCharacterReview) ? 'needs_review' : 'empty',
      needsCharacterReview: picked.some(s => s.needsCharacterReview),
      takes: [],
      acceptedTakeId: null,
      aiBestTakeId: null,
      aiSuggestions: []
    };
    const next = [...allSegments];
    next.splice(firstIndex, picked.length, merged);
    return { segments: next, merged, removed: picked };
  }

  function cloneSegmentForMerge(segment) {
    return {
      ...segment,
      sourceLineNumbers: [...(segment.sourceLineNumbers || [segment.lineNumber])],
      sourceSegmentIds: [...(segment.sourceSegmentIds || [segment.id])],
      takes: [...(segment.takes || [])],
      aiSuggestions: [...(segment.aiSuggestions || [])],
      mergedSources: undefined
    };
  }

  function unmergeSegment(allSegments, id) {
    const index = allSegments.findIndex(s => s.id === id);
    if (index < 0) throw new Error('Select a merged dialogue segment first.');
    const merged = allSegments[index];
    if (!merged.mergedSources || merged.mergedSources.length < 2) {
      throw new Error('This segment is not a reversible merge.');
    }
    if ((merged.takes && merged.takes.length) || merged.acceptedTakeId) {
      throw new Error('Delete takes recorded on the merged segment before separating it, so no audio is lost.');
    }
    const restored = merged.mergedSources.map(cloneSegmentForMerge).sort((a, b) => a.startTime - b.startTime);
    const next = [...allSegments];
    next.splice(index, 1, ...restored);
    return { segments: next, restored, removed: merged };
  }

  return { parseSRT, parseScript, matchCuesToScript, buildSegments, mergeSegments, unmergeSegment, secondsToClock, srtTimeToSeconds, similarity, normalizeCharName };
})();
