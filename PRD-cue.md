# PRD: Cue (Windows Desktop App)

**Version:** 2.1 (see §14 Change Log)
**Owner:** Omkar
**Audience:** Claude Code (implementation agent)
**Status:** Interview Mode built (v1.0, Phases 1–4, as "Interview Copilot"); Work Mode Phases 5, 5.1 and 7 built; Phase 6 to build

---

## 1. Overview

Cue is a personal Windows desktop app that listens to call audio, optionally reads the screen, and shows concise, streamed answers in a small always-on-top overlay. It runs in one of two **modes**, selected per session:

- **Work Mode (primary):** holds context on the user's ongoing projects and tasks. In a live call, when someone asks for a status update, Cue surfaces a ready-to-say summary pulled from the project context store and the live conversation. It can also explain or summarize whatever is on screen (a deck, doc, or app) while the user presents it, and write a recap after the call and a brief before it.
- **Interview Mode:** the original use case (built as _Interview Copilot_, v1.0) — detects interview questions and drafts answers personalized from a resume and job description, plus a **Practice** (mock-interview) flow that plays the interviewer and gives feedback on spoken answers.

Both modes share the same audio/screen capture, speech-to-text, overlay, LLM providers with failover, history and cost-tracking pipeline; they differ in context source, trigger logic, and prompt.

### 1.1 Goals

- **Work Mode:** answer "what's the status of X" in under 3 seconds using stored project context plus what's been said so far in the call.
- **Work Mode:** summarize or explain on-screen content (PPT/Word/app) on demand while presenting.
- **Interview Mode:** answer spoken interview questions with first tokens visible in **< 3 seconds** after the question ends; use screen content (e.g., a coding problem) as context on demand.
- Personalize answers — Work Mode from the project store, Interview Mode from resume + job description + custom notes.
- Keep running cost around **$0.50–2 per hour**, with a live cost meter.
- Single-user, local-first. No backend server. API keys stay on the device.
- Features designed to hide the app or overlay from screen sharing, recording, or proctoring tools. If the overlay must stay off a shared screen, use a second monitor/virtual desktop or share a single window/app instead of the full desktop (see §3.11).
- Auto-typing or injecting answers into other applications.

### 1.2 Non-goals (v1)

- No multi-user accounts, billing, or cloud sync.
- No macOS/Linux builds (keep code portable where cheap, but do not test).

---

## 2. User Stories

| #   | As a user I want to…                                                                                | So that…                                                                   | Mode      |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------- |
| U1  | Start a session with one click / hotkey                                                             | I can get going quickly                                                    | Both      |
| U2  | See a live transcript of what's being said                                                          | I can confirm it heard correctly                                           | Both      |
| U3  | Register projects/tasks with status, owner, deadline, notes                                         | Cue has context before the call starts                                     | Work      |
| U4  | Ask "status of \<project\>" (by voice cue or hotkey) and get a spoken-ready summary                 | I can answer my director instantly                                         | Work      |
| U5  | Have Cue notice when someone asks me a status/update question and surface the summary automatically | I don't have to trigger it manually                                        | Work      |
| U6  | Point Cue at my screen while presenting a deck/doc/app                                              | It can explain or summarize what's shown                                   | Work      |
| U7  | Get a post-call recap of decisions and action items                                                 | I don't lose track between projects                                        | Work      |
| U8  | Get a pre-call brief of where each project stands                                                   | I walk in prepared                                                         | Work      |
| U9  | Get an answer automatically when an interview question ends                                         | I don't have to do anything manually                                       | Interview |
| U10 | Press a hotkey to force an answer to the last utterance                                             | I can trigger it when auto-detect misses                                   | Both      |
| U11 | Press a hotkey to include a screenshot in the question                                              | I can get help with on-screen content                                      | Both      |
| U12 | Upload my resume and a JD                                                                           | Interview answers reference my real experience                             | Interview |
| U13 | Choose answer style (bullets / STAR / code / status update)                                         | Output fits the situation                                                  | Both      |
| U14 | See the cost of the current session                                                                 | I can control spend                                                        | Both      |
| U15 | Review past sessions (transcript + answers)                                                         | I can review afterward                                                     | Both      |
| U16 | Practice with AI-generated questions and get feedback                                               | I can prepare without a live interview                                     | Interview |
| U17 | Type or speak my own question to the assistant                                                      | I can ask something nobody said out loud                                   | Both      |
| U18 | See every question and answer of the session in one scroll                                          | I can glance back without flipping one at a time                           | Both      |
| U19 | Choose the LLM provider, including free tiers, with automatic failover                              | I can build and test without paying, and never get stuck when one runs out | Both      |

---

## 3. Functional Requirements

### 3.0 Mode Selection

- **FR-MD1:** A mode switch (Work / Interview) on the Session tab, chosen before starting a session (locked while one runs; the overlay header shows the current mode). Each mode has its own profile data, prompt, trigger logic, and history filter. The last mode is remembered (`mode`).
- **FR-MD2:** Settings, hotkeys, overlay, audio/screen capture, STT/LLM providers and failover, and cost tracking are shared across modes. Hotkeys with a mode-specific meaning (§3.13) act on the current mode.
- **FR-MD3:** Context per mode — Interview: the Profile (resume, JD, role, company, notes; §3.7). Work: the project store (§3.10) plus the user's name and role from the Profile.

### 3.1 Audio Capture

- **FR-A1:** Capture Windows system audio output via WASAPI loopback (default output device). In Electron, use `session.setDisplayMediaRequestHandler` with `audio: 'loopback'` and `navigator.mediaDevices.getDisplayMedia`.
- **FR-A2:** Optionally capture microphone as a separate stream (off by default in live sessions of either mode, on in Practice).
- **FR-A3:** Label streams by source: `loopback` = "Interviewer" (Interview Mode) / "Call" (Work Mode), `mic` = "Me". Only `loopback` utterances trigger auto-answers (Interview) or status detection (Work), except while **voice questions** are on (FR-O7), when the user's mic speech is answered directly.
- **FR-A4:** Resample to 16 kHz mono PCM (linear16) in an AudioWorklet and send 100 ms chunks to the STT provider.
- **FR-A5:** Show an input level meter per stream in the main window.
- **FR-A6:** Let the user pick the output device if multiple exist; persist choice.

### 3.2 Speech-to-Text (STT)

- **FR-S1:** Pluggable provider interface `SttProvider { start(), sendAudio(chunk), stop(), on('partial'|'final'|'utteranceEnd'|'error') }`. WebSocket plumbing (reconnect, buffering, keep-alive, flush on stop) is shared by all providers (`SocketSttProvider`); `stt.provider` picks one per session.
- **FR-S2:** Default provider: **Deepgram streaming WebSocket** (latest general English model, `interim_results=true`, `smart_format=true`, `endpointing` ~300 ms, `utterance_end_ms` ~1000 ms). Model name configurable in settings.
- **FR-S3:** Secondary provider: **AssemblyAI** Universal-Streaming v3 (`wss://streaming.assemblyai.com/v3/ws`, raw key in `Authorization`, `pcm_s16le` 16 kHz, `min_turn_silence` = `endpointingMs`, `max_turn_silence` = `utteranceEndMs`). Model `stt.assemblyaiModel` (default `universal-streaming-english`, ~$0.15/h; `universal-streaming-multilingual`, `universal-3-6-pro`). A turn's partials are shown live; with `format_turns` the punctuated copy of a finished turn is kept (the unformatted one is used if none arrives within 1.5 s); each turn becomes one final + `utteranceEnd`. Turn numbers restart per connection. A policy close (bad key, no balance) is fatal. Stretch: local `whisper.cpp` via a sidecar process.
- **FR-S4:** Auto-reconnect with exponential backoff (0.5 s doubling to 8 s, max **8** tries ≈ 40 s, so a 30 s network drop resumes — NFR reliability); buffer up to 5 s of audio during reconnect. After 3 consecutive failed tries the overlay shows a notice (and another when it reconnects).
- **FR-S5:** Send keep-alive messages during silence per provider docs.

### 3.3 Question Detection (Interview Mode; Work Mode reuses the pipeline — FR-W8)

- **FR-Q1:** On each `utteranceEnd` from the Interviewer stream, collect the finalized text since the last answer.
- **FR-Q2:** Run a fast heuristic first: ends with `?`, or starts with/contains question cues ("what", "how", "why", "tell me", "walk me through", "can you", "describe", "explain", "design", "write", "have you").
- **FR-Q3:** If heuristic is inconclusive and text ≥ 6 words, call the fast model classifier (see §6.2) returning `{ "is_question": bool, "type": "behavioral|technical|coding|system_design|situational|smalltalk|other", "clean_question": string }`. Timeout 1.5 s; on timeout, treat as question if ≥ 8 words.
- **FR-Q4:** Merge follow-ups: if a new question arrives within 10 s of the previous one and is short (< 8 words), append it to the previous question and regenerate. (Interviewer audio only; two quick short voice questions stay separate.)
- **FR-Q5:** Debounce: never fire more than one generation per 2 s. A new question cancels any in-flight generation (AbortController).
- **FR-Q6:** Toggle for "Auto-answer" (default on). When off, only hotkey triggers generate.
- **FR-Q7:** Mid-sentence pauses. Speakers pause, speak slowly or swallow words, and STT ends an utterance at each pause. If the text so far looks unfinished (no closing `.?!`, or it ends on a hanging word such as "the", "your", "about", "how", "and"), wait `pauseGraceMs` (default 1,500 ms, 0 = off) for more speech before treating the turn as over; speech resuming cancels the wait and the pieces are joined into one question. Finished-looking questions are not delayed. Applies to interviewer audio and voice questions.
- **FR-Q8:** Continuations. Speech that starts within 3 s of the previous question's end — or within 10 s when that question looked unfinished — continues it, even if STT punctuated the fragment as finished: append it to the previous question and regenerate the same Q&A (no detection, no new card). After a real question the candidate answers, so the interviewer's next question comes much later.

### 3.4 Screen Context

- **FR-SC1:** Hotkey `Ctrl+Shift+S` captures the primary display (or a user-chosen display) via `desktopCapturer`, downscales to max 1600 px on the long edge (`screen.maxEdgePx`), JPEG quality 80. The overlay fades out during a hotkey capture so it doesn't cover the content.
- **FR-SC2:** Screenshot is attached to the **next** generation (or immediately triggers one with prompt "Solve / answer what's shown on screen" — in Work Mode "Explain / summarize what's shown" (FR-W11) — if no pending question). A question is pending while the interviewer is speaking, the turn is in its mid-sentence grace wait (FR-Q7), or detection/debounce is under way. A typed question also takes the attached screenshot. Regenerate / Shorter reuse the Q&A's screenshot.
- **FR-SC3:** Option "Always include screenshot" (default off) for coding rounds: every answer gets a fresh capture; if it fails, the answer goes ahead without one.
- **FR-SC4:** Screenshot is sent to the LLM as an image content block (vision), using each provider's **screenshot model chain** (FR-G2), with the coding token budget. No local OCR in v1.
- **FR-SC5:** Show a small thumbnail of the attached screenshot in the overlay, with an × to remove; Q&As asked with screenshots show their thumbnails next to the question.
- **FR-SC6:** Several screenshots per question, for long problems that need scrolling. `Ctrl+Shift+Alt+S` or the overlay camera button **adds** a screenshot without answering (up to `screen.maxScreenshots`, default **5**, max 10; Groq's vision model takes at most 3 images, so a larger set skips Groq and goes to the next screenshot provider); the tray shows them numbered with an × each and an **Answer** button (Enter in the empty input does the same). `Ctrl+Shift+S` adds one more if there is room, then answers. All waiting screenshots are sent together, in order, with a prompt telling the model they are scrolled parts of one screen (may overlap) and to give one answer. A typed question takes them too. History stores each Q&A's screenshot count and, with "Keep screenshots", every image.

### 3.5 Answer Generation

- **FR-G1:** Pluggable `LlmProvider` interface, all streaming. Providers:
  - **Groq** (default; OpenAI-compatible API, free tier: 30 req/min and 1,000 req/day per model, ~0.5 s to first token)
  - **OpenRouter** (OpenAI-compatible; free `:free` models or paid models such as Claude)
  - **Google Gemini** (OpenAI-compatible endpoint, free tier; slowest — last backup)
  - **Anthropic Messages API** (paid)
- **FR-G2:** Three model slots per provider: `answerModel`, `fastModel` (classifier, summaries, practice feedback drafts) and `visionModel` (screenshots; must accept images; empty = provider skipped for screenshots). Each slot is a **chain of up to 12 model IDs** tried in order. Defaults (answer / fast / vision):
  - Groq: `openai/gpt-oss-120b, qwen/qwen3.8-27b, openai/gpt-oss-20b` / `openai/gpt-oss-20b, qwen/qwen3.8-27b, openai/gpt-oss-120b` / `qwen/qwen3.8-27b` (Groq's only vision model)
  - OpenRouter: "Free" preset — 12 / 10 free models across different upstreams, ending in `openrouter/free`, and 6 free vision models (Qwen 3.8, Gemma 4, Inkling); "Paid (fast)" preset (pay-as-you-go credits; `:nitro` = fastest host) — `openai/gpt-oss-120b:nitro, google/gemini-3.1-flash-lite, anthropic/claude-haiku-4.5` / `openai/gpt-oss-20b:nitro, google/gemini-3.1-flash-lite` / `qwen/qwen3.8-27b:nitro, google/gemini-3.1-flash-lite, meta-llama/llama-4-scout`; "Claude" preset — `anthropic/claude-sonnet-5.5` / `anthropic/claude-haiku-4.5` / `anthropic/claude-sonnet-5.5`
  - Gemini: `gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash, gemini-3.1-flash-lite` / `gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.5-flash` / `gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash`
  - Anthropic: `claude-sonnet-5-5` / `claude-haiku-4-5-20251001` / `claude-sonnet-5-5`
- **FR-G3:** Context sent per request — Interview Mode: system prompt (§6.1), resume summary, JD summary, custom notes, last ~2,000 tokens of transcript, the question, answer style, optional screenshot. Work Mode: the matched project's context and recent updates, the last ~2,000 tokens of the call (§6.5, §6.7), optional screenshot.
- **FR-G4:** Stream tokens into the overlay as they arrive. Render Markdown (bullets, bold, code blocks with syntax highlighting).
- **FR-G5:** Use prompt caching on the static system prompt + resume + JD block to cut cost and latency (Anthropic: `cache_control` + pre-warm at session start; OpenRouter: `cache_control` forwarded; Groq/Gemini: provider-side automatic caching only).
- **FR-G6:** Answer style chosen automatically from question type, overridable by hotkeys:
  - behavioral → STAR bullets
  - technical → 3–5 key bullets + one-line summary
  - coding → **four sections, in order** (setting `llm.codingAnswer`, default `stepwise`): `### 1. Understanding the problem` (what's asked in my own words, inputs → output with types/constraints, a walk-through of the example, edge cases and assumptions to confirm) → `### 2. Pseudocode` (plain-language steps) → `### 3. Brute force — O(…) time, O(…) space` (complete working code + why its complexity is poor) → `### 4. Optimal — O(…) time, O(…) space` (key insight, complete code, edge cases), in the user's preferred language. If the brute force is already optimal, section 4 says so. Also applied to coding problems in screenshots. **Shorter** gives only the optimal solution. `direct`: approach (2–3 bullets), complexity, then code.
  - system_design → components, data flow, trade-offs as bullets
  - status update (Work) → 3–5 natural spoken sentences, no bullets (FR-W7)
  - screen explain (Work) → 3–6 short bullets, headline takeaway first (FR-W11)
- **FR-G11:** Follow-up context. Each answer request includes the session's last 3 answered Q&As (oldest first, answers clipped to 1,500 chars) in an `<earlier_qa>` block before the transcript — typed and screenshot questions aren't in the transcript otherwise. A question that follows up on one of them ("what did you understand from this question?", "why", "what if", "can you improve it") gets a detailed answer about that specific problem (~150–300 words, its actual inputs/constraints/code), overriding the type's style and the ~120-word limit, with the long token budget. Regenerate sends only the Q&As before the one being redone.
- **FR-G7:** `max_tokens` configurable (default 600; coding, system design, screenshots and questions with earlier Q&A context 3,000 — room for the three coding versions; saved settings at the old 1,500 default are upgraded).
- **FR-G8:** "Regenerate" (`Ctrl+Shift+R`) and "Shorter" (`Ctrl+Shift+D`) actions.
- **FR-G9:** Model chains and provider failover.
  - Within a provider, a model that is rate-limited, over its daily quota or not found is skipped for a cooldown (the API's `Retry-After`, else 1 min for rate limits, 1 h for daily caps, 10 min for missing models) and the next model in the chain is used. OpenRouter receives 3 models per request (server-side `models` fallback); others receive one.
  - Settings choose a **main provider** and ordered **backup providers** (default: Groq, then OpenRouter, then Gemini). When the main provider's chain fails or the account is out (bad key, no credits, OpenRouter's 50/day free cap, Anthropic "credit balance too low"), the next backup with an API key answers with its own model chain. An account-wide failure benches that provider (1 h for caps/credits, 10 min for a bad key); saving a new key clears it.
  - Free-only OpenRouter chains always end with `openrouter/free`.
  - A model that hits `max_tokens` with no visible text (a reasoning model that spent the whole budget thinking) counts as a failure: it is skipped for 10 min (OpenRouter: the free router, when it picked a model not in the chain) and the next model / provider answers. Groq's `qwen` vision model runs with thinking off for screenshots.
  - `llm.visionProvider` (default `auto`) picks the first provider for screenshots (e.g. paid OpenRouter while text answers stay on free Groq); the main provider and backups follow. OpenRouter screenshot requests send `reasoning: { enabled: false }`.
  - Screenshot requests retry once on the vision chain (never the text-only fast models) and fail over only to providers with a vision chain.
- **FR-G10:** Reasoning effort per provider (`default|none|minimal|low|medium|high`): OpenRouter applies it to answers only; Groq/Gemini to answers, with the classifier and summaries at the lowest supported level. A model that rejects the setting is retried once with its default. Defaults favour latency (Sonnet 5.5 via Anthropic: thinking off; Groq: `low`; Gemini: `minimal`).

### 3.6 Overlay Window

- **FR-O1:** Frameless, always-on-top, resizable, draggable BrowserWindow. Remembers position/size.
- **FR-O2:** Adjustable opacity (40–100%) and font size (12–22 px).
- **FR-O3:** Sections: current question (1–2 lines, muted), streaming answer, screenshot thumbnail, status dot (listening / thinking / error).
- **FR-O4:** History arrows (`Ctrl+Shift+←/→`) to flip through previous Q&As in the session.
- **FR-O5:** Hotkey to show/hide the overlay (`Ctrl+Shift+H`).
- **FR-O6:** Dark theme default, light theme option.
- **FR-O7:** Ask bar at the bottom of the overlay: a text input (Enter asks; `Ctrl+Shift+K` focuses it from anywhere; works without a session) and a **mic toggle** for voice questions (`Ctrl+Shift+M`). While on, the user's mic speech is transcribed and answered directly (no question detection), with a live line showing what is heard. Turning it on starts a session if none is running and keeps the Q&As already shown; the mic is opened only while the toggle is on.
- **FR-O8:** Layout, switchable from the overlay header and Settings, remembered: **one at a time** (latest answer, ‹ › to flip) or **list** (every Q&A of the session, numbered, in one scroll; new questions scroll into view and streaming text is followed while the user is at the bottom; ‹ › jump to and mark the previous/next Q&A).
- **FR-O9:** Under each finished answer, show which model and provider answered (e.g. `gpt-oss-120b · Groq`).

### 3.7 Main Window (Control Panel)

Tabs:

1. **Session** — mode switch (FR-MD1), Start/Stop, audio device picker, level meters, live dual-lane transcript (Interviewer or Call / Me), auto-answer (auto-detect) toggle, cost meter, elapsed time; Work Mode adds **End call** (recap, FR-W13).
2. **Profile** — name and role (both modes); for Interview Mode: upload resume (PDF/DOCX/TXT), paste JD, company name, custom notes ("my top 3 projects", "preferred language: TypeScript"). On save, generate a compact summary with `fastModel` and cache it.
3. **Projects** (Work Mode) — projects and their tasks (FR-W1–W2), a quick **log an update** box per project (FR-W3), and **Prep brief** (FR-W14). Reachable in either mode, so projects can be prepared before switching.
4. **History** — list of sessions (newest first: date, mode badge, first question, duration, question count, cost; filter by mode); open one to view all Q&As (with saved screenshots), the transcript and, for Work calls, the recap; export as Markdown; delete one or all.
5. **Practice** (Interview Mode) — see §3.9 (round and count pickers, voice/speed, auto-record; question screen with live transcript, mic meter, feedback; debrief).
6. **Settings** — API keys, providers, models, hotkeys (shortcuts another app already owns are flagged), overlay options (incl. display and screen-sharing guidance, FR-H1), cost cap, data.

- **FR-M1:** System tray. Closing the main window hides it to the tray; the app (overlay, hotkeys, a running session) keeps running. Tray icon click opens the window; its menu has Open, Start/Stop session, Show/Hide overlay and Quit — the only way to exit. A one-time balloon explains this the first time the window is closed. Launching the app again reopens the window (single instance).

### 3.8 Cost Tracking

- **FR-C1:** Track, per session and in both modes, STT seconds (audio streamed, per lane) and LLM input/output/cached tokens per session using usage fields from API responses, including classifier calls and cache pre-warms. Recap requests count toward their call. Requests outside a history session (profile summaries, project condensing, prep briefs) are not counted.
- **FR-C2:** Pricing table in `config/pricing.json` — do not hard-code prices in logic. It ships with the app; **Settings → Cost → Open pricing file** copies it to `%APPDATA%/Cue/pricing.json`, which replaces it from the next session. LLM prices are per 1M tokens per provider, keyed by model ID with `*` wildcards (most specific wins). OpenRouter's reported per-request cost overrides the table. Groq/Gemini free tiers are priced at $0. Unpriced models count as $0 and are listed in the Session tab's cost tooltip.
- **FR-C3:** Show running `$` total in Session tab and a small figure in the overlay footer.
- **FR-C4:** Optional per-session cost cap (default $5, 0 = off); at 80% show a warning, at 100% switch `answerModel` to `fastModel` and notify (overlay notice + Session tab banner).

### 3.9 Practice Mode (Interview Mode only)

- **FR-P1:** User selects round type (behavioral, technical, system design, mixed) and count (5/10/15); the last choice is remembered (`practice.round`, `practice.count`). Needs a resume or JD in the Profile (else: message + Profile tab) and no live session running (they share the mic and STT).
- **FR-P2:** App generates questions from resume + JD with the **fast** models (one JSON request; spoken-style, personalised, no duplicates), reads each aloud with the Web Speech API (`speechSynthesis`; voice, speed and on/off in the Practice tab), then — with `practice.autoRecord` — starts recording the user's mic answer (mic-only capture + STT; live transcript and mic meter). The user can also start recording by hand, **type** the answer instead, edit the transcript as text, re-read the question, or skip it.
- **FR-P3:** After each answer, give feedback (§6.4, **answer** models with the usual failover): score 1–10, strengths, gaps, and an improved model answer (first person, resume facts only). The user can retry failed feedback, answer the same question again, or go on. Nothing heard → back to the question with a hint; a mic/STT failure mid-answer keeps the run going.
- **FR-P4:** After the last question, or **End practice** at any point, an end-of-practice debrief (Markdown, < 200 words: overall, what worked, 3 things to work on) is written; if that request fails, a plain summary from the scores is used. The run is saved to History as a `practice` session: each question with its answer, score, feedback and model, plus the debrief and average score; Markdown export includes all of it. Unreached questions are dropped; a run with no reviewed answer is not saved. Cost (LLM + mic STT) is tracked like a session.

### 3.10 Work Mode

#### 3.10.1 Project Context Store

- **FR-W1:** CRUD for **Projects**: name, aliases (e.g. "PRISM" / "the benchmarking tool"), status (On track / At risk / Blocked / Done), owner, stakeholders, deadline, free-text notes.
- **FR-W2:** CRUD for **work items** within a project — the things people ask about one by one ("the UAT deployment", "TOM approvals", "the login crash"). Each item has: **kind** (Task / Approval / Bug / Deployment), title, other names (aliases), status (To do / In progress / Waiting / Blocked / Done), **owner** (who's on it — the developer for a bug), **waiting on** (a team or person, e.g. "MDM team"), environment (e.g. UAT, Prod), due date, **last follow-up** (date, and a note on who chased whom), blockers, a reference (bug ID or link) and a note. Each item has its own timeline of updates (FR-W3).
- **FR-W3:** Quick-update box ("log an update") the user types — or dictates (Windows dictation, `Win+H`) — between/during calls; appended to the project's updates with a timestamp. An update can be attached to one item, and records **who** said it (e.g. "Ravi") and its **source**: typed, recap, Teams import (FR-T1/T2) or Teams sync (FR-T3). This is the main way the store stays current with minimal effort. During a Work session it is also reachable from the overlay ask bar (`update <project or item>: …`).
- **FR-W4:** Each project's background is kept under ~150 tokens (auto-condensed by `fastModel`, §6.9, when notes, finished items and older updates grow long; the raw text is kept) so several projects fit in context at once. **Open items are never condensed**: each is sent as one exact line (kind, status, owner, waiting on, environment, dates, blocker, ref), up to 40 per project (blocked and waiting first, then most recently changed), because callers ask about them one by one.
- **FR-W5:** Fuzzy matching: map spoken references to a **project or a work item** via names, aliases, item titles and references ("how's the migration going" → Payments migration; "status of the TOM approvals" → the TOM approvals item of the Mobile app project; "BUG 142" → that bug) locally (no LLM call) before querying the LLM, so Cue only sends the relevant project's context. Generic words (bug, approval, project, app…) don't identify anything on their own. A match below the confidence threshold, or one too close to the runner-up, is not used.

#### 3.10.2 Status Query — manual

- **FR-W6:** Hotkey (`Ctrl+Shift+Space`, "answer now" in Interview Mode) or a typed command (`status <project>` in the ask bar) opens a quick-pick of projects in the overlay; selecting one generates a spoken-ready status update (current state, recent progress, blockers, next step) from that project's stored context plus anything relevant said earlier in the current call (§6.5). Typed or voice questions in Work Mode go through the same status check as heard speech (FR-W8 cues + FR-W5 matching): a status question about a known project or item gets the spoken status answer; one whose project is unclear gets the quick-pick; anything else is answered with the context of the projects it mentions.
- **FR-W7:** Output style: 3–5 short spoken sentences, not bullet jargon — meant to be read aloud naturally, not glanced at as notes. The answer always uses the project's and item's stored status (never a softer word than "At risk" or "Blocked").
- **FR-W7a:** Item questions: a question about one item ("did we follow up with the MDM team for UAT?", "what's pending on the TOM approvals?") is answered about that item first — state, owner, who it's waiting on, last follow-up and who did it — in 1–3 sentences, and says how old the latest update is when it's more than 2 days old ("last update from Ravi, 3 days ago").
- **FR-W7b:** List questions ("which bugs are open and who's on them?", "what approvals are pending for the mobile app?") get every matching open item of that project, one short spoken clause each (item — owner — state).

#### 3.10.3 Status Query — auto-detect

- **FR-W8:** Same detection pipeline as §3.3 (utterance end, pause grace and continuations, FR-Q1/Q7/Q8), but the heuristic and classifier are tuned for work calls: `{"is_status_question": bool, "project_hint": string|null}` (§6.6) instead of interview question types. Cues: "what's the status of", "where are we on", "any update on", "how's \<project\> coming along", "when will \<task\> be done", "what's pending", "did we follow up with", "who's working on", "which bugs are open". Statements that merely mention an item ("the TOM approvals came through") are not questions: answering without the classifier needs a question form (a `?`, or a question word first).
- **FR-W9:** On a match, resolve `project_hint` against the store (FR-W5); if no confident match, show a quick-pick instead of guessing.
- **FR-W10:** Same debounce/cancel-in-flight behavior as FR-Q5, and the same auto toggle (FR-Q6, `Ctrl+Shift+A`). Speech that names a **different** project or item from the previous question is a new question, never a continuation or follow-up of it (FR-Q4/Q8 apply only when it doesn't).

#### 3.10.4 Screen-Aware Explain/Present

- **FR-W11:** Hotkey `Ctrl+Shift+S` captures the screen as in FR-SC1–SC6 and asks the model to explain, summarize, or anticipate questions about whatever's shown (a slide, a spreadsheet, a running app), using project context if the content matches a known project (§6.7).
- **FR-W12:** "Always include screenshot" mode (FR-SC3) is useful here for walking through a deck slide by slide.

#### 3.10.5 Recap & Brief

- **FR-W13:** "End call" action (Session tab or `Ctrl+Shift+E`) stops the session and summarizes the call transcript into decisions made, action items (with owner if stated), and open questions (§6.8); appended to the relevant project(s)' updates and saved to History with the call. If the recap request fails, the transcript is kept and the recap can be retried from History.
- **FR-W14:** "Prep brief" (pre-call) generates a one-pager across selected projects: current status, what changed since the last update, and likely questions (§6.9) — shown in the Main Window (Projects tab), not the overlay, since it's for reading before the call.

#### 3.10.6 Team Updates from Microsoft Teams

Developers post status, blockers and bug ownership in a Teams group chat or in private chats with the user; that is where most item updates come from. Cue reads them and **proposes** changes; nothing is applied until the user reviews it (a misread "deployment approved" quoted to a director is worse than no answer).

- **FR-T1:** **Import by paste** (Projects tab → *Updates from Teams*): paste chat text copied from Teams (a group chat, a channel or a private chat). The answer model extracts, per message: the project and item it is about (existing, or a proposed new item), field changes (status, owner, waiting on, environment, follow-up date, blocker, ref), the update text, the author and the message time. Messages about nothing tracked are listed as skipped.
- **FR-T2:** **Import by screenshot**: up to 8 screenshots of a Teams chat (pasted from the clipboard — `Win+Shift+S` then `Ctrl+V` — dropped, or picked as files) go through the same extraction with the vision models, read in order. They are converted to JPEG with a long edge of up to 2,400 px so small chat text stays readable.
- **FR-T3:** **Teams sync (enterprise)**: sign in with a work or school Microsoft account (Microsoft Graph, delegated permissions, device-code sign-in via MSAL; `Chat.Read` for group/private chats, `ChannelMessage.Read.All` for channels — the latter needs admin consent). It needs the organisation's own Entra **app registration** (public client, "Allow public client flows"; Cue asks for its client ID and tenant — setup steps are shown in the app). Channels are opt-in (`work.teams.includeChannels`) because their permission needs admin consent and asking for it would block sign-in where it isn't granted. The user picks which chats/channels to follow; Cue polls them every `work.teams.pollMinutes` (default 5) while running, only fetching messages newer than the last one read (the first sync of a chat reads the last 24 h; channel thread replies included; system messages skipped; HTML turned into text), and puts new messages through the same extraction, up to 120 per request. Messages are only marked read once their extraction succeeded. The refresh token is encrypted like the API keys (only the main process sees it); "Sync now", the interval, an on/off switch and Sign out are in the Teams sync card. Personal and free Teams accounts can't be read through Graph (Microsoft doesn't support it) — they use FR-T1/T2.
- **FR-T4:** **Review queue**: proposals appear as cards ("BUG-142 · Login crash → owner Ravi, In progress — *Ravi, 10:42*") with Accept / Edit / Skip, plus Accept all. Accepting applies the field changes and logs the update on the item with its author and source. A proposal for an item that doesn't exist yet offers "Create item"; if an item with the same reference or title exists by then (the same bug reported in two chats), it is updated instead. The same message seen twice (pasted and synced, punctuation aside) is proposed once, and changes the item already has aren't shown. The count of waiting proposals shows on the Projects tab and its "Updates from Teams" entry.
- **FR-T5:** **Local enterprise simulation**: `npm run mock-teams` starts a local fake of the parts of Microsoft Graph and the Microsoft identity platform Cue uses (device-code sign-in, `/me`, `/me/chats`, chat and channel messages with `$top`/`$filter` on time and paging), seeded with a sample "Mobile app" group chat and private chats with two developers, plus a small web page to post messages as different people. Setting `work.teams.graphBaseUrl` / `authorityUrl` to it makes the app behave exactly as against a real tenant; tests use it too. A real tenant (a Microsoft 365 Business trial, or a developer sandbox) can be used for a final check.
- **FR-T6:** Privacy: imported chat text and screenshots go to the configured answer/vision provider. Free tiers may log or train on prompts; Settings → Work warns about this and recommends a paid provider for company chats. Raw synced messages aren't stored: only the proposals (with the quoted message) and accepted updates, which "Delete all data" removes with the rest.

### 3.11 Keeping the Overlay Off a Shared Screen

Cue can hide itself from screen capture (see §1.2). Also (a single display is the normal case; the second-display helpers only appear with two or more displays):

- **FR-H1:** Settings panel with guidance: a reminder to use **share-a-window/app**, not full-desktop share, in Teams/Zoom/Meet when presenting (shown always), and — **only when more than one display is connected** — a one-click "Move overlay to another display" helper listing the connected displays. With one display the helper is hidden and nothing else changes.
- **FR-H2:** `Ctrl+Shift+H` instantly hides the overlay (§3.13) for cases where only full-desktop share is available — the main option on a single display.
- **FR-H3:** Only if a second display is detected: default the overlay to it on first run (`overlay.preferredDisplayId`). With one display the overlay stays on it. If the chosen display is later disconnected, the overlay moves back to the primary display (and returns when it is reconnected).

### 3.12 Storage

- **FR-D1:** Local SQLite in `%APPDATA%/Cue/data.db` (a pre-rename `%APPDATA%/InterviewCopilot` folder is moved there on first start; if it can't be moved it stays in use), via Node's built-in `node:sqlite` (no native module to rebuild for Electron), with numbered schema migrations (`PRAGMA user_version`).
- **FR-D2:** Tables: `sessions` (with `kind` copilot|practice|work, `label`, `summary`, `average_score`; a Work call's recap goes in `summary`), `utterances`, `qa_pairs`, `usage`, `practice_items`, and for Work Mode `projects`, `tasks`, `project_updates` (timestamped text with its source: typed, recap). The profile stays in `profile.json`. A history session opens with a listening session, or with the first question asked outside one; empty sessions are dropped; sessions left open by a crash are closed at their last activity on the next start. A regenerated answer replaces the earlier one.
- **FR-D3:** API keys encrypted with Electron `safeStorage`; never written to logs or plaintext config.
- **FR-D4:** Screenshots not persisted by default (setting to keep them).
- **FR-D5:** "Delete all data" button (**Settings → Data**): after confirmation, deletes history, practice runs, screenshots, profile, settings, API keys, the user's pricing.json and logs, then restarts the app. Scoped variants delete only Work data (projects, tasks, updates, Work calls) or only Interview data (profile, interview and practice sessions). The History tab also deletes one session or all history and screenshots.

### 3.13 Global Hotkeys (defaults, all rebindable)

| Action                           | Hotkey               | Mode             |
| -------------------------------- | -------------------- | ---------------- |
| Start/stop session               | `Ctrl+Shift+Enter`   | Both             |
| Answer now / status quick-pick   | `Ctrl+Shift+Space`   | Interview / Work |
| Screenshot + answer/explain      | `Ctrl+Shift+S`       | Both             |
| Add screenshot (answer later)    | `Ctrl+Shift+Alt+S`   | Both             |
| Regenerate                       | `Ctrl+Shift+R`       | Both             |
| Shorter                          | `Ctrl+Shift+D`       | Both             |
| Show/hide overlay                | `Ctrl+Shift+H`       | Both             |
| Prev/next answer                 | `Ctrl+Shift+←` / `→` | Both             |
| Toggle auto-answer / auto-detect | `Ctrl+Shift+A`       | Both             |
| Voice questions on/off           | `Ctrl+Shift+M`       | Both             |
| Type a question (focus)          | `Ctrl+Shift+K`       | Both             |
| End call (recap)                 | `Ctrl+Shift+E`       | Work             |

---

## 4. Non-Functional Requirements

| Area        | Requirement                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Latency     | Question end (Interview) or status question end (Work) → first answer token < 3 s (p50), < 5 s (p95)             |
| STT lag     | Interim transcript within 500 ms of speech                                                                       |
| CPU         | < 15% average on a 4-core laptop during a session                                                                |
| Memory      | < 400 MB total                                                                                                   |
| Reliability | Survives network drop of up to 30 s without crashing; auto-resumes                                               |
| Security    | Context isolation on, `nodeIntegration` off, strict CSP, all API calls from main process                         |
| Privacy     | No telemetry. Data only leaves device to configured STT/LLM providers                                            |
| Install     | Single NSIS installer (`Cue-Setup-<version>.exe`) built with electron-builder; unsigned is fine for personal use |

---

## 5. Architecture

### 5.1 Tech Stack

- **Shell:** Electron (latest stable) + electron-vite
- **UI:** React 18 + TypeScript + Tailwind CSS + Zustand (state)
- **Markdown:** `react-markdown` + `rehype-highlight`
- **Audio:** Web Audio API + AudioWorklet (renderer, hidden capture window)
- **STT:** Deepgram WebSocket (via `@deepgram/sdk` or raw `ws`) from main process
- **LLM:** `@anthropic-ai/sdk` (Anthropic) and plain `fetch` + SSE against OpenAI-compatible chat completions (Groq, OpenRouter, Gemini), all from the main process, streaming
- **DB:** `node:sqlite` (built into Node/Electron)
- **Docs parsing:** `pdf-parse`, `mammoth`
- **Validation:** `zod` for IPC payloads and settings
- **Testing:** Vitest (unit), Playwright for Electron (smoke)
- **Packaging:** electron-builder (NSIS, x64)

### 5.2 Process Layout

```
┌──────────────────────── Main Process ────────────────────────┐
│ SessionManager ── SttService ── QuestionDetector              │
│        │               │                │                     │
│        │               └── transcripts ─┘                     │
│        ├── AnswerService (LlmProvider, prompt builder, cache) │
│        ├── Work: ProjectStore, StatusQuery, Recap (Work Mode) │
│        ├── PracticeService (Interview Mode)                   │
│        ├── ScreenService (desktopCapturer)                    │
│        ├── CostTracker ── Db (SQLite)                         │
│        ├── SettingsStore (safeStorage)                        │
│        └── HotkeyService (globalShortcut)                     │
└───────▲──────────────────▲───────────────────▲───────────────┘
        │ IPC (typed)      │                   │
┌───────┴──────┐  ┌────────┴────────┐  ┌───────┴────────┐
│ Capture Win  │  │ Main Window      │  │ Overlay Window │
│ (hidden)     │  │ (control panel)  │  │ (answers)      │
│ getDisplay-  │  │ React            │  │ React          │
│ Media + mic, │  └──────────────────┘  └────────────────┘
│ AudioWorklet │
└──────────────┘
```

### 5.3 Data Flow (auto-answer)

1. Capture window streams 16 kHz PCM chunks → main via IPC (`audio:chunk`, tagged with source).
2. `SttService` forwards to Deepgram; emits `partial`, `final`, `utteranceEnd`.
3. Transcripts → Main Window (live lanes) and stored in `utterances`.
4. On `utteranceEnd` (Interviewer) → `QuestionDetector` → `{is_question, type, clean_question}`.
5. `AnswerService` builds the prompt, attaches screenshot if pending, streams tokens → Overlay via `answer:token`.
6. On completion, store `qa_pairs` and usage; update `CostTracker`.

Work Mode differs at steps 4–5: the status classifier (§6.6) returns `{is_status_question, project_hint}`; the hint is matched against the project store (FR-W5) — or the overlay shows a quick-pick — and `StatusQueryService` builds the §6.5 prompt from that project's context. "End call" sends the whole transcript to `RecapService` (§6.8) and appends the result to the matched projects.

### 5.4 Suggested Repo Structure

```
cue/
├─ electron.vite.config.ts
├─ package.json
├─ config/pricing.json
├─ src/
│  ├─ main/
│  │  ├─ index.ts
│  │  ├─ windows/{mainWindow,overlayWindow,captureWindow}.ts
│  │  ├─ services/
│  │  │  ├─ session/SessionManager.ts
│  │  │  ├─ stt/{SttProvider.ts,SocketSttProvider.ts,DeepgramProvider.ts,AssemblyAIProvider.ts,TranscriptAssembler.ts}
│  │  │  ├─ detect/QuestionDetector.ts
│  │  │  ├─ llm/{LlmProvider.ts,AnthropicProvider.ts,OpenAICompatProvider.ts,LlmRouter.ts,Cooldowns.ts,prompts.ts}
│  │  │  ├─ answer/{AnswerService.ts,CopilotService.ts}
│  │  │  ├─ screen/ScreenService.ts
│  │  │  ├─ cost/{CostTracker.ts,pricing.ts}
│  │  │  ├─ history/{HistoryService.ts,markdown.ts}
│  │  │  ├─ profile/ProfileService.ts
│  │  │  ├─ practice/{PracticeService.ts,practicePrompts.ts}
│  │  │  ├─ work/{ProjectStore.ts,projectMatch.ts,WorkDetector.ts,workQuestions.ts,ProjectCondenser.ts,workPrompts.ts,teamsImport.ts,RecapService.ts}
│  │  │  ├─ teams/{TeamsGraph.ts,TeamsSync.ts}   # Microsoft Graph sign-in + sync (FR-T3)
│  │  │  └─ hotkeys/HotkeyService.ts
│  │  ├─ db/db.ts               # connection + migrations
│  │  ├─ tray.ts                # system tray (FR-M1)
│  │  ├─ dataDir.ts             # %APPDATA%/Cue + move from InterviewCopilot
│  ├─ (scripts/mock-teams.mjs)    # local Microsoft Graph + sign-in mock (FR-T5)
│  │  └─ settings/SettingsStore.ts
│  ├─ preload/index.ts          # typed contextBridge API
│  ├─ shared/{ipc.ts,channels.ts,settings.ts,profile.ts,history.ts,practice.ts,work.ts}  # zod schemas + channel names
│  └─ renderer/
│     ├─ main/    # control panel React app (tabs/ incl. ProjectsTab)
│     ├─ overlay/ # overlay React app
│     └─ capture/ # hidden capture page + audio-worklet.ts
└─ tests/
```

---

## 6. Prompts

### 6.1 Interview Mode — Answer System Prompt (cacheable block)

```
You are a real-time interview assistant helping {name} answer questions
for a {role} role at {company}. Answers are read at a glance during a
live conversation.

Rules:
- Lead with the answer. No preamble, no restating the question.
- Keep it scannable: short bullets, bold key terms, max ~120 words
  unless the question is coding or system design.
- Speak in first person as the candidate, using their real experience
  from the resume below. Never invent employers, titles, or metrics.
  If the resume has nothing relevant, give a strong general answer and
  mark it "(general)".
- Behavioral: STAR format, one bullet each for S, T, A, R.
- Follow-ups — questions about an earlier question in <earlier_qa> —
  get a detailed answer about that specific problem (~150–300 words).
  Never answer a follow-up generically.
- Coding: first explain the problem in my own words, then three
  versions in order — pseudocode, a brute-force solution with its
  (poor) time/space complexity, then the optimal solution with its
  complexity. Code in {preferredLanguage} with brief comments.
  (codingAnswer = "direct": 2-3 bullet approach, time/space complexity, then clean code
  in {preferredLanguage} with brief comments.)
- System design: requirements → components → data flow → trade-offs.
- If a screenshot is attached, use it as the primary source for the
  problem statement.
- If the transcript is garbled, answer the most likely intended question
  and show your interpretation in one italic line at the top.

<resume_summary>{resumeSummary}</resume_summary>
<job_description_summary>{jdSummary}</job_description_summary>
<candidate_notes>{notes}</candidate_notes>
```

### 6.2 Interview Mode — Question Classifier Prompt (fastModel)

```
Classify the interviewer's latest utterance. Return ONLY JSON:
{"is_question": boolean,
 "type": "behavioral|technical|coding|system_design|situational|smalltalk|other",
 "clean_question": "the question rewritten clearly, fixing transcription errors"}

Recent context: {last3Utterances}
Latest utterance: {utterance}
```

Parse defensively: strip code fences, `JSON.parse` in try/catch, validate with zod, fall back to heuristic on failure.

### 6.3 Profile Summary Prompt (fastModel)

Summarize resume into ≤ 400 tokens: roles with dates, top 5 projects with tech stack and measurable outcomes, core skills. Summarize JD into ≤ 200 tokens: must-have skills, responsibilities, company/product context.

### 6.4 Interview Mode — Practice Feedback Prompt

Given question, candidate transcript, resume and JD: return JSON with `score` (1–10), `strengths[]`, `gaps[]`, `improved_answer` (markdown). The resume/JD go in a cacheable interviewer system block shared with the question and debrief prompts. Parsed defensively (fences stripped, zod-validated, score rounded); an unparseable reply counts as a failed request the user can retry.

### 6.5 Work Mode — Status Answer Prompt (cacheable per-project block)

```
You help {name} give a live, spoken status update on "{projectName}"
during a work call with {audienceHint}. This will be read aloud or
paraphrased immediately, not displayed as notes.

Rules:
- 3-5 natural spoken sentences. No bullets, no headers, no jargon.
- Lead with current state, then recent progress, then any blocker,
  then next step — but phrase it as something a person would actually
  say out loud, not a status-report template.
- Use only the facts in the project context below plus the live call
  transcript. Never invent progress, dates, or numbers.
- If stored context is stale (older than the "last updated" note
  implies it should be), say so briefly rather than presenting it as
  current.

<project_context>{projectSummary}</project_context>
<recent_updates>{projectUpdates}</recent_updates>
<call_transcript_recent>{last2000TokensOfCall}</call_transcript_recent>
```

`{audienceHint}` comes from the project's stakeholders; the call transcript goes after the cacheable project block.

### 6.6 Work Mode — Status Question Classifier (fastModel)

```
Decide if the latest utterance is asking the user for a status/update
on a project or task (not a general question). Return ONLY JSON:
{"is_status_question": boolean,
 "project_hint": "best-guess project name/alias or null"}

Known projects: {projectNamesAndAliases}
Recent context: {last3Utterances}
Latest utterance: {utterance}
```

Parsed defensively like §6.2.

### 6.7 Work Mode — Screen Explain Prompt

```
Explain or summarize what's on screen for {name}, who is presenting
live on a work call about {likelyProjectIfMatched}. Be concise enough
to glance at while talking, not read verbatim.
- 3-6 short bullets: what this shows, the key number/point to call
  out, and anything that invites a follow-up question worth being
  ready for.
- If it's a chart/table, state the headline takeaway first.
- Use project context only if the screenshot clearly matches a known
  project; otherwise work from the screenshot alone.
```

### 6.8 Work Mode — Recap Prompt

```
Summarize this call transcript into:
{"decisions": string[], "action_items": [{"item": string, "owner": string|null}],
 "open_questions": string[]}
Only include things actually said. Keep each item to one line.

<transcript>{fullCallTranscript}</transcript>
```

### 6.9 Work Mode — Condense and Prep Brief (fastModel / answerModel)

- **Condense (fastModel):** rewrite a project's notes and updates into ≤ 150 tokens: status, latest progress, blockers, next step, dates — facts only (FR-W4).
- **Prep brief (answerModel):** for the selected projects, a Markdown one-pager: per project, current status, what changed since the previous update, and 2–3 likely questions with short answers from the stored context (FR-W14).

### 6.10 Work Mode — Teams Import (answerModel; vision models for screenshots)

Given today's date, every project with its items as exact lines under short ids (`P1`, `P1.3`), and the messages (pasted text, screenshots, or synced `[time] Author (in chat): text` lines): return JSON `{"proposals": [{project, item|null, new_item|null {kind,title}, changes {status, owner, waiting_on, environment, due, followed_up, follow_up_note, blockers, ref — only those the message changes}, update (one line, third person, naming who said it), author, time, quote}], "skipped": [{author, quote, reason}]}`. Rules: only what the messages say; "picking up / assigned to me" → owner + in progress; "fixed and merged / deployed to prod / approved / signed off" → done (a fix in review stays in progress); "waiting on X" → waiting; "pinged / chased X" → follow-up date and note; relative dates from the message time; unclear item → the project; skip small talk. Parsed defensively: unknown ids, kinds and invalid fields are dropped individually; a reply that isn't JSON fails the import with a retry message.

---

## 7. IPC Contract (typed, in `src/shared/ipc.ts`)

| Channel                                                                 | Direction                           | Payload                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `audio:chunk`                                                           | capture → main                      | `{ source: 'loopback'                                                                                                     | 'mic', pcm: ArrayBuffer, ts }` |
| `audio:level`                                                           | capture → main window               | `{ source, rms }`                                                                                                         |
| `transcript:update`                                                     | main → windows                      | `{ source, text, isFinal, ts }`                                                                                           |
| `question:detected`                                                     | main → overlay                      | `{ id, question, type }`                                                                                                  |
| `answer:token`                                                          | main → overlay                      | `{ id, delta }`                                                                                                           |
| `answer:done`                                                           | main → overlay                      | `{ id, usage }`                                                                                                           |
| `answer:error`                                                          | main → overlay                      | `{ id, message }`                                                                                                         |
| `session:start/stop`                                                    | main window → main                  | `{ mode }`                                                                                                                |
| `session:state`                                                         | main → windows                      | `{ status, elapsed, cost }`                                                                                               |
| `screen:capture`                                                        | any → main                          | `{ displayId? }`                                                                                                          |
| `settings:get/set`                                                      | main window ↔ main                  | zod-validated settings                                                                                                    |
| `answer:ask`                                                            | overlay → main                      | `{ text }` (typed question)                                                                                               |
| `voice:set`                                                             | overlay → main                      | `{ on }` (voice questions)                                                                                                |
| `capture:mic`                                                           | main → capture                      | `{ on, deviceId }`                                                                                                        |
| `qa:list` / `qa:reset`                                                  | overlay ↔ main                      | Q&A snapshot / new session                                                                                                |
| `screen:capture` / `screen:add` / `screen:answer`                       | overlay → main                      | screenshot + answer / add one (≤ max) / answer from the waiting ones                                                      |
| `screen:clear`                                                          | overlay → main                      | `{ index? }` remove one waiting screenshot, or all                                                                        |
| `screen:pending`                                                        | main ↔ overlay                      | `{ thumbs: string[] }` waiting screenshots                                                                                |
| `screen:displays`                                                       | main window → main                  | displays for the picker                                                                                                   |
| `cost:update` / `cost:get`                                              | main → windows                      | `{ usd, capUsd, status, sttSeconds, tokens, unpriced }`                                                                   |
| `cost:openPricing`                                                      | main window → main                  | open the user's pricing.json                                                                                              |
| `history:list/get/delete/deleteAll/export`                              | main window → main                  | sessions, one session, Markdown save dialog                                                                               |
| `overlay:notice`                                                        | main → overlay                      | one-off message (hotkey failure, cost cap, STT keeps disconnecting)                                                       |
| `practice:state`                                                        | main ↔ main window                  | `PracticeState` (status, round, items with answer/feedback, current, live text, summary, average)                         |
| `practice:start`                                                        | main window → main                  | `{ round, count }`                                                                                                        |
| `practice:record/finishAnswer/submit/retry/redo/skip/next/finish/reset` | main window → main                  | record / stop + feedback / typed `{ text }` / retry feedback / answer again / skip / next / end + debrief / back to start |
| `app:info` / `app:deleteAllData`                                        | main window → main                  | version + data folder / confirm, wipe, restart (FR-D5)                                                                    |
| `work:projects` / `work:projectsChanged`                                | main window ↔ main                  | all projects with tasks and recent updates; pushed after every change                                                     |
| `work:projectSave/projectDelete/taskSave/taskDelete`                     | main window → main                  | project / task fields (zod: `ProjectInputSchema`, `TaskInputSchema`), `{ id }` (FR-W1–W2)                                  |
| `work:updateAdd` / `work:updateDelete`                                  | main window → main                  | `{ projectId, text }` log an update (FR-W3) / `{ id }`; the overlay logs updates via `answer:ask` ("update X: …")           |
| `work:pick`                                                             | main → overlay                      | `{ question, projects[{ id, name, status }], suggestedId, ts }` status quick-pick (FR-W6, FR-W9)                           |
| `work:status`                                                           | overlay → main                      | `{ projectId, question? }` generate a status update                                                                       |
| `work:endCall` / `work:recap`                                           | main window → main / main → windows | end the call + recap / recap result (FR-W13)                                                                              |
| `work:brief`                                                            | main window → main                  | `{ projectIds }` → Markdown prep brief (FR-W14)                                                                           |
| `work:import`                                                           | main window → main                  | `{ text }` or `{ images: dataURL[] }` → `{ ok, proposals, skipped }` (FR-T1/T2)                                            |
| `work:proposals` / `work:proposalsChanged`                              | main window ↔ main                  | proposals waiting for review (FR-T4)                                                                                      |
| `work:proposalDecide`                                                   | main window → main                  | `{ id, action: accept\|skip, edits? }` → the proposal (FR-T4)                                                              |
| `teams:status` / `teams:signIn` / `teams:openSignIn` / `teams:cancelSignIn` / `teams:signOut` / `teams:sources` / `teams:syncNow` | main window ↔ main | Teams sync state (account, sign-in code, last sync, error), device-code sign-in, chats/channels to follow, sync now (FR-T3); tokens never leave the main process |

All handlers validate payloads with zod.

---

## 8. Settings Schema (defaults)

```json
{
	"mode": "work",
	"stt": {
		"provider": "deepgram",
		"model": "nova-3",
		"assemblyaiModel": "universal-streaming-english",
		"language": "en",
		"endpointingMs": 300,
		"utteranceEndMs": 1000
	},
	"llm": {
		"provider": "groq",
		"fallbackProviders": ["openrouter", "gemini"],
		"visionProvider": "auto",
		"answerModel": "claude-sonnet-5-5",
		"fastModel": "claude-haiku-4-5-20251001",
		"groq": {
			"answerModel": "openai/gpt-oss-120b, …",
			"fastModel": "openai/gpt-oss-20b, …",
			"reasoningEffort": "low"
		},
		"openrouter": {
			"answerModel": "<Free preset>",
			"fastModel": "<Free preset>",
			"reasoningEffort": "low"
		},
		"gemini": {
			"answerModel": "gemini-3.8-flash, …",
			"fastModel": "gemini-3.1-flash-lite, …",
			"reasoningEffort": "minimal"
		},
		"visionModel": "claude-sonnet-5-5",
		"…": "each provider block also has visionModel (Groq: qwen/qwen3.8-27b)",
		"maxTokens": 600,
		"maxTokensCoding": 3000,
		"codingAnswer": "stepwise"
	},
	"detection": {
		"autoAnswer": true,
		"minWords": 6,
		"debounceMs": 2000,
		"pauseGraceMs": 1500
	},
	"screen": {
		"alwaysInclude": false,
		"displayId": null,
		"maxEdgePx": 1600,
		"maxScreenshots": 5
	},
	"overlay": {
		"opacity": 0.9,
		"fontSize": 15,
		"theme": "dark",
		"view": "single",
		"preferredDisplayId": null
	},
	"cost": { "sessionCapUsd": 5 },
	"practice": {
		"round": "mixed",
		"count": 5,
		"speak": true,
		"voice": null,
		"rate": 1,
		"autoRecord": true
	},
	"work": {
		"teams": {
			"clientId": "",
			"tenant": "organizations",
			"authorityUrl": "https://login.microsoftonline.com",
			"graphBaseUrl": "https://graph.microsoft.com",
			"sources": [],
			"pollMinutes": 5,
			"includeChannels": false,
			"enabled": true
		}
	},
	"preferredLanguage": "TypeScript",
	"keepScreenshots": false
}
```

`mode` is `work` or `interview` (settings saved before v2.0 start in `interview`). `stt.provider` is `deepgram` or `assemblyai`; `model` is the Deepgram model. Model IDs must be editable strings in the UI so they can be updated without code changes. Top-level `answerModel`/`fastModel` are the Anthropic slots (kept there for settings saved before other providers existed). API keys (Deepgram, AssemblyAI, Anthropic, OpenRouter, Groq, Gemini) are stored encrypted, never in this file.

---

## 9. Error Handling

- Missing API key → block session start, deep-link to Settings (an LLM key for the main or any backup provider is enough).
- STT disconnect → status dot amber, auto-reconnect (FR-S4), overlay notice after 3 consecutive failures and on recovery.
- A renderer crash → logged and the window reloaded; if the hidden capture page crashes, the live session (or practice recording) stops with "Audio capture crashed — start again".
- LLM 429/529 (or 502/503 from OpenRouter) → next model in the chain / next backup provider (FR-G9); then retry once after 1 s, then fall back to `fastModel`. Models and providers on cooldown are skipped without a request.
- Provider error messages name the upstream and its reason (e.g. "Google AI Studio: …rate-limited upstream"); OpenRouter data-policy blocks point to openrouter.ai/settings/privacy.
- LLM stream error mid-answer → keep partial text, show "⚠ incomplete — Ctrl+Shift+R to retry".
- Screenshot with no vision model configured on any keyed provider → "No screenshot-capable model is set up" (Settings → Answers). Screenshot capture failure → overlay notice; with "always include", the answer goes ahead without the image.
- Invalid user `pricing.json` → log a warning and use the bundled prices.
- No loopback audio for 20 s while session active → hint: "No system audio detected — check output device."
- Work Mode: status hotkey with no projects → overlay notice pointing to the Projects tab; no confident project match → quick-pick (FR-W9); recap failure → transcript kept, retry from History (FR-W13).
- Teams import/sync: a failed or unreadable model reply → "try again" (sync: messages stay unread and are retried next time); Graph 401 → one token refresh, then "sign in again"; 403 → which permission the organisation hasn't allowed; 429 → retried on the next check; personal/free Teams accounts → pointed to paste/screenshot.
- All errors logged to `%APPDATA%/Cue/logs/` with keys (and the Teams token) redacted.

---

## 10. Build Phases & Acceptance Criteria

Phases 1–4 built Interview Mode (as _Interview Copilot_, v1.0). Work Mode, added in v2.0, follows as Phases 5–6; shared pieces it needs (screenshots, cost, history, installer) already exist.

### Phase 1 — Skeleton & audio (MVP foundation)

- Electron + React + TS scaffold, three windows, typed preload bridge.
- Settings with encrypted API keys.
- Loopback capture + level meter; Deepgram streaming; live transcript in main window.
- **Accept:** Play a YouTube video → transcript appears within 1 s of speech.

### Phase 2 — Answers

- Question detector (heuristic + classifier), AnswerService with streaming, overlay rendering, hotkeys for answer-now/regenerate/hide.
- Profile tab with resume/JD upload and summaries; prompt caching.
- **Accept:** Play a recorded mock-interview question → overlay shows first tokens < 3 s after it ends; answer references resume projects.
- Added during Phase 2 at the user's request (§14): OpenRouter/Groq/Gemini providers with model chains and failover, overlay ask bar (typed + voice questions), list layout, mid-sentence pause handling.

### Phase 3 — Screen, cost, history

- Screenshot hotkey + vision input, thumbnail in overlay.
- CostTracker with pricing.json, cost cap behavior.
- SQLite history, session review, Markdown export.
- **Accept:** Open a LeetCode problem, press `Ctrl+Shift+S` → overlay shows approach, complexity and working code; session appears in History with correct cost.
- Done 2026-10-02: a "Two Sum" page captured via the overlay camera button was answered by Groq `qwen3.8-27b` in ~2.2 s with approach, complexity and TypeScript code; the session appeared in History with both Q&As and $0.00 (free tier).

### Phase 4 — Practice mode & polish

- Practice flow with TTS questions, mic recording, feedback, summary.
- Mic lane in transcript, AssemblyAI provider, error-handling polish, installer.
- **Accept:** Complete a 5-question practice run end to end; installer produces a working `.exe`.
- Done 2026-10-02: Practice Mode (FR-P1..P4), AssemblyAI provider (FR-S3), shared STT reconnect base with 8 retries and a disconnect notice, renderer-crash recovery, Delete all data (FR-D5), installer `InterviewCopilot-Setup-1.0.0.exe` (per-user NSIS, app icon, shortcuts). The mic lane ("Me") was already in the transcript since Phase 2. Verified: 273 unit/integration tests incl. a full 5-step practice flow against a scripted LLM; the packaged `win-unpacked` app launches, renders every Practice state, saves/reads practice history and blocks practice without a resume or LLM key. A live 5-question run against real providers is left to the user (their running dev instance held the single-instance lock).

### Phase 5 — Work Mode: modes, project store & status queries

- Mode switch (FR-MD1–MD3), mode-aware lanes, history filter and settings (`mode`). App renamed to Cue (done 2026-10-02: product name, installer `Cue-Setup-<version>.exe`, data folder `%APPDATA%/Cue` with a one-time move from `InterviewCopilot`).
- Projects tab: Projects/Tasks CRUD (FR-W1–W5), quick-update box, condensing; DB migration for `projects`, `tasks`, `project_updates`.
- Manual status query (hotkey quick-pick) and auto-detect status classifier (FR-W6–W10).
- Overlay renders spoken-ready status answers; streaming.
- **Accept:** Create a project with notes, play a recording of someone asking "what's the status of \<project\>?" → overlay produces an accurate spoken-style summary < 3 s after the question ends.
- Built 2026-10-02: mode switch (Session tab, locked while a session runs; overlay badge; "Call" lane; History filter and Work badge; fresh installs start in Work, saved settings from before modes keep Interview), Projects tab (projects, tasks, dated updates, background condensing with a "what answers use" card), local fuzzy project matching (name/alias as-is, partial names, word forms, one-letter transcription slips; ambiguous → quick-pick), `WorkDetector` (status cues + confident match answer without an LLM call; unclear cues or project mentions go to the §6.6 classifier; plain call talk is never sent), overlay quick-pick (`Ctrl+Shift+Space` / **Status**, keyboard 1–9 ↑↓ Enter Esc), ask-box commands `status <project>` and `update <project>: …`, typed/voice work questions answered with the context of the projects they mention, and — ahead of Phase 6 — screen explain (FR-W11) through the Work prompt. Status answers aren't cache-pre-warmed (the prompt depends on the project). Verified: 304 unit/integration tests (27 new: matching, store, prompts, detector, Work-mode copilot flow, condensing, settings migration, Work history); the built app driven with an isolated empty profile: project created through the form, task and update added, quick-pick shown and dismissed, overlay commands, status request reaching the provider step (no key → "Add your Groq API key"), mode switch, Work session in History, no renderer errors. **Not yet run:** the acceptance test itself — a recorded status question against real STT and LLM keys.

### Phase 5.1 — Work items and item-level questions

- Work items with kind, owner, waiting on, environment, follow-up, ref and their own updates (FR-W2/W3); open items never condensed (FR-W4); matching on items (FR-W5); item and list answers (FR-W7a/b); typed/voice questions status-checked (FR-W6); different-project speech never merged (FR-W10); stored status stated exactly (FR-W7).
- **Accept:** A "Mobile app" project with a UAT deployment waiting on the MDM team, TOM approvals (2 of 3 signed) and 3 bugs with owners. Spoken "did we follow up with the MDM team to get the app deployed on UAT?", "what's the status of the TOM approvals?" and "which bugs are open and who's working on them?" — each answered about the right item(s), < 3 s; a quick second question about another project gets its own answer.
- Done 2026-10-03: verified live (Windows TTS through the speakers → Deepgram → Groq): the three questions plus "and where are we on the payments migration?" right after were each answered about the right item or project, first token 0.6–0.8 s; a statement mentioning an item ("the TOM approvals came through") got no answer; a typed "what's pending on the TOM approvals?" got the item answer. Found and fixed in testing: a list question about the whole project right after an item question was being merged into it.

### Phase 7 — Team updates from Teams

- Paste and screenshot import with the review queue (FR-T1, T2, T4); local mock Graph server and Teams sync (FR-T3, T5); privacy warning (FR-T6).
- **Accept:** Paste a 20-message chat → correct proposals for status, owner and blockers, applied after review. Screenshots of the same chat give the same proposals. With `npm run mock-teams`, sign in, follow the sample group chat, post a message as a developer on the mock page → a proposal appears within one poll; accepting it changes the spoken status answer.
- Done 2026-10-03 (against the mock; a real tenant still to try): a pasted chat gave owner/status/follow-up proposals and a new-bug proposal in ~2 s (Groq), skipping small talk; pasting it again added nothing; a screenshot of a chat was read by the vision model in ~1.5 s; device-code sign-in, chat list, first sync (4 proposals from 7 messages) and a newly posted message picked up by the next sync. 342 tests, including Graph sign-in, paging, channel replies, token refresh and 403/429 handling against the mock.

### Phase 6 — Work Mode: screen explain, recap, brief, display

- Screenshot hotkey in Work Mode for Explain/Present (FR-W11–W12) — prompt and routing already done in Phase 5; check against real slides.
- Recap (FR-W13) and Prep Brief (FR-W14); Work calls in History and Markdown export with their recap.
- Screen-sharing guidance and `Ctrl+Shift+H` for every setup; display preference + second-monitor default only when 2+ displays are connected (FR-H1–H3); scoped Delete data (FR-D5).
- **Accept:** Share a PPT window, press `Ctrl+Shift+S` on a slide → overlay explains it; end the call → recap with decisions/action items saved to the project. On a single display the display helper is hidden and the overlay stays put.

---

## 11. Testing

- Unit (Vitest): QuestionDetector heuristics, classifier JSON parsing, prompt builder, CostTracker math, settings schema; Work Mode: project fuzzy matching, status classifier and recap parsing, condensing triggers, data-folder move.
- Integration: mock `SttProvider` and `LlmProvider` emitting scripted events to test SessionManager end to end without network.
- Fixtures: `tests/fixtures/*.wav` with sample questions for manual latency testing.
- Smoke (Playwright Electron): app launches, settings save, session start/stop with mocks.

---

## 12. Instructions for Claude Code

1. Build phase by phase; stop after each phase to run tests and confirm acceptance criteria.
2. Keep providers behind interfaces so STT/LLM vendors are swappable.
3. All network calls in the main process; renderer never sees API keys.
4. Check current SDK docs for Deepgram, Anthropic and Electron's `setDisplayMediaRequestHandler` loopback audio before implementing — APIs change.
5. Prefer small, readable modules; add a `README.md` covering setup, API keys, hotkeys and building the installer.
6. Measure and log latency at each stage (utteranceEnd → classifier done → first token) to a debug panel in Settings.
7. Keep one pipeline for both modes: modes plug in their own context source, detector settings and prompts; don't fork capture, STT, the overlay or the LLM router.

---

## 13. Enterprise Edition (SaaS)

Everything above describes the single-user, local-first desktop app. This section specifies **Cue Enterprise**: the same assistant offered to companies as a subscription, used by every employee, with company sign-in, shared project context, server-side Teams/Jira ingestion, central administration and billing. Where this section and §1–§12 differ, this section wins for the Enterprise Edition; the personal desktop app keeps working as specified above.

### 13.1 Positioning

- **For:** companies on Microsoft 365 / Teams whose employees are asked for status updates in calls — engineering managers, project and delivery managers, team leads, and the developers who report to them.
- **Value:** every employee gets a personal assistant that knows their projects and work items, keeps them current from the team's Teams chats (and later Jira / Azure DevOps), and gives ready-to-say status answers live in calls, plus recaps and pre-call briefs.
- **Alternatives buyers compare against:** Microsoft Copilot in Teams, Otter, Fireflies, Read.ai. Cue's difference: per-person project and item memory kept current from chats, and live spoken status answers in under 3 seconds — not only post-meeting notes.

### 13.2 Scope

- **In:** Work Mode (§3.10, including work items, Teams updates and the review queue), screen explain, recap and brief, history, cost tracking.
- **Out:** **Interview Mode and Practice** (§3.3, §3.9) are not part of the Enterprise Edition; they remain in the personal app or a separate consumer product.
- **Out — never:** features that hide the app or overlay from screen sharing, recording or proctoring tools, and auto-typing into other apps. Enterprise security reviews reject such features, Microsoft's store policies don't allow them, and call-recording laws require participants to know they are being transcribed. The Enterprise Edition does the opposite (FR-E30–E32). *(Note: §1.1 currently lists hiding the overlay under Goals for the personal app; for the Enterprise Edition it is explicitly a non-goal.)*

### 13.3 Users and roles

| Role | Who | Can |
| --- | --- | --- |
| Employee | Anyone with a Cue licence | Use the desktop app; own personal projects; see shared projects of their teams; review Teams suggestions for their projects |
| Team lead | Owner of a team's shared projects | Everything an employee can; manage shared projects, their items and members; choose the team's chats/channels to ingest |
| Tenant admin | IT / the buyer | Approve Cue for the organisation; assign licences; set policies (FR-E40); see usage, cost and audit logs; export or delete data |
| Cue operator | Us | Run the service; no access to customer content except through an audited, customer-approved support session |

### 13.4 Functional requirements

#### Identity and tenancy

- **FR-E1:** Sign-in with the company's Microsoft account (Entra ID, OpenID Connect) from the desktop app and the web admin console. No Cue passwords.
- **FR-E2:** Cue is a **multi-tenant Entra application**. A tenant admin grants consent once for the organisation (delegated sign-in plus the application permissions needed for server-side ingestion, FR-E10); employees then just sign in.
- **FR-E3:** User provisioning: just-in-time on first sign-in (if the admin allows), and SCIM 2.0 from Entra for automatic add/remove (Phase E2). A removed user loses access immediately; their personal data is kept for the retention period, then deleted.
- **FR-E4:** Every record carries a `tenant_id`; data is isolated per tenant (Postgres row-level security plus tenant-scoped encryption keys). No cross-tenant queries outside operator tooling.

#### Shared project context

- **FR-E5:** Projects can be **personal** or **shared with a team**. Shared projects and their items, updates and suggestions are visible to the team's members; status answers for a shared project use everyone's accepted updates.
- **FR-E6:** Teams in Cue map to Entra groups or Teams teams (synced), or are created manually by a team lead.
- **FR-E7:** The desktop app keeps a local, encrypted cache of the user's projects so status answers stay fast (< 3 s) and work through short network drops; changes sync both ways, last-write-wins per field with an update log.

#### Ingestion (Teams, then Jira / Azure DevOps)

- **FR-E10:** **Server-side Teams ingestion** replaces per-PC polling (FR-T3): with tenant-wide application permissions (`ChannelMessage.Read.All`, `Chat.Read.All` or resource-specific consent per team/chat), the service subscribes to **Microsoft Graph change notifications** for the chats and channels each team lead selects, and fetches new messages as they arrive. Admin policy (FR-E40) limits which chats can ever be read.
- **FR-E11:** Extraction and the **review queue** work as in FR-T1–T4, server-side: suggestions go to the owner of the matched project (or the team lead for shared projects); nothing changes until a person accepts it. Optionally, a team lead can auto-accept low-risk changes (e.g. a status change stated by the item's owner).
- **FR-E12:** **Jira and Azure DevOps connectors** (Phase E2): link a project to a board/area path; issues become work items (kind bug/task, status, assignee, due date) and stay in sync. Teams messages about a linked issue update its Cue item; Cue never writes back to the tracker unless a tenant admin enables it.
- **FR-E13:** Paste and screenshot import (FR-T1/T2) remain available to every user.

#### AI and speech services

- **FR-E20:** An **LLM gateway** in the service holds all model keys; desktop apps never see them. Tenants choose a model policy: Cue-managed providers under zero-data-retention / no-training agreements, or **their own Azure OpenAI** deployment (data stays in their tenant). Free-tier providers are not used.
- **FR-E21:** The gateway does routing and failover (FR-G9), prompt caching, per-tenant and per-user rate limits, and **metering** (tokens and cost per request, per user, per tenant).
- **FR-E22:** Speech-to-text: the service issues **short-lived STT tokens** (Deepgram / AssemblyAI temporary keys) and the desktop app streams audio directly to the STT provider, so latency stays as today. Audio is never stored; transcripts are stored only as session history under the tenant's retention policy.
- **FR-E23:** Region: tenants pick EU or US at onboarding; data, model calls (where the provider supports regions) and backups stay in that region.

#### Desktop client management

- **FR-E25:** Code-signed installer (EV certificate — no SmartScreen warning) and an **MSI** for silent deployment through Intune / SCCM; per-machine or per-user install.
- **FR-E26:** Auto-update (staged rollout; admins can pin a version channel).
- **FR-E27:** Managed configuration: admins push policy (FR-E40) and defaults; users can't override what policy locks. Personal API-key settings (§8 `llm.*` keys) are hidden in the Enterprise Edition.
- **FR-E28:** macOS client (Phase E3); a **Teams app with an in-meeting side panel** as a no-install alternative to the overlay (Phase E3).

#### Transparency and consent

- **FR-E30:** While Cue transcribes a call, it is **visible**: the overlay and tray show a listening indicator, and the tenant can require an automatic chat message or meeting notice ("Omkar is using Cue to transcribe this call").
- **FR-E31:** Policy option to require participant consent per meeting (or for external participants only), and to block transcription in meetings with external guests.
- **FR-E32:** Per-meeting opt-out: anyone can ask the user to stop; one click stops transcription and discards the session.

#### Administration

- **FR-E40:** **Policies** per tenant: allowed models/providers and region; which Teams chats/channels may be ingested (allow/deny lists, external chats off by default); transcription rules (FR-E30–E32); retention (transcripts, suggestions, updates — e.g. 30/90/365 days); whether screenshots may be taken and kept; Jira/ADO write-back; auto-accept rules.
- **FR-E41:** **Admin console** (web): licences and users, teams, policies, connectors, usage and cost dashboards (per user/team/month), audit log, data export (per user or tenant) and deletion.
- **FR-E42:** **Audit log** of admin actions, sign-ins, policy changes, ingestion subscriptions, data exports and deletions, and any operator support access; exportable to the customer's SIEM (Microsoft Sentinel / syslog).

#### Billing

- **FR-E45:** Per-seat subscription, monthly or annual, invoiced (Stripe Billing); a free trial per tenant (e.g. 14 days, up to 10 seats).
- **FR-E46:** Included usage per seat (call hours and model tokens); beyond it, either throttling or metered overage, as the tenant chooses. Usage shown in the admin console (FR-E41).

### 13.5 Architecture

```
┌──────────── Desktop app (per employee) ────────────┐        ┌──────── Microsoft 365 ────────┐
│ capture + overlay (as today) · local encrypted cache│        │ Entra ID · Teams · Graph      │
│ status detection + answers (latency-critical path)  │        └──────▲──────────────▲─────────┘
└───────┬───────────────▲──────────────┬──────────────┘               │ OIDC          │ change notifications
        │ STT (direct,   │ sync API     │ LLM requests                 │               │ + message fetch
        │ short-lived    │ (HTTPS)      │                              │               │
        ▼ token)         │              ▼                              │               │
   Deepgram /     ┌──────┴──────────────────────────────────────────────┴───────────────┴──────┐
   AssemblyAI     │ Cue service (per region, multi-tenant)                                       │
                  │  API + auth (Entra OIDC, tenant resolution)                                  │
                  │  Projects/items/updates (Postgres, RLS per tenant)                           │
                  │  Ingestion workers (Graph subscriptions, Jira/ADO sync) → extraction → queue │
                  │  LLM gateway (routing, failover, caching, metering) → providers / Azure OpenAI│
                  │  Admin console (web) · billing · audit log · Key Vault                       │
                  └──────────────────────────────────────────────────────────────────────────────┘
```

- **Hosting:** Azure (buyers are Microsoft 365 shops): Container Apps for the API and workers, Azure Database for PostgreSQL, Service Bus for ingestion jobs, Key Vault, Front Door; one deployment per region (EU, US).
- **Code reuse:** the pure-TypeScript parts of the desktop app — prompts (§6), project/item matching, the work detector, Teams extraction and the review-queue logic — move to a shared package used by both the desktop app and the service.
- **Latency path stays local:** detection, matching and prompt building run in the desktop app against the local cache; only the model call goes through the gateway (one extra hop, target < 150 ms added).

### 13.6 Deployment models

- **Single-tenant in the customer's Azure** (pilots and regulated customers): the service is deployed into the customer's subscription from a template; data and model calls never leave their tenant. Easiest security approval; higher support cost.
- **Multi-tenant SaaS** (default once past pilots): shared regional deployments with tenant isolation (FR-E4).

### 13.7 Security and compliance

- Encryption in transit (TLS 1.2+) and at rest (tenant-scoped keys in Key Vault; customer-managed keys as an option).
- SOC 2 Type II (start the audit window in Phase E2; plan on 6–12 months); ISO 27001 later. Before that: security questionnaire answers (CAIQ), an annual third-party pen test, and a public trust page.
- GDPR / UK GDPR / CCPA: a data processing agreement, a sub-processor list, EU data residency, data-subject export and deletion.
- AI providers under zero-data-retention / no-training terms, or the customer's own Azure OpenAI.
- Microsoft: publisher verification for the Entra app; Microsoft 365 App Compliance (publisher attestation, then certification) for the Teams app listing.
- Least-privilege Graph permissions, resource-specific consent where possible, and a documented reason for every permission.

### 13.8 Non-functional requirements (Enterprise)

| Area | Requirement |
| --- | --- |
| Availability | 99.9% monthly for the service; the desktop app keeps answering from its cache during outages (degraded: no new ingestion) |
| Latency | Status answer first token < 3 s p50 / < 5 s p95, as §4; gateway overhead < 150 ms |
| Ingestion | A Teams message appears as a suggestion within 2 minutes |
| Scale | 10,000 users per tenant; 100 tenants per region at launch |
| Recovery | RPO 15 min, RTO 4 h; daily backups kept 35 days, in-region |
| Support | Business-hours support; P1 response within 4 h for paid plans |

### 13.9 Pricing (working assumption)

- Variable cost per active user: speech-to-text + models ≈ **$0.50–2 per hour of calls** on paid models (§1.1), plus ingestion extraction (a few cents per user per day).
- Market price in this category is roughly **$15–30 per user per month**; a working plan is a per-seat price in that range with included call hours, and an enterprise tier (single-tenant deployment, customer-managed keys, SSO/SCIM, SIEM export) priced per contract.
- To validate with the pilot customer before committing.

### 13.10 Build phases

#### Phase E1 — Pilot (one customer, ~6–8 weeks)

- Single-tenant deployment in the customer's Azure (§13.6); Entra sign-in (FR-E1/E2); projects, items and updates on the server with the desktop cache (FR-E5, E7); server-side Teams ingestion for selected chats/channels with the review queue (FR-E10/E11); LLM gateway with the customer's Azure OpenAI (FR-E20/E21); STT tokens (FR-E22); signed installer + MSI (FR-E25); listening indicator (FR-E30); a minimal admin page (users, chats allow-list, retention).
- **Accept:** 10–20 employees of the pilot customer use Cue in real status calls for two weeks; status answers about real projects are rated accurate in ≥ 80% of sampled cases; Teams messages from the team's chat become suggestions within 2 minutes; the customer's security team approves the deployment.

#### Phase E2 — Multi-tenant SaaS

- Multi-tenant deployment per region (FR-E4, E23); SCIM (FR-E3); admin console, policies and audit log (FR-E40–E42); billing and trial (FR-E45/E46); Jira and Azure DevOps connectors (FR-E12); consent options (FR-E31/E32); auto-update channels (FR-E26/E27); start SOC 2.
- **Accept:** a new company can sign up, consent, invite users, connect a Teams chat and get suggestions without our help; usage and cost per user are visible to its admin.

#### Phase E3 — Reach

- Teams app with an in-meeting side panel and AppSource listing (FR-E28); macOS client; web app for review and briefs; SOC 2 Type II report.

### 13.11 Open questions

- Which company is the pilot customer, and do they need single-tenant deployment?
- Which chats should be readable by default — team channels only, or also group chats? (Private one-on-one chats are sensitive; default off.)
- Auto-accept: allowed at all, and for which changes?
- Pricing and included call hours — to set after the pilot's usage data.
- Does the Interview Mode product continue separately, and under which brand?

---

## 14. Change Log

User-requested changes after v1.0. Each entry lists what changed and where it is specified. Entries before v2.0 use the old section numbers (Storage was §3.10, Hotkeys §3.11); entries before v2.1 call the Change Log §13.

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Sections                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-03 | **v2.1 — Enterprise Edition (SaaS) section added** at the user's request: a subscription product for companies, used by every employee. Work Mode only (Interview Mode and Practice out; hiding the overlay explicitly a non-goal, transparency required); company sign-in, shared team projects, server-side Teams and Jira/ADO ingestion, LLM gateway, admin console and policies, billing, compliance, deployment models, phases E1–E3. | §13 (new), Change Log renumbered to §14 |
| 2026-10-03 | Built Phases 5.1 and 7. Decided while building: Teams sync needs the organisation's own app registration (client ID + tenant), channels are opt-in (admin consent), the first sync reads the last 24 h, raw messages aren't stored (FR-T6 simplified), duplicates (same message, same bug) are merged, and no overlay hotkey for imports. | FR-T1–T6, §5.4, §6.10, §7, §8, §9, §10 |
| 2026-10-02 | Work items and Teams updates (user request: projects have many separately-asked items — deployments, approvals, bugs with owners — and developers report status in Teams). Items get kind, owner, waiting on, environment, follow-up and their own updates; item-level and list questions; typed questions status-checked; different-project questions never merged (bug found in testing); exact stored status in answers. Teams: paste and screenshot import with review (works with personal Teams), Graph sync for work accounts, and a local mock Graph server to simulate the enterprise tenant. Jira/Azure DevOps later. | FR-W2–W10, FR-W7a/b, §3.10.6 (FR-T1–T6), §10 Phases 5.1 and 7 |
| 2026-10-02 | Phase 5 built (Work Mode: modes, Projects tab, status questions, quick-pick). Decided while building: typed `status <project>` / `update <project>: …` commands in the overlay; the Projects tab stays reachable in Interview Mode; a status question whose project is ambiguous shows the quick-pick instead of answering; fresh installs default to Work, earlier settings keep Interview. | FR-MD1, FR-W3, FR-W5, FR-W6, FR-W9, §7, §10 |
| 2026-10-02 | Second-display features apply only with 2+ displays (the user has one): the "move overlay to another display" helper and the first-run second-display default are hidden/skipped on a single display; share-a-window guidance and `Ctrl+Shift+H` are the single-display path; overlay falls back to the primary display if its display disconnects.                                                                                                                                                                                                                                                                                                         | FR-H1–H3, §10 Phase 6                                                                                                                                         |
| 2026-10-02 | **v2.0 — app renamed to Cue; Work Mode added** (merged from the Cue PRD draft v1.1). Two modes per session: Work (default; project/task store, spoken-ready status updates on request or auto-detected, screen explain while presenting, post-call recap, pre-call brief) and Interview (everything built so far, incl. Practice). New Projects tab, `Ctrl+Shift+E` End call, guidance for keeping the overlay off a shared screen, Work prompts, IPC and tables; Phases 5–6. Rename implemented: product/installer name, window titles, tray, data folder `%APPDATA%/Cue` (old folder moved on first start), `CUE_DATA` replaces `INTERVIEW_COPILOT_DATA`. | §1, §2, §3.0, FR-A2, FR-A3, §3.3, FR-SC2, FR-G3, FR-G6, §3.7, FR-C1, §3.9, §3.10–3.13, FR-D1, FR-D2, FR-D5, §4, §5.2–5.4, §6.5–6.9, §7, §8, §9, §10, §11, §12 |
| 2026-10-02 | OpenRouter added as an LLM provider alongside Anthropic, selectable in Settings without restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | FR-G1, §5.1, §8                                                                                                                                               |
| 2026-10-02 | Free OpenRouter models for building/testing without credits; "Free" and "Claude" presets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | FR-G2                                                                                                                                                         |
| 2026-10-02 | Model fallback chains (up to 12 per slot) with per-model cooldowns; free OpenRouter chains end with `openrouter/free`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | FR-G2, FR-G9                                                                                                                                                  |
| 2026-10-02 | Groq and Google Gemini added (free tiers); main + ordered backup providers with automatic failover when one is rate-limited or out of quota.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | FR-G1, FR-G9, §8, §9                                                                                                                                          |
| 2026-10-02 | **Groq is the default provider** (OpenRouter free models were slow; Gemini slower still — kept as last backup). Supersedes the v1.0 Anthropic default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | FR-G1, §8                                                                                                                                                     |
| 2026-10-02 | Overlay ask bar: type a question, or toggle the mic to ask by voice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | U11, FR-A3, FR-O7, §3.11, §7                                                                                                                                  |
| 2026-10-02 | Overlay list layout: all Q&As in one scroll, alongside one-at-a-time with ‹ ›.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | U12, FR-O8                                                                                                                                                    |
| 2026-10-02 | Show which model/provider produced each answer (overlay and log).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | FR-O9                                                                                                                                                         |
| 2026-10-02 | Handle pauses and varied speaking styles: wait after unfinished sentences, merge speech that resumes within 3 s into the same question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | FR-Q4, FR-Q7, FR-Q8, §8                                                                                                                                       |
| 2026-10-02 | Phase 3 built. A third model slot per provider, **screenshot (vision) models**, because Groq's default models are text-only (Groq vision: `qwen/qwen3.8-27b`); overlay camera button and screenshot thumbnails.                                                                                                                                                                                                                                                                                                                                                                                                                                             | FR-SC1–SC5, FR-G2, FR-G9, §8                                                                                                                                  |
| 2026-10-02 | Cost: bundled `config/pricing.json` with a user copy in `%APPDATA%`; OpenRouter's reported cost wins; free tiers priced at $0; cap 0 = off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | FR-C1–C4                                                                                                                                                      |
| 2026-10-02 | Phase 4: Practice Mode — round/count, personalised questions read aloud, spoken or typed answers, score + feedback + stronger answer, debrief, saved to History and Markdown export. AssemblyAI streaming as a second STT provider (Settings → Speech-to-text). STT reconnects for ~40 s (8 tries) with a notice after 3; crashed windows reload. Settings → Data → Delete all data. NSIS installer with icon and shortcuts; version 1.0.0. `INTERVIEW_COPILOT_DATA` env var for an isolated data folder (testing).                                                                                                                                         | FR-S1, FR-S3, FR-S4, FR-P1–P4, FR-D2, FR-D5, §3.7, §5.4, §6.4, §7, §8, §9, §10                                                                                |
| 2026-10-02 | Close-to-tray (FR-M1). Add-screenshot hotkey moved from `Ctrl+Alt+S` (owned by another app on the user's PC) to `Ctrl+Shift+Alt+S`, with saved settings upgraded and hotkeys another app owns flagged in Settings. Screenshots per question configurable (default 5, max 10; Groq skipped above 3).                                                                                                                                                                                                                                                                                                                                                         | FR-M1, FR-SC6, §3.7, §3.11, §8                                                                                                                                |
| 2026-10-02 | Paid OpenRouter (pay-as-you-go credits) as the fast, cheap route for screenshots, since Groq's Dev Tier is unavailable: "Paid (fast)" preset and a "Screenshots go to" provider setting. Measured: Qwen 3.8 via `:nitro` answers a two-screenshot coding problem in ~2 s for ~$0.004.                                                                                                                                                                                                                                                                                                                                                                       | FR-G2, FR-G9, §8                                                                                                                                              |
| 2026-10-02 | Fix: empty "cut off" screenshot answers. Reasoning models (Groq `qwen` with images, OpenRouter's free-router pick) spent the whole budget thinking; such answers now fail over, and Groq `qwen` screenshots run without thinking.                                                                                                                                                                                                                                                                                                                                                                                                                           | FR-G9                                                                                                                                                         |
| 2026-10-02 | Coding answers start with **Understanding the problem** (restated question, inputs/outputs, constraints, example, edge cases). Answers now carry the last 3 Q&As as context, so follow-ups (e.g. "What did you understand from this question?" after a screenshot) are answered about that problem, in detail.                                                                                                                                                                                                                                                                                                                                              | FR-G6, FR-G7, FR-G11, §6.1                                                                                                                                    |
| 2026-10-02 | Coding answers in three versions — pseudocode → brute force (with its poor complexity) → optimal — because candidates rarely reach the optimal answer first; Shorter = optimal only; setting to turn it off; coding token budget 1,500 → 3,000.                                                                                                                                                                                                                                                                                                                                                                                                             | FR-G6, FR-G7, §6.1, §8                                                                                                                                        |
| 2026-10-02 | Up to 3 screenshots per question (scrolled, long problems), sent together for one answer: `Ctrl+Alt+S` / camera button adds without answering, tray with Answer; DB migration 2 stores several screenshots per Q&A.                                                                                                                                                                                                                                                                                                                                                                                                                                         | FR-SC1, FR-SC5, FR-SC6, §3.11, §7, FR-D2                                                                                                                      |
| 2026-10-02 | History storage uses Node's built-in `node:sqlite` instead of `better-sqlite3` (no native rebuild); profile stays in `profile.json`; Markdown export and delete in the History tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | FR-D1, FR-D2, FR-D5, §3.7, §5.1, §5.4, §7                                                                                                                     |
