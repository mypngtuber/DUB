# 🎙️ Dubbing Studio — AI-Assisted Dubbing Workstation

A simple, professional, dark-themed desktop web application for recording **timed video dubbing**. Not a generic video editor, not a generic voice recorder — every dialogue line already has its exact place on the timeline **before** the actor starts recording.

**Core workflow:**
Upload Video → Separate Audio (VOICE_STEM + MUSIC_STEM) → Analyze Original Dialogue → Read SRT → Identify Characters from Script → Create Pre-Timed Dubbing Segments → Record Each Segment → AI Timing Check → AI Auto Enhance → Accept/Retake → Automatic Placement → Export

---

## ✅ Currently Completed Features

### Project creation & analysis pipeline
- Upload **Video** (MP4/MOV/WebM), **SRT** subtitles, **Script** (`[CHARACTER]` + dialogue) with drag & drop
- Deterministic **SRT parser** (timing is authoritative; invalid blocks reported, never silently dropped)
- Deterministic **Script parser** → character identification from `[NAME]` / `NAME:` headers
- **SRT ↔ Script matching** (Arabic-aware text normalization + similarity). Confident → character assigned; ambiguous → **UNKNOWN / NEEDS REVIEW** (never silently assigned). Optional Gemini resolution of ambiguous lines
- **Two-stem audio separation**: original audio → exactly `VOICE_STEM` + `MUSIC_STEM` (modular client-side DSP — mid-channel speech-band extraction; swappable for an ML engine without UI changes)
- **VOICE_STEM speech analysis** (VAD): actual speech start/end, duration, silence before/after, SRT-timing validation flag per line

### The Dubbing Timeline (the only visible timeline)
- Built **before recording** — one segment per dialogue line by default, with Line ID, Character, Text, Start, End, Target Duration, Status, Takes, Accepted Take
- **Merge linked SRT lines**: select two or more consecutive, unrecorded lines for the same character and merge them into one performance window. The merged duration spans the first start through the last end, preserving pauses between cues; source line IDs remain stored
- Segment width ∝ duration, gaps visible, ruler + zoom, playhead synced to video, current-segment highlight, per-status colors, accepted-take waveform drawn inside its exact segment
- No original-voice / music / SFX timelines — original voice via **🎤 Listen** button (auto-ducks music); background music is the **separated MUSIC_STEM** played at segment time with **AI Auto-Mix** (no manual volume UI)

### 🎵 AI Auto-Mixing (export-only) · Acapella preview & recording
- **Preview and recording are strictly ACAPELLA**: the separated background music is never played during segment preview, full-project preview or while recording (its vocal bleed from DSP separation would contaminate monitoring) — **▶ PLAY plays strictly the newly recorded dub voice over the muted video**
- The manual music volume slider was removed entirely — the engine measures the separated MUSIC_STEM loudness vs the original speech level and automatically sets the music bed ~12 dB under dialogue **at export time only**
- Export "Full Dub" renders **sidechain-style ducking automation**: the music bed dips ~6 dB under every accepted voice segment with smooth 80 ms/250 ms ramps

### ▶ Preview Full Project (topbar / `P`)
- Plays the **whole video (muted) from the start** with **ALL accepted takes** fired sequentially at their exact segment times — strictly acapella (no original audio, no music)
- Toggle button (Stop Preview) — stops automatically at video end; safe-guarded against recording sessions

### 💾 Save / Open Project (.dubproj.zip — team collaboration)
- **Save** bundles ONE compressed archive: `project.json` (full segment/take metadata, statuses, accepted takes, AI suggestions, user assignments) + the original video + **every recorded take blob** + reconstructed `source.srt` / `source.txt`
- **Open** restores everything: video reload, local stem re-separation, take blobs re-decoded and the fixed DSP chain re-applied, all statuses/accepted takes/AI variations back — a teammate continues seamlessly
- Enhanced/fitted renders are metadata-only (buffers aren't serializable) — flags reset on open; re-run AI Auto Enhance / Fit per take when needed

### Recording workflow
- Record directly into the selected segment, or switch to the optional **Open Recording** full-clip workflow
- **Pre-record countdown (safety time)**: every RECORD starts with a fullscreen 3-2-1 countdown (cancellable with Esc) so the actor can get ready
- **Post-record SAFETY TAIL (end-clipping protection)**: pressing STOP does **not** cut the capture immediately — the microphone keeps rolling for an extra **800 ms safety period** (the UI shows `⏳ SAFETY TAIL…`) so the decay of the last word and the encoder's final frames are never destroyed. The auto-trim additionally keeps **+200 ms tail / +50 ms head padding** around the detected speech, while timing verdicts are still judged on the real (unpadded) speech duration
- **Multi-Take sessions** (MULTI button / `M`): record several consecutive takes in one hands-free session — RECORD/M ends the take and rolls the next one after a short countdown, FINISH ends the session. Each take is **auto-trimmed** (leading/trailing silence removed) and the **AI evaluates all session takes** (timing fit 45% + clarity/SNR 30% + cleanliness 25%) and pre-selects the single best performance (⭐ AI BEST badge); ACCEPT uses it by default — final acceptance stays explicit
- **Fixed recording DSP chain** (`js/dsp-chain.js`) applied automatically to every take right after capture, before analysis:
  1. Overall gain **−9 dB**
  2. VAD-based noise suppression (RNNoise-style): **threshold 0.60**, grace **200 ms** (20 × 10 ms frames), retroactive grace **0**
  3. EQ Filter 1 — **High-pass 70.0 Hz**, 0.0 dB, BW **1.60 oct** (Q ≈ 0.857)
  4. EQ Filter 2 — **Peaking 150.0 Hz, +4.0 dB**, BW **0.40 oct** (Q ≈ 3.596)
  5. Noise gate (downward expander): threshold **−inf dB** (open), attack **3 ms**, hold **0 ms**, release **100 ms**, hysteresis **0.0 dB**, sidechain LP **20 kHz** / HP **0 Hz**
  - The untouched capture is kept in `take.rawBuffer` ("Hear Original" A/B plays it); a blue **DSP** badge on each take shows the applied chain
- Live timer: TARGET vs RECORDING, visual meter with target mark, verdicts (under / within / near / too long), live mic level
- **Multiple takes** per segment with Preview / Use Take / Delete and waveforms
- Deterministic take analysis: trimmed speech duration, clipping, leading/trailing silence, internal gaps, completeness heuristics
- **Fit Audio to Target**: optional gentle time-stretch (≤12% — beyond that it recommends retake/AI rewrite)
- **✓ ACCEPT TAKE** is always explicit — accepted audio placed at the segment's exact start/end (authoritative)

### Open Recording — unlimited professional voice timeline
- The voice timeline is independent from picture lock and expands automatically in 30-second blocks, so the actor can keep performing after the video ends and stop naturally without losing a word
- The video and SRT cues stay synchronized while picture is available; after picture ends the voice playhead and microphone keep running until Stop is pressed
- Start or continue recording from any playhead position; recording overwrites only the newly captured range and preserves the rest of the take
- Audition-style waveform tools: adjustable timeline zoom, clip move/edge trim, range selection, precise IN/OUT, silence/delete, re-record, split, trim, gain (−60 to +24 dB), peak normalization to −3 dB, fades, reverse and multi-level undo
- **Save recording** detects every speech region and aligns clips to dialogue cues without overlaps while dynamically growing the master track instead of clipping long performances
- MP3 export preserves open-track speech beyond the video duration; video export remains locked to the source picture length
- Open-track audio, extended duration and edit history metadata are included in `.dubproj.zip` project bundles

### ✨ AI-Powered Professional Audio Enhancement (fully automatic)
- **AI Auto Enhance** button on every take (+ optional auto-enhance of every new take, toggle in Settings)
- The AI **analyzes** the recording (noise floor, SNR, rumble, sibilance, crest factor/dynamics, clipping, spectral balance) then **decides and applies** only what's needed — the user never touches technical parameters:
  1. High-pass rumble removal
  2. Adaptive background-noise reduction (downward expander)
  3. Voice-clarity corrective EQ (mud cut, presence, air)
  4. Dynamics compression sized to the performance
  5. **De-esser** — only when harsh S/SH detected
  6. Loudness normalization to dialogue level
  7. Soft-knee limiter — clipping/distortion prevention
- Optional **Gemini refinement** of the processing chain (falls back safely to rule-based settings)
- "What the AI did" report + measured metrics, **Hear Original** A/B button; the raw take is always preserved
- Enhanced audio automatically used in preview, timeline waveforms, time-fit and export

### AI Timing Assistant (Gemini) — bi-directional variations
- Target vs recording vs difference card; TOO LONG / TOO SHORT detection
- On ANY timing mismatch, one click generates **BOTH directions at once: 2 CONDENSED (shorter) + 2 EXPANDED (longer) variations** preserving meaning, context, character personality & style, each with estimated duration — the actor picks whichever fits their natural pace
- Variations grouped under CONDENSED / EXPANDED headers; buttons: USE AI SUGGESTION / EDIT TEXT / RECORD AGAIN / KEEP ORIGINAL — **suggestions never auto-replace text**

### UI / UX
- Dark charcoal studio UI, panels: characters+queue (left) · video+dialogue+controls+timeline (center) · AI assistant+takes+speech analysis (right)
- Video preview: play/pause, frame step, seek, volume, fullscreen, aspect switch (9:16 / 16:9 / 1:1 / Original); follows the selected segment
- **Very large Arabic RTL dialogue** display with 48–96px size slider
- Character filter (only that character's queue), per-character & global progress, Accepted/Review/Retake/Remaining stats
- **Focus Mode** (F): video + character + huge text + target + listen/music + record/accept/prev/next + compact current segment
- Keyboard: `Space` play/pause · `R` record · `Enter` accept · `←/→` prev/next · `L` listen original · `M` multi-take · `P` preview full project · `F` focus
- **Single User / Multi User** modes: character→user assignment, active-user filtered view, owner overview
- Clear human-readable error handling everywhere (missing/invalid files, mic permission, Gemini failures, unsupported media, export failures)

### Settings & Export
- Gemini **API key** (localStorage — prototype storage, clearly flagged; production should proxy server-side), model selector (`gemini-3.6-flash` default + 6 more) and **+ Add Custom Model**, Test Connection
- Export dialog: **Full Dub / Dubbing Only / Music Only** × **MP3 / Video**; offline mix renders accepted takes at exact segment positions; MP3 via lamejs; video via H.264 MP4 when the browser supports MediaRecorder H.264, otherwise WebM (Premiere note shown); export progress bar. Original voice stem is never in the dub mix.

---

## 📂 Entry Points

| Path | Purpose |
|---|---|
| `index.html` | The entire application (setup wizard → workspace → focus mode → modals) |

No URL parameters; all state is in-memory per session (media files are never uploaded to any server).

## 🧩 Architecture (modular)

| File | Responsibility |
|---|---|
| `js/parsers.js` | Deterministic SRT/Script parsing, matching, segment building |
| `js/audio-engine.js` | Audio extraction, 2-stem separation, VAD, reference playback/ducking |
| `js/recorder.js` | Per-segment mic recording, full-clip track editing, take analysis, preview, time-fit |
| `js/enhancer.js` | ✨ AI Auto Enhance: analyze → decide → process chain |
| `js/gemini.js` | Gemini API: settings, ambiguous matching, timed rewrites |
| `js/timeline.js` | Dubbing Timeline rendering, playhead, waveforms |
| `js/exporter.js` | Offline mix render, MP3 encode, video capture export, file download |
| `js/dsp-chain.js` | Fixed per-take recording DSP chain (exact user spec) |
| `js/project-store.js` | 💾 Save/Open `.dubproj.zip` bundles (JSZip): manifest + video + take blobs |
| `js/app.js` | State, workflow, UI wiring, navigation, users, settings, export UI, full-project preview, project restore |

**Data model** — segment: `id, lineNumber, sourceLineNumbers[], character, text/activeText, startTime, endTime, targetDuration, originalSpeechStart/End, status, takes[], acceptedTakeId, aiSuggestions[]`; optional open recording: `buffer, hasAudio, duration, edits[]`; take: `id, segmentId, blob, buffer, duration, trimStart/End, analysis, status, enhancedBuffer?, enhanceReport?, fittedBuffer?, createdAt`.

Segment states: `EMPTY · RECORDING · PROCESSING · NEEDS REVIEW · TIMING MISMATCH · RETAKE · ACCEPTED`.

## 🚧 Not Yet Implemented
- Auto-save / IndexedDB persistence (manual **Save Project** bundle exists; in-memory otherwise)
- ML-grade stem separation (current DSP separation is an approximation; module is swappable)
- Guaranteed H.264 encoding in every browser (falls back to WebM)
- Real multi-user networking (multi-user is same-device role switching)
- Manual character re-assignment UI for UNKNOWN lines

## 💡 Recommended Next Steps
1. IndexedDB auto-save on top of the `.dubproj.zip` manual bundles
2. Server-side (or WASM Demucs/Spleeter) stem separation upgrade
3. ffmpeg.wasm for true H.264/AAC MP4 muxing at original resolution/fps
4. Click-to-reassign character on NEEDS REVIEW lines
5. Batch "Enhance all accepted takes" action

## 🌐 Deployment
Static site — publish via the **Publish tab**. Requires a browser with Web Audio + MediaRecorder (Chrome/Edge recommended). A Gemini API key (Settings) enables the AI text features; everything else works without it.
