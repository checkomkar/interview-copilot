# PRD: Interview Copilot (Windows Desktop App)

**Version:** 1.1 (see §13 Change Log)
**Owner:** Omkar
**Audience:** Claude Code (implementation agent)
**Status:** Ready to build

---

## 1. Overview

Interview Copilot is a personal Windows desktop app that listens to system audio (the other side of a call), optionally reads the screen, detects when a question has been asked, and shows a concise, streamed answer in a small always-on-top overlay window. It is personalized with the user's resume and a job description.

It also includes a **Practice Mode** that plays the role of interviewer and gives feedback on the user's spoken answers.

### 1.1 Goals

- Answer spoken questions with first tokens visible in **< 3 seconds** after the question ends.
- Use screen content (e.g., a coding problem or slide) as context on demand.
- Personalize answers using the user's resume, job description, and custom notes.
- Keep running cost around **$0.50–2 per hour**, with a live cost meter.
- Single-user, local-first. No backend server. API keys stay on the device.
- Features designed to hide the app from screen sharing, proctoring tools, or other capture software.
- Auto-typing or injecting answers into other applications.

### 1.2 Non-goals (v1)

- No multi-user accounts, billing, or cloud sync.
- No macOS/Linux builds (keep code portable where cheap, but do not test).

---

## 2. User Stories

| #   | As a user I want to…                                       | So that…                                           |
| --- | ---------------------------------------------------------- | -------------------------------------------------- |
| U1  | Start a session with one click / hotkey                    | I can get going quickly                            |
| U2  | See a live transcript of what the other person is saying   | I can confirm it heard correctly                   |
| U3  | Get an answer automatically when a question ends           | I don't have to do anything manually               |
| U4  | Press a hotkey to force an answer to the last utterance    | I can trigger it when auto-detect misses           |
| U5  | Press a hotkey to include a screenshot in the question     | I can get help with on-screen coding/case problems |
| U6  | Upload my resume and a JD                                  | Answers reference my real experience               |
| U7  | Choose answer style (bullets / short script / STAR / code) | Output fits the question type                      |
| U8  | See the cost of the current session                        | I can control spend                                |
| U9  | Review past sessions (transcript + answers)                | I can study afterward                              |
| U10 | Practice with AI-generated questions and get feedback      | I can prepare without a live interview             |
| U11 | Type or speak my own question to the assistant             | I can ask something the interviewer didn't say     |
| U12 | See every question and answer of the session in one scroll | I can glance back without flipping one at a time   |
| U13 | Choose the LLM provider, including free tiers, with automatic failover | I can build and test without paying, and never get stuck when one runs out |

---

## 3. Functional Requirements

### 3.1 Audio Capture

- **FR-A1:** Capture Windows system audio output via WASAPI loopback (default output device). In Electron, use `session.setDisplayMediaRequestHandler` with `audio: 'loopback'` and `navigator.mediaDevices.getDisplayMedia`.
- **FR-A2:** Optionally capture microphone as a separate stream (off by default in Copilot Mode, on in Practice Mode).
- **FR-A3:** Label streams by source: `loopback` = "Interviewer", `mic` = "Me". Only `loopback` utterances trigger auto-answers, except while **voice questions** are on (FR-O7), when the user's mic speech is answered directly.
- **FR-A4:** Resample to 16 kHz mono PCM (linear16) in an AudioWorklet and send 100 ms chunks to the STT provider.
- **FR-A5:** Show an input level meter per stream in the main window.
- **FR-A6:** Let the user pick the output device if multiple exist; persist choice.

### 3.2 Speech-to-Text (STT)

- **FR-S1:** Pluggable provider interface `SttProvider { start(), sendAudio(chunk), stop(), on('partial'|'final'|'utteranceEnd'|'error') }`.
- **FR-S2:** Default provider: **Deepgram streaming WebSocket** (latest general English model, `interim_results=true`, `smart_format=true`, `endpointing` ~300 ms, `utterance_end_ms` ~1000 ms). Model name configurable in settings.
- **FR-S3:** Secondary provider (Phase 3): AssemblyAI streaming. Stretch: local `whisper.cpp` via a sidecar process.
- **FR-S4:** Auto-reconnect with exponential backoff (max 5 tries); buffer up to 5 s of audio during reconnect.
- **FR-S5:** Send keep-alive messages during silence per provider docs.

### 3.3 Question Detection

- **FR-Q1:** On each `utteranceEnd` from the Interviewer stream, collect the finalized text since the last answer.
- **FR-Q2:** Run a fast heuristic first: ends with `?`, or starts with/contains question cues ("what", "how", "why", "tell me", "walk me through", "can you", "describe", "explain", "design", "write", "have you").
- **FR-Q3:** If heuristic is inconclusive and text ≥ 6 words, call the fast model classifier (see §6.2) returning `{ "is_question": bool, "type": "behavioral|technical|coding|system_design|situational|smalltalk|other", "clean_question": string }`. Timeout 1.5 s; on timeout, treat as question if ≥ 8 words.
- **FR-Q4:** Merge follow-ups: if a new question arrives within 10 s of the previous one and is short (< 8 words), append it to the previous question and regenerate. (Interviewer audio only; two quick short voice questions stay separate.)
- **FR-Q5:** Debounce: never fire more than one generation per 2 s. A new question cancels any in-flight generation (AbortController).
- **FR-Q6:** Toggle for "Auto-answer" (default on). When off, only hotkey triggers generate.
- **FR-Q7:** Mid-sentence pauses. Speakers pause, speak slowly or swallow words, and STT ends an utterance at each pause. If the text so far looks unfinished (no closing `.?!`, or it ends on a hanging word such as "the", "your", "about", "how", "and"), wait `pauseGraceMs` (default 1,500 ms, 0 = off) for more speech before treating the turn as over; speech resuming cancels the wait and the pieces are joined into one question. Finished-looking questions are not delayed. Applies to interviewer audio and voice questions.
- **FR-Q8:** Continuations. Speech that starts within 3 s of the previous question's end — or within 10 s when that question looked unfinished — continues it, even if STT punctuated the fragment as finished: append it to the previous question and regenerate the same Q&A (no detection, no new card). After a real question the candidate answers, so the interviewer's next question comes much later.

### 3.4 Screen Context

- **FR-SC1:** Hotkey `Ctrl+Shift+S` captures the primary display (or a user-chosen display) via `desktopCapturer`, downscales to max 1600 px on the long edge, JPEG quality 80.
- **FR-SC2:** Screenshot is attached to the **next** generation (or immediately triggers one with prompt "Solve / answer what's shown on screen" if no pending question).
- **FR-SC3:** Option "Always include screenshot" (default off) for coding rounds.
- **FR-SC4:** Screenshot is sent to the LLM as an image content block (vision). No local OCR in v1.
- **FR-SC5:** Show a small thumbnail of the attached screenshot in the overlay, with an × to remove.

### 3.5 Answer Generation

- **FR-G1:** Pluggable `LlmProvider` interface, all streaming. Providers:
  - **Groq** (default; OpenAI-compatible API, free tier: 30 req/min and 1,000 req/day per model, ~0.5 s to first token)
  - **OpenRouter** (OpenAI-compatible; free `:free` models or paid models such as Claude)
  - **Google Gemini** (OpenAI-compatible endpoint, free tier; slowest — last backup)
  - **Anthropic Messages API** (paid)
- **FR-G2:** Two model slots per provider, `answerModel` and `fastModel` (classifier, summaries, practice feedback drafts). Each slot is a **chain of up to 12 model IDs** tried in order. Defaults:
  - Groq: `openai/gpt-oss-120b, qwen/qwen3.8-27b, openai/gpt-oss-20b` / `openai/gpt-oss-20b, qwen/qwen3.8-27b, openai/gpt-oss-120b`
  - OpenRouter: "Free" preset — 12 / 10 free models across different upstreams, ending in `openrouter/free`; "Claude" preset — `anthropic/claude-sonnet-5.5` / `anthropic/claude-haiku-4.5`
  - Gemini: `gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash, gemini-3.1-flash-lite` / `gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.5-flash`
  - Anthropic: `claude-sonnet-5-5` / `claude-haiku-4-5-20251001`
- **FR-G3:** Context sent per request: system prompt (§6.1), resume summary, JD summary, custom notes, last ~2,000 tokens of transcript, the question, answer style, optional screenshot.
- **FR-G4:** Stream tokens into the overlay as they arrive. Render Markdown (bullets, bold, code blocks with syntax highlighting).
- **FR-G5:** Use prompt caching on the static system prompt + resume + JD block to cut cost and latency (Anthropic: `cache_control` + pre-warm at session start; OpenRouter: `cache_control` forwarded; Groq/Gemini: provider-side automatic caching only).
- **FR-G6:** Answer style chosen automatically from question type, overridable by hotkeys:
  - behavioral → STAR bullets
  - technical → 3–5 key bullets + one-line summary
  - coding → approach (2–3 bullets), complexity, then code in the user's preferred language
  - system_design → components, data flow, trade-offs as bullets
- **FR-G7:** `max_tokens` configurable (default 600; coding 1,500).
- **FR-G8:** "Regenerate" (`Ctrl+Shift+R`) and "Shorter" (`Ctrl+Shift+D`) actions.
- **FR-G9:** Model chains and provider failover.
  - Within a provider, a model that is rate-limited, over its daily quota or not found is skipped for a cooldown (the API's `Retry-After`, else 1 min for rate limits, 1 h for daily caps, 10 min for missing models) and the next model in the chain is used. OpenRouter receives 3 models per request (server-side `models` fallback); others receive one.
  - Settings choose a **main provider** and ordered **backup providers** (default: Groq, then OpenRouter, then Gemini). When the main provider's chain fails or the account is out (bad key, no credits, OpenRouter's 50/day free cap, Anthropic "credit balance too low"), the next backup with an API key answers with its own model chain. An account-wide failure benches that provider (1 h for caps/credits, 10 min for a bad key); saving a new key clears it.
  - Free-only OpenRouter chains always end with `openrouter/free`.
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

1. **Session** — Start/Stop, audio device picker, level meters, live dual-lane transcript (Interviewer / Me), auto-answer toggle, cost meter, elapsed time.
2. **Profile** — upload resume (PDF/DOCX/TXT), paste JD, company name, role, custom notes ("my top 3 projects", "preferred language: TypeScript"). On save, generate a compact summary with `fastModel` and cache it.
3. **History** — list of sessions; open one to view transcript + all Q&As; export as Markdown.
4. **Practice** — see §3.9.
5. **Settings** — API keys, providers, models, hotkeys, overlay options, cost cap.

### 3.8 Cost Tracking

- **FR-C1:** Track STT seconds and LLM input/output/cached tokens per session using usage fields from API responses.
- **FR-C2:** Pricing table in `config/pricing.json` (user-editable) — do not hard-code prices in logic.
- **FR-C3:** Show running `$` total in Session tab and a small figure in the overlay footer.
- **FR-C4:** Optional per-session cost cap; at 80% show a warning, at 100% switch `answerModel` to `fastModel` and notify.

### 3.9 Practice Mode

- **FR-P1:** User selects round type (behavioral, technical, system design, mixed) and count (5/10/15).
- **FR-P2:** App generates questions from resume + JD, reads them aloud with the Web Speech API (`speechSynthesis`), and records the user's mic answer.
- **FR-P3:** After each answer, give feedback: score 1–10, strengths, gaps, and an improved model answer.
- **FR-P4:** End-of-practice summary saved to History.

### 3.10 Storage

- **FR-D1:** Local SQLite (`better-sqlite3`) in `%APPDATA%/InterviewCopilot/data.db`.
- **FR-D2:** Tables: `sessions`, `utterances`, `qa_pairs`, `profiles`, `usage`.
- **FR-D3:** API keys encrypted with Electron `safeStorage`; never written to logs or plaintext config.
- **FR-D4:** Screenshots not persisted by default (setting to keep them).
- **FR-D5:** "Delete all data" button.

### 3.11 Global Hotkeys (defaults, all rebindable)

| Action                    | Hotkey               |
| ------------------------- | -------------------- |
| Start/stop session        | `Ctrl+Shift+Enter`   |
| Answer last utterance now | `Ctrl+Shift+Space`   |
| Screenshot + answer       | `Ctrl+Shift+S`       |
| Regenerate                | `Ctrl+Shift+R`       |
| Shorter                   | `Ctrl+Shift+D`       |
| Show/hide overlay         | `Ctrl+Shift+H`       |
| Prev/next answer          | `Ctrl+Shift+←` / `→` |
| Toggle auto-answer        | `Ctrl+Shift+A`       |
| Voice questions on/off    | `Ctrl+Shift+M`       |
| Type a question (focus)   | `Ctrl+Shift+K`       |

---

## 4. Non-Functional Requirements

| Area        | Requirement                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------- |
| Latency     | Question end → first answer token < 3 s (p50), < 5 s (p95)                                    |
| STT lag     | Interim transcript within 500 ms of speech                                                    |
| CPU         | < 15% average on a 4-core laptop during a session                                             |
| Memory      | < 400 MB total                                                                                |
| Reliability | Survives network drop of up to 30 s without crashing; auto-resumes                            |
| Security    | Context isolation on, `nodeIntegration` off, strict CSP, all API calls from main process      |
| Privacy     | No telemetry. Data only leaves device to configured STT/LLM providers                         |
| Install     | Single NSIS installer (`.exe`) built with electron-builder; unsigned is fine for personal use |

---

## 5. Architecture

### 5.1 Tech Stack

- **Shell:** Electron (latest stable) + electron-vite
- **UI:** React 18 + TypeScript + Tailwind CSS + Zustand (state)
- **Markdown:** `react-markdown` + `rehype-highlight`
- **Audio:** Web Audio API + AudioWorklet (renderer, hidden capture window)
- **STT:** Deepgram WebSocket (via `@deepgram/sdk` or raw `ws`) from main process
- **LLM:** `@anthropic-ai/sdk` (Anthropic) and plain `fetch` + SSE against OpenAI-compatible chat completions (Groq, OpenRouter, Gemini), all from the main process, streaming
- **DB:** `better-sqlite3`
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

### 5.4 Suggested Repo Structure

```
interview-copilot/
├─ electron.vite.config.ts
├─ package.json
├─ config/pricing.json
├─ src/
│  ├─ main/
│  │  ├─ index.ts
│  │  ├─ windows/{mainWindow,overlayWindow,captureWindow}.ts
│  │  ├─ services/
│  │  │  ├─ session/SessionManager.ts
│  │  │  ├─ stt/{SttProvider.ts,DeepgramProvider.ts}
│  │  │  ├─ detect/QuestionDetector.ts
│  │  │  ├─ llm/{LlmProvider.ts,AnthropicProvider.ts,OpenAICompatProvider.ts,LlmRouter.ts,Cooldowns.ts,prompts.ts}
│  │  │  ├─ answer/{AnswerService.ts,CopilotService.ts}
│  │  │  ├─ screen/ScreenService.ts
│  │  │  ├─ cost/CostTracker.ts
│  │  │  ├─ profile/ProfileService.ts
│  │  │  ├─ practice/PracticeService.ts
│  │  │  └─ hotkeys/HotkeyService.ts
│  │  ├─ db/{schema.sql,db.ts}
│  │  └─ settings/SettingsStore.ts
│  ├─ preload/index.ts          # typed contextBridge API
│  ├─ shared/{ipc.ts,types.ts}  # zod schemas + channel names
│  └─ renderer/
│     ├─ main/    # control panel React app
│     ├─ overlay/ # overlay React app
│     └─ capture/ # hidden capture page + audio-worklet.ts
└─ tests/
```

---

## 6. Prompts

### 6.1 Answer System Prompt (cacheable block)

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
- Coding: 2-3 bullet approach, time/space complexity, then clean code
  in {preferredLanguage} with brief comments.
- System design: requirements → components → data flow → trade-offs.
- If a screenshot is attached, use it as the primary source for the
  problem statement.
- If the transcript is garbled, answer the most likely intended question
  and show your interpretation in one italic line at the top.

<resume_summary>{resumeSummary}</resume_summary>
<job_description_summary>{jdSummary}</job_description_summary>
<candidate_notes>{notes}</candidate_notes>
```

### 6.2 Question Classifier Prompt (fastModel)

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

### 6.4 Practice Feedback Prompt

Given question, candidate transcript, resume and JD: return JSON with `score` (1–10), `strengths[]`, `gaps[]`, `improved_answer` (markdown).

---

## 7. IPC Contract (typed, in `src/shared/ipc.ts`)

| Channel              | Direction             | Payload                         |
| -------------------- | --------------------- | ------------------------------- | ------------------------------ |
| `audio:chunk`        | capture → main        | `{ source: 'loopback'           | 'mic', pcm: ArrayBuffer, ts }` |
| `audio:level`        | capture → main window | `{ source, rms }`               |
| `transcript:update`  | main → windows        | `{ source, text, isFinal, ts }` |
| `question:detected`  | main → overlay        | `{ id, question, type }`        |
| `answer:token`       | main → overlay        | `{ id, delta }`                 |
| `answer:done`        | main → overlay        | `{ id, usage }`                 |
| `answer:error`       | main → overlay        | `{ id, message }`               |
| `session:start/stop` | main window → main    | `{ profileId }`                 |
| `session:state`      | main → windows        | `{ status, elapsed, cost }`     |
| `screen:capture`     | any → main            | `{ displayId? }`                |
| `settings:get/set`   | main window ↔ main    | zod-validated settings          |
| `answer:ask`         | overlay → main        | `{ text }` (typed question)     |
| `voice:set`          | overlay → main        | `{ on }` (voice questions)      |
| `capture:mic`        | main → capture        | `{ on, deviceId }`              |
| `qa:list` / `qa:reset` | overlay ↔ main      | Q&A snapshot / new session      |

All handlers validate payloads with zod.

---

## 8. Settings Schema (defaults)

```json
{
	"stt": {
		"provider": "deepgram",
		"model": "nova-3",
		"language": "en",
		"endpointingMs": 300,
		"utteranceEndMs": 1000
	},
	"llm": {
		"provider": "groq",
		"fallbackProviders": ["openrouter", "gemini"],
		"answerModel": "claude-sonnet-5-5",
		"fastModel": "claude-haiku-4-5-20251001",
		"groq": { "answerModel": "openai/gpt-oss-120b, …", "fastModel": "openai/gpt-oss-20b, …", "reasoningEffort": "low" },
		"openrouter": { "answerModel": "<Free preset>", "fastModel": "<Free preset>", "reasoningEffort": "low" },
		"gemini": { "answerModel": "gemini-3.8-flash, …", "fastModel": "gemini-3.1-flash-lite, …", "reasoningEffort": "minimal" },
		"maxTokens": 600,
		"maxTokensCoding": 1500
	},
	"detection": { "autoAnswer": true, "minWords": 6, "debounceMs": 2000, "pauseGraceMs": 1500 },
	"screen": { "alwaysInclude": false, "displayId": null, "maxEdgePx": 1600 },
	"overlay": { "opacity": 0.9, "fontSize": 15, "theme": "dark", "view": "single" },
	"cost": { "sessionCapUsd": 5 },
	"preferredLanguage": "TypeScript",
	"keepScreenshots": false
}
```

Model IDs must be editable strings in the UI so they can be updated without code changes. Top-level `answerModel`/`fastModel` are the Anthropic slots (kept there for settings saved before other providers existed). API keys (Deepgram, Anthropic, OpenRouter, Groq, Gemini) are stored encrypted, never in this file.

---

## 9. Error Handling

- Missing API key → block session start, deep-link to Settings (an LLM key for the main or any backup provider is enough).
- STT disconnect → status dot amber, auto-reconnect, toast after 3 failures.
- LLM 429/529 (or 502/503 from OpenRouter) → next model in the chain / next backup provider (FR-G9); then retry once after 1 s, then fall back to `fastModel`. Models and providers on cooldown are skipped without a request.
- Provider error messages name the upstream and its reason (e.g. "Google AI Studio: …rate-limited upstream"); OpenRouter data-policy blocks point to openrouter.ai/settings/privacy.
- LLM stream error mid-answer → keep partial text, show "⚠ incomplete — Ctrl+Shift+R to retry".
- No loopback audio for 20 s while session active → hint: "No system audio detected — check output device."
- All errors logged to `%APPDATA%/InterviewCopilot/logs/` with keys redacted.

---

## 10. Build Phases & Acceptance Criteria

### Phase 1 — Skeleton & audio (MVP foundation)

- Electron + React + TS scaffold, three windows, typed preload bridge.
- Settings with encrypted API keys.
- Loopback capture + level meter; Deepgram streaming; live transcript in main window.
- **Accept:** Play a YouTube video → transcript appears within 1 s of speech.

### Phase 2 — Answers

- Question detector (heuristic + classifier), AnswerService with streaming, overlay rendering, hotkeys for answer-now/regenerate/hide.
- Profile tab with resume/JD upload and summaries; prompt caching.
- **Accept:** Play a recorded mock-interview question → overlay shows first tokens < 3 s after it ends; answer references resume projects.
- Added during Phase 2 at the user's request (§13): OpenRouter/Groq/Gemini providers with model chains and failover, overlay ask bar (typed + voice questions), list layout, mid-sentence pause handling.

### Phase 3 — Screen, cost, history

- Screenshot hotkey + vision input, thumbnail in overlay.
- CostTracker with pricing.json, cost cap behavior.
- SQLite history, session review, Markdown export.
- **Accept:** Open a LeetCode problem, press `Ctrl+Shift+S` → overlay shows approach, complexity and working code; session appears in History with correct cost.

### Phase 4 — Practice mode & polish

- Practice flow with TTS questions, mic recording, feedback, summary.
- Mic lane in transcript, AssemblyAI provider, error-handling polish, installer.
- **Accept:** Complete a 5-question practice run end to end; installer produces a working `.exe`.

---

## 11. Testing

- Unit (Vitest): QuestionDetector heuristics, classifier JSON parsing, prompt builder, CostTracker math, settings schema.
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

---

## 13. Change Log

User-requested changes after v1.0. Each entry lists what changed and where it is specified.

| Date | Change | Sections |
| --- | --- | --- |
| 2026-10-02 | OpenRouter added as an LLM provider alongside Anthropic, selectable in Settings without restart. | FR-G1, §5.1, §8 |
| 2026-10-02 | Free OpenRouter models for building/testing without credits; "Free" and "Claude" presets. | FR-G2 |
| 2026-10-02 | Model fallback chains (up to 12 per slot) with per-model cooldowns; free OpenRouter chains end with `openrouter/free`. | FR-G2, FR-G9 |
| 2026-10-02 | Groq and Google Gemini added (free tiers); main + ordered backup providers with automatic failover when one is rate-limited or out of quota. | FR-G1, FR-G9, §8, §9 |
| 2026-10-02 | **Groq is the default provider** (OpenRouter free models were slow; Gemini slower still — kept as last backup). Supersedes the v1.0 Anthropic default. | FR-G1, §8 |
| 2026-10-02 | Overlay ask bar: type a question, or toggle the mic to ask by voice. | U11, FR-A3, FR-O7, §3.11, §7 |
| 2026-10-02 | Overlay list layout: all Q&As in one scroll, alongside one-at-a-time with ‹ ›. | U12, FR-O8 |
| 2026-10-02 | Show which model/provider produced each answer (overlay and log). | FR-O9 |
| 2026-10-02 | Handle pauses and varied speaking styles: wait after unfinished sentences, merge speech that resumes within 3 s into the same question. | FR-Q4, FR-Q7, FR-Q8, §8 |

