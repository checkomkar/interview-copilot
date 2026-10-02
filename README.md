# Interview Copilot

Personal Windows desktop app that listens to system audio, transcribes it live and shows concise, streamed answers in an always-on-top overlay. See [PRD-interview-copilot.md](PRD-interview-copilot.md).

**Status: Phase 2** — Phase 1 (windows, encrypted settings, loopback capture, Deepgram streaming, live transcript) plus question detection, streamed answers in the overlay, answer hotkeys, and the Profile tab (resume/JD import + summaries, prompt caching).

## Setup

Requirements: Windows 10/11, Node.js 20+.

```sh
npm install
npm run dev
```

> **npm 11 note:** npm may hold back install scripts. If `npm run build` complains about esbuild, run
> `npm install-scripts approve esbuild electron-winstaller` and `npm rebuild`.
> Electron downloads its binary on first launch.

> **VS Code note:** VS Code's integrated terminal sets `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node.
> `npm run dev` / `npm start` go through `scripts/electron-vite.mjs`, which removes it.

### API keys

Open **Settings → API keys** and paste:

| Provider | Used for | Get one |
|---|---|---|
| Deepgram | Speech-to-text | https://console.deepgram.com |
| Anthropic | Answers, question classifier, profile summaries (if Anthropic is the selected provider) | https://console.anthropic.com |
| OpenRouter | The same, via free or paid OpenRouter models | https://openrouter.ai/keys |
| Groq | The same, free tier (no card) | https://console.groq.com/keys |
| Google Gemini | The same, free tier (no card) | https://aistudio.google.com/apikey |

A session needs the Deepgram key plus a key for the main answer provider or one of its backups (**Settings → Answers**).

Keys are encrypted with Electron `safeStorage` (Windows DPAPI) into `%APPDATA%\InterviewCopilot\secrets.json`. They are only decrypted in the main process, are never sent to the renderer windows, and are redacted from logs.

## Using it

1. Add your Deepgram key and at least one answer-provider key (Anthropic, OpenRouter, Groq or Google Gemini), and pick the main provider and any backups in **Settings → Answers**.
2. In **Profile**, import your resume (PDF / DOCX / TXT) or paste it, paste the job description, add notes, and **Save** — the resume and JD are summarized with the fast model.
3. Click **Start session** (or `Ctrl+Shift+Enter`).
4. Play audio through your default output device — the **Interviewer** meter moves and the transcript appears. When the interviewer finishes a question, the answer streams into the overlay.

### Overlay layout

The ☰ button in the overlay header (or **Settings → Overlay → Layout**) switches between:
- **One at a time** — the latest answer, with ‹ › (`Ctrl+Shift+←/→`) to flip through earlier ones.
- **All questions and answers** — every Q&A of the session, numbered, in one scroll. New questions scroll into view and streaming text is followed while you're at the bottom; scroll up to read and it stays put. ‹ › jump to the previous/next Q&A and mark it.

### Asking directly (keyboard or voice)

The bottom of the overlay has an input and a mic button:
- **Type** a question and press Enter (`Ctrl+Shift+K` focuses the input from anywhere). Works with or without a session.
- **Mic** (`Ctrl+Shift+M`) turns on *voice questions*: whatever you say is transcribed by Deepgram and answered as soon as you pause (~1 s), with no question detection. A live line shows what it hears. Turning it on starts a session if none is running (and keeps the answers already in the overlay); the mic is opened only while the toggle is on, unless **Settings → Audio → Capture microphone** keeps it on for the "Me" transcript lane. Mic speech is never answered while the toggle is off.

### How answers are triggered

- On each end of an interviewer utterance, quick rules check for a question (`?`, "tell me", "walk me through", "how would you", …). Unclear utterances of 6+ words go to the fast model (`claude-haiku-4-5-20251001`) with a 1.5 s timeout. The microphone lane never triggers answers.
- Statements without a question are kept and included with the next question (e.g. context, then "How would you do it?").
- **Pauses mid-sentence.** Speech-to-text ends an utterance at every ~1 s pause, so slow or hesitant speakers get cut into pieces. Two rules put them back together (for interviewer audio and voice questions):
  - An utterance that sounds unfinished (no closing punctuation, or ending on "the", "your", "about", "how"…) waits an extra **1.5 s** (**Settings → Question detection → Mid-sentence pause**) for the speaker to go on; if they do, the pieces become one question.
  - Speech that **resumes within 3 s** of a question ending is the same speaker carrying on (even when the fragment was punctuated as a question): it's merged into that question and the answer regenerates, instead of becoming a new card. After a real question the candidate answers, so the interviewer's next question comes much later.
  - Finished questions are answered immediately; these rules add no wait to them.
- A short follow-up within 10 s ("And why?") is merged into the previous question and the answer regenerates.
- At most one answer starts per 2 s; a new question cancels the answer in flight.
- **Auto-answer** off (`Ctrl+Shift+A`, or Session tab) → only `Ctrl+Shift+Space` answers.
- Answer style follows the question type: behavioral → STAR, technical → key bullets + summary, coding → approach, complexity, code in your preferred language, system design → components / data flow / trade-offs.
- On 429/529 the answer model is retried once after 1 s, then the fast model is used. If a stream breaks mid-answer, the partial text stays with "⚠ incomplete — Ctrl+Shift+R to retry".

### Models and latency

Defaults: answers `claude-sonnet-5-5`, classifier/summaries `claude-haiku-4-5-20251001` (editable in **Settings → Answers**). For speed, Sonnet 5.5 runs with thinking off (`between_tools`) at low effort, and the system prompt + resume + JD summaries are one cached block, pre-warmed at session start and kept warm during quiet stretches. Server-side refusal fallback (`fallbacks: "default"`) is enabled for models that support it.

### Answer providers, model chains and failover

**Settings → Answers** has a **main provider** and optional **backup providers** (only ones with a key are used). Default: **Groq** (fast, ~0.5 s to first text in testing), with OpenRouter then Google Gemini as backups.

| Provider | Cost | Free limits | Default models (answers → fast) |
|---|---|---|---|
| Anthropic | paid | — | `claude-sonnet-5-5` / `claude-haiku-4-5-20251001` |
| OpenRouter | free models or paid | 20 req/min, **50/day** without credits; upstreams shared with all free users | 12-model free chain / 10-model free chain (**Free** preset), or the **Claude** preset |
| Groq | free tier | 30 req/min, **1,000/day per model** | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `openai/gpt-oss-20b` |
| Google Gemini | free tier | per model, see aistudio.google.com/rate-limit | `gemini-3.8-flash` → `3.7` → `3.5` → `3.1-flash-lite` |

How a request is served:
1. **Model chain.** Each model field holds up to 12 IDs (one per line), tried top to bottom. OpenRouter gets 3 per request (it falls through them server-side); Groq and Gemini get one per request. A model that is rate-limited, over its daily quota or not found is **skipped for a while** (the API's `Retry-After`, else 1 min for rate limits, 1 h for daily caps, 10 min for missing models), so later requests don't spend quota on it.
2. **Provider failover.** If the whole chain fails, or the account is out (bad key, no credits, OpenRouter's 50/day cap, Anthropic "credit balance too low"), the next backup provider is used with *its* model chain. An account-wide failure benches that provider for a while (1 h for caps/credits, 10 min for a bad key); saving a new key un-benches it.
3. Then the usual answer rules apply (one retry, then the fast models), but models and providers already on cooldown are skipped without a request.

The overlay shows who answered under each answer (e.g. `gpt-oss-120b · Groq`), and the log records it: `answer … [OpenRouter] nvidia/nemotron-3-super-120b-a12b:free via Nvidia …`.

Differences from the direct Anthropic API: thinking is set per provider with **Reasoning effort** (OpenRouter: answers only; Groq and Gemini: answers, with the classifier and summaries always at the lowest setting — Gemini 3 and gpt-oss can't turn reasoning off). Only Anthropic and OpenRouter use the prompt cache breakpoint, and there is no pre-warm outside Anthropic. Free tiers of OpenRouter models and Gemini may log or train on prompts (your resume and the transcript).

### Hotkeys

All are global and rebindable in **Settings → Global hotkeys** (Electron accelerator syntax).

| Action | Default | Available |
|---|---|---|
| Start / stop session | `Ctrl+Shift+Enter` | ✓ |
| Show / hide overlay | `Ctrl+Shift+H` | ✓ |
| Answer last utterance now | `Ctrl+Shift+Space` | ✓ |
| Regenerate / Shorter | `Ctrl+Shift+R` / `Ctrl+Shift+D` | ✓ (latest answer) |
| Prev / next answer | `Ctrl+Shift+←` / `→` | ✓ |
| Toggle auto-answer | `Ctrl+Shift+A` | ✓ |
| Voice questions on / off | `Ctrl+Shift+M` | ✓ |
| Type a question (focus overlay input) | `Ctrl+Shift+K` | ✓ |
| Screenshot + answer | `Ctrl+Shift+S` | Phase 3 |

The overlay header has the same actions as buttons (Answer, Retry, Shorter, ‹ ›).

### Data locations

`%APPDATA%\InterviewCopilot\`
- `settings.json` — non-secret settings
- `secrets.json` — encrypted API keys
- `profile.json` — resume/JD text, notes and their summaries (moves to SQLite in Phase 3)
- `logs\YYYY-MM-DD.log` — app logs (keys redacted, includes renderer errors)

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm test` | Vitest unit + integration tests (no network) |
| `npm run typecheck` | TypeScript for main/preload and renderers |
| `npm run build` | Production bundle into `out/` |
| `npm start` | Run the production bundle |
| `npm run dist` | Build the NSIS installer into `dist/` (finalized in Phase 4) |

**Latency debug:** **Settings → Debug · latency** shows last / p50 / p95 for STT lag, utterance end → question detected, and utterance end → first answer token (target < 3 s). Each answer's model, serving provider (OpenRouter) and token usage (incl. cached tokens) is logged, e.g. `answer … nvidia/nemotron-3-super-120b-a12b:free via Nvidia in=435 cached=0 out=419`.

### Layout

```
src/
  main/                     Electron main process (all network calls live here)
    index.ts                App wiring + zod-validated IPC handlers
    windows/                main, overlay (frameless, on-top), capture (hidden)
    services/session/       SessionManager: capture -> STT -> transcripts
    services/stt/           SttProvider interface, DeepgramProvider, TranscriptAssembler
    services/detect/        QuestionDetector: heuristic + fast-model classifier
    services/llm/           LlmProvider interface, AnthropicProvider, OpenRouterProvider, LlmRouter (picks per request), prompts
    services/answer/        AnswerService (streaming, retry/fallback), CopilotService (detect -> answer orchestration)
    services/profile/       ProfileService (profile.json + summaries), resume text extraction
    services/hotkeys/       globalShortcut registration
    settings/               SettingsStore (JSON + safeStorage)
  preload/                  Typed contextBridge API (window.api)
  shared/                   Channel names, IPC types/zod schemas, settings schema
  renderer/
    main/                   Control panel (React + Zustand + Tailwind)
    overlay/                Overlay (React, streamed Markdown + highlight.js)
    capture/                getDisplayMedia loopback + mic, AudioWorklet -> 16 kHz PCM
tests/                      Vitest
```

Security: context isolation on, sandboxed renderers, `nodeIntegration` off, strict CSP, IPC accepted only from app pages, and audio IPC only from the capture window.
