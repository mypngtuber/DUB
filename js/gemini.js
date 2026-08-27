/* ═══════════════════════════════════════════════════════════════
   gemini.js — Gemini API integration (AI layer only)
   Used ONLY for genuinely AI tasks:
   • resolving ambiguous script/SRT character matches
   • timing-aware dialogue rewrites (shorter/longer) that preserve
     meaning, context and character voice
   Deterministic work (SRT parsing, timing math, segments, export)
   never goes through this module.
   API key + model live in localStorage — prototype-level storage,
   clearly NOT a production secret store (see Settings note).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Gemini = (() => {
  const LS_KEY = 'dubstudio.gemini.key';
  const LS_MODEL = 'dubstudio.gemini.model';
  const LS_CUSTOM = 'dubstudio.gemini.customModels';

  const DEFAULT_MODELS = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ];

  function getKey() { return localStorage.getItem(LS_KEY) || ''; }
  function setKey(k) { localStorage.setItem(LS_KEY, (k || '').trim()); }
  function getModel() { return localStorage.getItem(LS_MODEL) || DEFAULT_MODELS[0]; }
  function setModel(m) { localStorage.setItem(LS_MODEL, m); }
  function getCustomModels() {
    try { return JSON.parse(localStorage.getItem(LS_CUSTOM) || '[]'); } catch (e) { return []; }
  }
  function addCustomModel(name) {
    name = (name || '').trim();
    if (!name) return false;
    const list = getCustomModels();
    if (!list.includes(name)) { list.push(name); localStorage.setItem(LS_CUSTOM, JSON.stringify(list)); }
    return true;
  }
  function allModels() { return [...DEFAULT_MODELS, ...getCustomModels().filter(m => !DEFAULT_MODELS.includes(m))]; }
  function isConfigured() { return !!getKey(); }

  /* ── core call ─────────────────────────────────────── */

  async function call(prompt, { json = false, temperature = 0.4 } = {}) {
    const key = getKey();
    if (!key) throw new Error('No Gemini API key configured. Open Settings and add your API key.');
    const model = getModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 2048 }
    };
    if (json) body.generationConfig.responseMimeType = 'application/json';

    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('Could not reach the Gemini API (network error).');
    }
    if (!res.ok) {
      let msg = `Gemini API error (HTTP ${res.status})`;
      try { const j = await res.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) {}
      if (res.status === 400 && /API key/i.test(msg)) msg = 'The Gemini API key appears to be invalid. Check it in Settings.';
      if (res.status === 404) msg = `Model "${model}" was not found. Pick another model in Settings.`;
      throw new Error(msg);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  }

  function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch (e) {}
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    throw new Error('Gemini returned a response that could not be parsed.');
  }

  async function testConnection() {
    const t = await call('Reply with exactly: OK', { temperature: 0 });
    return /ok/i.test(t);
  }

  /* ── AI task: resolve ambiguous character matches ──── */

  async function resolveAmbiguousCharacters(ambiguousSegments, characters, scriptLines) {
    if (!ambiguousSegments.length) return [];
    const scriptSample = scriptLines.slice(0, 220).map(l => `[${l.character || 'NONE'}] ${l.text}`).join('\n');
    const items = ambiguousSegments.map(s => ({ id: s.id, line: s.lineNumber, text: s.text }));
    const prompt =
`You are helping match subtitle lines to characters in a dubbing script.

KNOWN CHARACTERS: ${characters.join(', ')}

SCRIPT (character-attributed lines, in order):
${scriptSample}

SUBTITLE LINES THAT COULD NOT BE MATCHED CONFIDENTLY:
${JSON.stringify(items, null, 1)}

For each subtitle line, decide which character most likely speaks it based on the script content and order.
If you are NOT confident, use "UNKNOWN". Never invent character names.

Respond ONLY with JSON: [{"id":"...","character":"NAME_OR_UNKNOWN","confidence":0.0-1.0}]`;
    const out = await call(prompt, { json: true, temperature: 0.1 });
    const arr = parseJsonLoose(out);
    if (!Array.isArray(arr)) throw new Error('Unexpected AI matching response format.');
    return arr;
  }

  /* ── AI task: bi-directional timing rewrites ─────────
     On ANY timing mismatch (too fast OR too slow) the AI generates
     BOTH condensed (shorter) AND expanded (longer) variations, so
     the actor can pick whichever fits their natural speaking pace. */

  /**
   * Generate multiple rewrite variations in both directions.
   * Returns an array of suggestion objects:
   * { id, text, estimatedDuration, note, direction } — direction: 'shorter'|'longer'
   */
  async function suggestTimedRewrites(segment, take, characterContext) {
    const target = segment.targetDuration;
    const actual = take ? take.duration : null;
    const rate = actual && segment.activeText ? (countUnits(segment.activeText) / actual) : null;

    const prompt =
`You are a professional dubbing script adapter working on Arabic dialogue.

CHARACTER: ${segment.character}
${characterContext ? 'CHARACTER CONTEXT (other lines by this character):\n' + characterContext + '\n' : ''}
ORIGINAL LINE (Arabic):
${segment.activeText}

TIMING SITUATION:
- Target duration (the slot in the video): ${target.toFixed(2)} seconds
- The actor's recording of this line took: ${actual ? actual.toFixed(2) + ' seconds' : 'unknown'}
${rate ? `- The actor speaks about ${rate.toFixed(1)} characters/second; size each variation accordingly.` : ''}

TASK — generate FOUR natural variations of the line so the actor can pick what fits their own speaking pace:
- 2 CONDENSED (shorter) versions: one slightly shorter, one clearly shorter.
- 2 EXPANDED (longer) versions: one slightly longer, one clearly longer.

RULES:
1. Preserve the exact meaning, emotional intent and context in every variation.
2. Preserve the character's personality and speaking style (register, dialect).
3. Keep every variation natural spoken Arabic suitable for dubbing.
4. Only adjust length — never add new information or change intent.
5. Estimate the spoken duration of each variation in seconds (assume the actor's pace above when known).

Respond ONLY with JSON:
{"variations":[
 {"text":"...","direction":"shorter","estimatedDuration":0.0,"note":"short English note"},
 {"text":"...","direction":"shorter","estimatedDuration":0.0,"note":"..."},
 {"text":"...","direction":"longer","estimatedDuration":0.0,"note":"..."},
 {"text":"...","direction":"longer","estimatedDuration":0.0,"note":"..."}
]}`;

    const out = await call(prompt, { json: true, temperature: 0.7 });
    const obj = parseJsonLoose(out);
    const arr = Array.isArray(obj) ? obj : obj && Array.isArray(obj.variations) ? obj.variations : null;
    if (!arr || !arr.length) throw new Error('The AI did not return usable variations.');
    const now = Date.now();
    return arr
      .filter(v => v && v.text && String(v.text).trim())
      .slice(0, 6)
      .map((v, i) => ({
        id: 'sug-' + now + '-' + i,
        text: String(v.text).trim(),
        estimatedDuration: typeof v.estimatedDuration === 'number' ? +v.estimatedDuration.toFixed(2) : null,
        note: v.note || '',
        direction: v.direction === 'longer' ? 'longer' : 'shorter',
        createdAt: now
      }));
  }

  // Back-compat single-direction wrapper (kept for any external callers)
  async function suggestTimedRewrite(segment, take, direction, characterContext) {
    const all = await suggestTimedRewrites(segment, take, characterContext);
    return all.find(s => s.direction === direction) || all[0];
  }

  function countUnits(s) { return (s || '').replace(/\s+/g, '').length; }

  return { DEFAULT_MODELS, getKey, setKey, getModel, setModel, addCustomModel, getCustomModels,
           allModels, isConfigured, testConnection, call,
           resolveAmbiguousCharacters, suggestTimedRewrite, suggestTimedRewrites };
})();
