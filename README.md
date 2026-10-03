# Cue

Personal desktop app for Windows and macOS that listens to call audio, transcribes it live and shows concise, streamed answers in an always-on-top overlay. See [PRD-cue.md](PRD-cue.md).

Cue has two modes, picked on the Session tab before a session starts:

- **Work Mode** — keep your projects in the **Projects** tab; on a call, when someone asks "where are we on X?", the overlay writes a ready-to-say status update from that project and what's been said. Screenshots are explained for presenting. (Post-call recap and pre-call brief come in Phase 6.)
- **Interview Mode** — interview questions answered from your resume and job description, plus Practice.
 Cue was called *Interview Copilot* until v1.0; on first start it moves `%APPDATA%\InterviewCopilot` to `%APPDATA%\Cue`.

**Status: Interview Mode v1.0 (Phases 1–4)** — live transcript (Deepgram or AssemblyAI), question detection and streamed answers in the overlay (Groq by default, with OpenRouter / Gemini / Anthropic and automatic failover), typed and voice questions, the Profile tab, screenshot answers, a live cost meter with a session cap, saved session History with Markdown export, **Practice Mode** (mock interviews with spoken questions and scored feedback) and installers for Windows and macOS.

## Install

Run `dist\Cue-Setup-1.0.0.exe` (build it with `npm run dist`). It installs per user (no admin), lets you pick the folder, and adds Start menu and desktop shortcuts. The installer is unsigned, so Windows SmartScreen may warn — choose **More info → Run anyway**. If you installed the older *Interview Copilot* build, uninstall it from Windows Settings → Apps (your data is kept and moved to Cue). Uninstalling keeps your data in `%APPDATA%\Cue` (use **Settings → Data → Delete all data** first to remove it).

**macOS (13 Ventura or later):** open `dist/Cue-1.0.0-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) — build them with `npm run dist:mac` — and drag Cue to Applications. The app is ad-hoc signed, not notarized, so the first launch is blocked: right-click Cue → **Open** (or `xattr -dr com.apple.quarantine /Applications/Cue.app`). See [macOS notes](#macos-notes) for permissions.

## Setup

Requirements: Windows 10/11 or macOS 13+, Node.js 20+.

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
| Deepgram | Speech-to-text (default) | https://console.deepgram.com |
| AssemblyAI | Speech-to-text (alternative, ~$0.15/hour) | https://www.assemblyai.com/dashboard |
| Anthropic | Answers, question classifier, profile summaries (if Anthropic is the selected provider) | https://console.anthropic.com |
| OpenRouter | The same, via free or paid OpenRouter models | https://openrouter.ai/keys |
| Groq | The same, free tier (no card) | https://console.groq.com/keys |
| Google Gemini | The same, free tier (no card) | https://aistudio.google.com/apikey |

A session needs a key for the speech-to-text provider picked in **Settings → Speech-to-text** (Deepgram or AssemblyAI) plus a key for the main answer provider or one of its backups (**Settings → Answers**).

Keys are encrypted with Electron `safeStorage` (Windows DPAPI / macOS Keychain) into `secrets.json` in the [data folder](#data-locations). They are only decrypted in the main process, are never sent to the renderer windows, and are redacted from logs.

## Using it

1. Add a speech-to-text key (Deepgram or AssemblyAI) and at least one answer-provider key (Anthropic, OpenRouter, Groq or Google Gemini), and pick the main provider and any backups in **Settings → Answers**.
2. Pick the mode on the **Session** tab. For Work Mode, add your projects in **Projects** (below) and your name and role in **Profile**; the rest of this list is Interview Mode.
3. In **Profile**, import your resume (PDF / DOCX / TXT) or paste it, paste the job description, add notes, and **Save** — the resume and JD are summarized with the fast model.
4. Click **Start session** (or `Ctrl+Shift+Enter`).
5. Play audio through your default output device — the **Interviewer** meter moves and the transcript appears. When the interviewer finishes a question, the answer streams into the overlay.

### Overlay layout

The ☰ button in the overlay header (or **Settings → Overlay → Layout**) switches between:
- **One at a time** — the latest answer, with ‹ › (`Ctrl+Shift+←/→`) to flip through earlier ones.
- **All questions and answers** — every Q&A of the session, numbered, in one scroll. New questions scroll into view and streaming text is followed while you're at the bottom; scroll up to read and it stays put. ‹ › jump to the previous/next Q&A and mark it.

### Asking directly (keyboard or voice)

The bottom of the overlay has an input and a mic button:
- **Type** a question and press Enter (`Ctrl+Shift+K` focuses the input from anywhere). Works with or without a session.
- **Mic** (`Ctrl+Shift+M`) turns on *voice questions*: whatever you say is transcribed and answered as soon as you pause (~1 s), with no question detection. A live line shows what it hears. Turning it on starts a session if none is running (and keeps the answers already in the overlay); the mic is opened only while the toggle is on, unless **Settings → Audio → Capture microphone** keeps it on for the "Me" transcript lane. Mic speech is never answered while the toggle is off.

### Screenshots

`Ctrl+Shift+S` captures your primary display — or the one picked in **Settings → Screen** — downscaled to 1,600 px on the long edge, JPEG 80. The overlay fades out for the capture so it doesn't cover what's behind it.
- If the interviewer is mid-question, the screenshot waits (thumbnail with ✕ above the input) and goes with that answer — or with your next typed question.
- Otherwise it is answered right away: *"Solve / answer what's shown on screen."* (coding problems get approach, complexity, then code).
- **Long questions that need scrolling:** add up to **5 screenshots** (Settings → Screen → Screenshots per question, 1–10) with `Ctrl+Shift+Alt+S` or the camera button in the overlay's ask bar (it adds without answering). Scroll, add the next part, and so on; the tray above the input shows them numbered, each with ✕. Then press **Answer** (or Enter in the empty input, or `Ctrl+Shift+S`, which also captures one more part if there's room). All of them go to the model together, in order, for **one** answer. Typing a question sends the waiting screenshots with it. Groq's vision model takes at most 3 images per request, so a larger set skips Groq and goes to OpenRouter / Gemini.
- **Always include screenshot** attaches a fresh capture to every answer (coding rounds). Regenerate / Shorter reuse the same screenshots.

Screenshots go to each provider's **Screenshot models** chain (Settings → Answers), which must accept images: Groq `qwen/qwen3.8-27b` (Groq's only vision model), Gemini flash models, free OpenRouter vision models (Gemma 4, Qwen 3.8, Inkling), Anthropic `claude-sonnet-5-5`. Leave a provider's chain empty to skip it for screenshots. Screenshots are kept in memory only, unless **Keep screenshots** saves them with the session in History.

### Cost

The Session tab and the overlay footer show the running cost of the current session: speech-to-text minutes plus LLM tokens. Prices come from `config/pricing.json`; **Settings → Cost → Open pricing file** copies it to `%APPDATA%\Cue\pricing.json` for editing (used from the next session). OpenRouter reports each request's cost itself, which wins over the table. Groq and Gemini free tiers count as $0 — on a paid plan, put your plan's prices in the file. Models with no price are counted as $0 and listed in the Cost tooltip.

**Session cost cap** (default $5, 0 = off): at 80% a warning shows; at 100% answers switch to the fast models and the overlay says so.

### Practice

**Practice** runs a mock interview. Pick a round (behavioral, technical, system design or mixed) and 5, 10 or 15 questions; they're written from your resume and job description (so save the Profile first).

1. Each question is shown and read aloud (system voices via the Web Speech API; voice and speed are on the Practice tab). When it has been read, recording starts — or click **Answer out loud**.
2. Answer as you would in the interview; the transcript appears as you speak. Click **Done answering** (or **Type instead** / **Edit as text**).
3. You get a score out of 10, strengths, what to improve and a stronger version of your answer. **Try this one again** or **Next question**; **Skip question** moves on.
4. After the last question (or **End practice**) a short debrief is written. The run — every question, your answer and its feedback, the debrief and the average score — is saved to History and exports to Markdown.

Questions come from the fast models; feedback and the debrief from the answer models (with the usual failover). Practice listens only to the microphone and can't run during a live session. Its cost (LLM tokens plus the minutes the mic was recording) is tracked like a session's and saved with the run.

### History

Every session is saved to `%APPDATA%\Cue\data.db` (SQLite): the transcript, each question and answer (a regenerated answer replaces the earlier one), which model answered, LLM usage and cost. Questions typed outside a listening session are saved as their own session. Practice runs are saved too (marked **Practice**, with their average score). **History** lists sessions newest first; open one to read it, **Export Markdown** to save it as a `.md` study file, or delete one / all.

### Work Mode

**Projects tab.** One entry per project you might be asked about: name, **also called** (the names people use — "PRISM", "the migration"), status (On track / At risk / Blocked / Done), owner, stakeholders, deadline and notes; **work items**; and a **Log an update** box — dated automatically, the quickest way to keep a project current (`Win+H` dictates; pick the item it's about and who said it).

**Work items** are the things people ask about one by one — a **deployment** ("UAT deployment"), an **approval** ("TOM approvals"), a **bug** ("Login crash", BUG-142) or a task. Each has a status (To do / In progress / Waiting / Blocked / Done), owner (the developer on a bug), **waiting on** (e.g. the MDM team), environment, due date, **last follow-up** (date + who chased whom), blockers, a reference and its own update timeline. Open items always go with status answers in full; notes, finished items and older updates are condensed by the fast model once they pass ~150 tokens (the card at the bottom shows which version answers use).

**On a call.**
- When the other side asks for a status update ("what's the status of…", "where are we on…", "any update on…", "how's X coming along", "when will X be done"), Cue matches the project by name or alias — locally, no LLM — and the overlay writes **3–5 natural spoken sentences**: current state, progress, blockers, next step, using only what you stored plus the call. Stale projects are called out. Clear questions about a named project skip the classifier; unclear ones go to the fast model (§6.6 of the PRD) with a 1.5 s timeout. Ordinary call talk isn't sent anywhere.
- Questions about **one item** — "did we follow up with the MDM team to get the app deployed on UAT?", "what's the status of the TOM approvals?", "is bug 142 fixed?" — are matched to that item (by title, other names or reference) and answered about it: state, owner, who it's waiting on, last follow-up, and how old the latest update is. **List questions** ("which bugs are open and who's on them?") go through every matching open item.
- A quick second question about another project or item gets its own answer (it's never folded into the previous one).
- If it can't tell which project, the overlay shows a **quick-pick** (best guess first) instead of guessing. `Ctrl+Shift+Space` (or **Status** in the overlay) opens it yourself — ↑↓ Enter, 1–9, Esc.
- In the overlay's ask box: `status prism` asks for a status update, `update tom approvals: security signed` logs an update on that project or item, a typed status question ("how's the migration going?") gets the spoken answer, anything else is answered from the projects it mentions.
- `Ctrl+Shift+S` explains what's on screen while you present (3–6 bullets: what it shows, the number to call out, likely follow-ups).
- Work calls are saved in History with a **Work** badge (filter by mode there), each status answer labelled with its project.

### Updates from Teams

Developers' status, blockers and bug ownership usually live in Teams chats. **Projects → Updates from Teams** turns them into suggested changes you review — nothing changes until you **Accept** (or **Edit**, or **Skip**; **Accept all** for many).

- **Paste**: select messages in a Teams group or private chat, `Ctrl+C`, paste, **Find updates**. Works with any Teams account.
- **Screenshots**: `Win+Shift+S` (macOS: `⌃⌘⇧4`), then `Ctrl+V` into the box (up to 8, in scroll order), or **Add screenshot files…**. Read by the screenshot (vision) models.
- **Teams sync** (work or school accounts): Cue checks the chats you follow every few minutes and adds suggestions automatically. Needs your organisation's app registration — the card shows the steps (public client, delegated `User.Read`, `Chat.Read`, `offline_access`; channels also need `ChannelMessage.Read.All` with admin consent). Sign-in uses a code you enter at Microsoft's sign-in page; the token is stored encrypted like the API keys. Personal and free Teams accounts can't be read by apps (Microsoft's rule) — use paste or screenshots for those.
- Each suggestion shows the message, who sent it and when, and what changes ("Owner: — → Ravi Kumar", "Status: To do → In progress"); a newly reported bug becomes a new item. The same message seen twice is suggested once.
- Messages are sent to your answer provider to be read. Free tiers may log or train on what they're sent — use a paid provider for company chats, and check what your company allows.

**Trying Teams sync without a Microsoft 365 tenant:** run `npm run mock-teams`, then in the Teams sync card click **Use the local mock** and **Sign in to Teams**; enter the code at `http://localhost:4100/device`, follow "Mobile app – dev", and post messages as different people at `http://localhost:4100`. The mock answers the same sign-in and Microsoft Graph requests as the real services, with a sample team chat, two private chats and a channel. For a final check against the real thing, a Microsoft 365 Business trial gives you a tenant.

### How answers are triggered (Interview Mode)

- On each end of an interviewer utterance, quick rules check for a question (`?`, "tell me", "walk me through", "how would you", …). Unclear utterances of 6+ words go to the fast models with a 1.5 s timeout. The microphone lane never triggers answers (except voice questions).
- Statements without a question are kept and included with the next question (e.g. context, then "How would you do it?").
- **Pauses mid-sentence.** Speech-to-text ends an utterance at every ~1 s pause, so slow or hesitant speakers get cut into pieces. Two rules put them back together (for interviewer audio and voice questions):
  - An utterance that sounds unfinished (no closing punctuation, or ending on "the", "your", "about", "how"…) waits an extra **1.5 s** (**Settings → Question detection → Mid-sentence pause**) for the speaker to go on; if they do, the pieces become one question.
  - Speech that **resumes within 3 s** of a question ending is the same speaker carrying on (even when the fragment was punctuated as a question): it's merged into that question and the answer regenerates, instead of becoming a new card. After a real question the candidate answers, so the interviewer's next question comes much later.
  - Finished questions are answered immediately; these rules add no wait to them.
- A short follow-up within 10 s ("And why?") is merged into the previous question and the answer regenerates.
- At most one answer starts per 2 s; a new question cancels the answer in flight.
- **Auto-answer** off (`Ctrl+Shift+A`, or Session tab) → only `Ctrl+Shift+Space` answers.
- Answer style follows the question type: behavioral → STAR, technical → key bullets + summary, coding → **step by step** (below), system design → components / data flow / trade-offs.
- **Coding answers come in stages**, the way you'd talk through it in an interview: **1. Understanding the problem** (what's asked in your own words, inputs → output, constraints, the example, edge cases / assumptions to confirm) → **2. Pseudocode** → **3. Brute force** (working code, with its poor time/space complexity in the heading) → **4. Optimal** (key insight, final code, complexity, edge cases). Coding problems in screenshots get the same treatment. **Shorter** gives just the optimal solution. Switch to *Optimal only* in **Settings → Answers → Coding answers**.
- **Follow-ups have context.** Every answer request includes the session's last 3 Q&As (typed and screenshot ones too, answers clipped to 1,500 characters), so "What did you understand from this question?" or "Can you make it faster?" is answered about *that* problem. Follow-ups get detailed answers (~150–300 words, code if it helps) and the long token budget. The coding token budget is 3,000 to fit all three (saved settings still at the old 1,500 default are raised automatically).
- On 429/529 the answer model is retried once after 1 s, then the fast model is used. If a stream breaks mid-answer, the partial text stays with "⚠ incomplete — Ctrl+Shift+R to retry".

### Models and latency

With Anthropic (answers `claude-sonnet-5-5`, classifier/summaries `claude-haiku-4-5-20251001`, editable in **Settings → Answers**), for speed Sonnet 5.5 runs with thinking off (`between_tools`) at low effort, and the system prompt + resume + JD summaries are one cached block, pre-warmed at session start and kept warm during quiet stretches. Server-side refusal fallback (`fallbacks: "default"`) is enabled for models that support it.

### Answer providers, model chains and failover

**Settings → Answers** has a **main provider** and optional **backup providers** (only ones with a key are used). Default: **Groq** (fast, ~0.5 s to first text in testing), with OpenRouter then Google Gemini as backups.

| Provider | Cost | Free limits | Default models (answers → fast) |
|---|---|---|---|
| Anthropic | paid | — | `claude-sonnet-5-5` / `claude-haiku-4-5-20251001` |
| OpenRouter | free models or pay-as-you-go credits | free: 20 req/min, **50/day** without credits; upstreams shared with all free users | **Free** preset (12 / 10 free models), **Paid (fast)** preset, or **Claude** preset |
| Groq | free tier | 30 req/min, **1,000/day per model** | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `openai/gpt-oss-20b` |
| Google Gemini | free tier | per model, see aistudio.google.com/rate-limit | `gemini-3.8-flash` → `3.7` → `3.5` → `3.1-flash-lite` |

**Paid (fast) preset** (OpenRouter credits, pay per token, no subscription): answers `openai/gpt-oss-120b:nitro` → `google/gemini-3.1-flash-lite` → `anthropic/claude-haiku-4.5`; fast `openai/gpt-oss-20b:nitro` → `gemini-3.1-flash-lite`; screenshots `qwen/qwen3.8-27b:nitro` → `google/gemini-3.1-flash-lite` → `meta-llama/llama-4-scout`. `:nitro` routes to the model's fastest host. Measured on a two-screenshot coding problem (all four sections): Qwen 3.8 first text 1.5 s, done 2.0 s, $0.004; Gemini 3.1 Flash-Lite 4.7 s / 7.0 s, $0.002; Llama 4 Scout 1.3 s / 10.8 s, $0.0008. A paid text answer: 0.5 s, under $0.001.

**Screenshots go to** (Settings → Answers) picks the first provider for screenshot answers — e.g. paid OpenRouter while text answers stay on free Groq; the others follow as backups. Screenshot requests to OpenRouter run with thinking off.

How a request is served:
1. **Model chain.** Each model field holds up to 12 IDs (one per line), tried top to bottom. OpenRouter gets 3 per request (it falls through them server-side); Groq and Gemini get one per request. A model that is rate-limited, over its daily quota or not found is **skipped for a while** (the API's `Retry-After`, else 1 min for rate limits, 1 h for daily caps, 10 min for missing models), so later requests don't spend quota on it.
2. **Provider failover.** If the whole chain fails, or the account is out (bad key, no credits, OpenRouter's 50/day cap, Anthropic "credit balance too low"), the next backup provider is used with *its* model chain. An account-wide failure benches that provider for a while (1 h for caps/credits, 10 min for a bad key); saving a new key un-benches it.
3. A reasoning model that uses its whole token budget thinking and returns no text counts as a failure too: it's skipped for 10 minutes and the next model / provider answers. Groq's `qwen` screenshot model runs with thinking off (with images it used to spend the whole budget — and Groq's free 1,000 output tokens/min — thinking).
4. Then the usual answer rules apply (one retry, then the fast models), but models and providers already on cooldown are skipped without a request.

The overlay shows who answered under each answer (e.g. `gpt-oss-120b · Groq`), and the log records it: `answer … [OpenRouter] nvidia/nemotron-3-super-120b-a12b:free via Nvidia …`.

Differences from the direct Anthropic API: thinking is set per provider with **Reasoning effort** (OpenRouter: answers only; Groq and Gemini: answers, with the classifier and summaries always at the lowest setting — Gemini 3 and gpt-oss can't turn reasoning off). Only Anthropic and OpenRouter use the prompt cache breakpoint, and there is no pre-warm outside Anthropic. Free tiers of OpenRouter models and Gemini may log or train on prompts (your resume and the transcript).

### Hotkeys

All are global and rebindable in **Settings → Global hotkeys** (Electron accelerator syntax). Shortcuts are written Windows-style throughout this README; on macOS, `Ctrl` is `⌘` (`Ctrl+Shift+Enter` → `⌘⇧↩`), and the app shows the macOS symbols.

| Action | Default | Available |
|---|---|---|
| Start / stop session | `Ctrl+Shift+Enter` | ✓ |
| Show / hide overlay | `Ctrl+Shift+H` | ✓ |
| Answer last utterance now (Interview) / status quick-pick (Work) | `Ctrl+Shift+Space` | ✓ |
| Regenerate / Shorter | `Ctrl+Shift+R` / `Ctrl+Shift+D` | ✓ (latest answer) |
| Prev / next answer | `Ctrl+Shift+←` / `→` | ✓ |
| Toggle auto-answer | `Ctrl+Shift+A` | ✓ |
| Voice questions on / off | `Ctrl+Shift+M` | ✓ |
| Type a question (focus overlay input) | `Ctrl+Shift+K` | ✓ |
| Screenshot + answer | `Ctrl+Shift+S` | ✓ |
| Add screenshot (answer later) | `Ctrl+Shift+Alt+S` | ✓ |

The overlay header has the same actions as buttons (Answer, Retry, Shorter, ‹ ›). If another program already owns a shortcut, **Settings → Global hotkeys** marks it in red — pick a different one there.

### System tray

Closing the main window hides it to the system tray — the overlay, hotkeys and a running session keep working. Click the tray icon (blue dot) to open the window again; right-click it for Start / stop session, Show / hide overlay, and **Quit Cue**, the only way to exit. Starting the app again while it runs just reopens the window.

### When things go wrong

- **Speech service drops:** the status turns amber and it reconnects on its own (up to 8 tries over ~40 s, buffering 15 s of audio), so a network drop of up to 30 s resumes by itself. A handshake that hasn't finished in 20 s, or an open connection whose audio stops draining for 8 s, is retried. After 3 failed tries in a row the overlay says so. If the transcript is slow to start or keeps reconnecting with Deepgram, switch **Settings → Speech-to-text → Region** (US / EU): some networks reach one far better than the other.
- **A window crashes:** it is reloaded; if the hidden audio-capture page crashes, the session stops with a message so you can start it again.
- **Answer provider fails:** the next model / backup provider answers (see *Answer providers* above).
- Everything is logged to the data folder's `logs/` with keys redacted.

### Data locations

`%APPDATA%\Cue\` on Windows, `~/Library/Application Support/Cue/` on macOS
- `settings.json` — non-secret settings
- `secrets.json` — encrypted API keys
- `profile.json` — resume/JD text, notes and their summaries
- `data.db` — session history and Work Mode projects (SQLite via Node's built-in `node:sqlite`; no native module to rebuild)
- `screenshots\` — only with **Keep screenshots** on
- `pricing.json` — your copy of the price table, once opened from Settings
- `logs\YYYY-MM-DD.log` — app logs (keys redacted, includes renderer errors)

**Settings → Data → Delete all data** removes all of it — history, practice runs, projects, screenshots, profile, settings, API keys and logs — after a confirmation, then restarts the app.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm test` | Vitest unit + integration tests (no network) |
| `npm run typecheck` | TypeScript for main/preload and renderers |
| `npm run build` | Production bundle into `out/` |
| `npm start` | Run the production bundle |
| `npm run dist` | Build the NSIS installer, `dist/Cue-Setup-<version>.exe` (x64, per-user, unsigned) |
| `npm run dist:mac` | Build `dist/Cue-<version>-{x64,arm64}.dmg` and `.zip` (ad-hoc signed, hardened runtime; run on a Mac) |
| `npm run icon` | Redraw `build/icon.png` (Windows) and `build/icon-mac.png` (macOS, made into `.icns` by electron-builder) |
| `npm run mock-teams` | Local stand-in for Teams sign-in and Microsoft Graph, at `http://localhost:4100` (`MOCK_TEAMS_PORT` to change) |

Set `CUE_DATA` to a folder to run the app (dev or packaged) with its own data folder — for testing without touching your real profile, and without colliding with a running copy.

**Latency debug:** **Settings → Debug · latency** shows last / p50 / p95 for STT lag, utterance end → question detected, and utterance end → first answer token (target < 3 s). Each answer's model, serving provider (OpenRouter) and token usage (incl. cached tokens) is logged, e.g. `answer … nvidia/nemotron-3-super-120b-a12b:free via Nvidia in=435 cached=0 out=419`.

### Layout

```
src/
  main/                     Electron main process (all network calls live here)
    index.ts                App wiring + zod-validated IPC handlers
    windows/                main, overlay (frameless, on-top), capture (hidden)
    services/session/       SessionManager: capture -> STT -> transcripts
    services/stt/           SttProvider interface, SocketSttProvider (reconnect/buffer/keep-alive), Deepgram + AssemblyAI providers, TranscriptAssembler
    services/practice/      PracticeService (questions -> answers -> feedback -> debrief), practice prompts
    services/work/          Work Mode: ProjectStore (projects, items, updates, Teams suggestions), projectMatch (projects + items), WorkDetector, workQuestions, ProjectCondenser, workPrompts, teamsImport
    services/teams/         TeamsGraph (device-code sign-in, Microsoft Graph), TeamsSync (polling followed chats)
    services/detect/        QuestionDetector: heuristic + fast-model classifier
    services/llm/           LlmProvider interface, AnthropicProvider, OpenAICompatProvider (OpenRouter/Groq/Gemini), LlmRouter (failover), Cooldowns, prompts
    services/answer/        AnswerService (streaming, retry/fallback), CopilotService (detect -> answer orchestration, screenshots)
    services/screen/        ScreenService (desktopCapturer, downscale, JPEG)
    services/cost/          CostTracker, pricing.json lookup
    services/history/       HistoryService (SQLite), Markdown export
    services/profile/       ProfileService (profile.json + summaries), resume text extraction
    db/                     node:sqlite connection + schema migrations
    services/hotkeys/       globalShortcut registration
    settings/               SettingsStore (JSON + safeStorage)
  preload/                  Typed contextBridge API (window.api)
  shared/                   Channel names, IPC types/zod schemas, settings schema
  renderer/
    main/                   Control panel (React + Zustand + Tailwind)
    overlay/                Overlay (React, streamed Markdown + highlight.js)
    capture/                getDisplayMedia loopback + mic, AudioWorklet -> 16 kHz PCM
config/pricing.json         Default price table (shipped with the app)
tests/                      Vitest
```

Security: context isolation on, sandboxed renderers, `nodeIntegration` off, strict CSP, IPC accepted only from app pages, and audio IPC only from the capture window.

## macOS notes

- **Permissions.** System audio is captured through macOS screen & system audio recording (ScreenCaptureKit), so the first session asks for **Screen & System Audio Recording**; screenshots use the same permission. The mic ("Me" lane, voice questions, Practice) asks for **Microphone**. After granting screen recording, quit and reopen Cue. If access was denied, starting a session opens the right pane in System Settings → Privacy & Security.
- **Rebuilt app = re-grant.** macOS ties the permission to the app's signature; ad-hoc signed builds get a new one each build, so re-enable Cue in System Settings after installing a new build. Signing with a Developer ID (`CSC_NAME`, plus notarization) avoids this.
- **In development** (`npm run dev`) the permissions belong to the app you launch from — your terminal or VS Code — not to Cue.
- **Overlay** floats over full-screen apps and follows you across Spaces. Content protection hides it from most screen sharing, but some recent ScreenCaptureKit-based recorders on macOS 15+ can still capture it — check with your meeting app before relying on it.
- **Hotkeys** use `⌘` where Windows uses `Ctrl`. A few defaults overlap common macOS shortcuts while Cue runs (`⌘⇧Q` log out, `⌘⇧H`/`⌘⇧D`/`⌘⇧A`/`⌘⇧O` in Finder, `⌘⇧S` Save As); rebind them in Settings if they get in the way. A shortcut another app already owns is reported as not registered.
- **Practice voices** come from the macOS system voices (System Settings → Accessibility → Spoken Content adds more).
