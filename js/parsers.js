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

  return { parseSRT, parseScript, matchCuesToScript, buildSegments, secondsToClock, srtTimeToSeconds, similarity, normalizeCharName };
})();
