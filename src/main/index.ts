import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { ZodError } from 'zod'
import {
  ApiKeySetSchema,
  AudioChunkSchema,
  AudioLevelSchema,
  CaptureStatusSchema,
  IPC,
  SessionStartSchema,
  AskSchema,
  ScreenClearSchema,
  VoiceAskSetSchema,
  type AnswerActionResult,
  type NavigateTarget,
  type SessionStartResult,
  type OverlayNav
} from '@shared/ipc'
import type { ResumeImportResult } from '@shared/profile'
import { HistoryIdSchema, type HistoryExportResult } from '@shared/history'
import { PracticeStartSchema, PracticeSubmitSchema } from '@shared/practice'
import {
  ImportSchema,
  ProposalDecisionSchema,
  UpdateAddSchema,
  UpdateIdSchema,
  WorkIdSchema,
  WorkStatusSchema,
  type WorkPick,
  type WorkResult
} from '@shared/work'
import { createLogger, initLogger } from './logger'
import { SettingsStore } from './settings/SettingsStore'
import { SessionManager } from './services/session/SessionManager'
import { DeepgramProvider } from './services/stt/DeepgramProvider'
import { AssemblyAIProvider } from './services/stt/AssemblyAIProvider'
import type { SttProvider } from './services/stt/SttProvider'
import { FallbackSttProvider } from './services/stt/FallbackSttProvider'
import { GroqSttProvider, OpenRouterSttProvider } from './services/stt/ChunkedSttProvider'
import { PracticeService } from './services/practice/PracticeService'
import { HotkeyService } from './services/hotkeys/HotkeyService'
import { activeModels, LLM_PROVIDER_LABELS, splitModels, STT_PROVIDER_LABELS, sttModel, sttProviderOrder, type AppMode, type CompatProviderId, type Settings, type SttProviderId } from '@shared/settings'
import { AnthropicProvider } from './services/llm/AnthropicProvider'
import { OpenAICompatProvider } from './services/llm/OpenAICompatProvider'
import { LlmRouter } from './services/llm/LlmRouter'
import { Cooldowns } from './services/llm/Cooldowns'
import { buildClassifierMessages } from './services/llm/prompts'
import { QuestionDetector } from './services/detect/QuestionDetector'
import { AnswerService } from './services/answer/AnswerService'
import { CopilotService } from './services/answer/CopilotService'
import { ProfileService } from './services/profile/ProfileService'
import { extractDocumentText, RESUME_EXTENSIONS } from './services/profile/documentText'
import { ScreenService } from './services/screen/ScreenService'
import { CostTracker } from './services/cost/CostTracker'
import { EMPTY_PRICING, readPricing, type Pricing } from './services/cost/pricing'
import { HistoryService } from './services/history/HistoryService'
import { exportFileName, sessionToMarkdown } from './services/history/markdown'
import { createMainWindow } from './windows/mainWindow'
import { createOverlayWindow } from './windows/overlayWindow'
import { createCaptureWindow } from './windows/captureWindow'
import { isAppUrl } from './windows/load'
import { ProjectStore } from './services/work/ProjectStore'
import { ProjectCondenser } from './services/work/ProjectCondenser'
import { WorkDetector } from './services/work/WorkDetector'
import { isDifferentTopic, resolveWorkQuestion } from './services/work/workQuestions'
import { TeamsImporter } from './services/work/teamsImport'
import { TeamsGraph } from './services/teams/TeamsGraph'
import { TeamsSync } from './services/teams/TeamsSync'
import { confidentTarget, rankProjects } from './services/work/projectMatch'
import { buildStatusClassifierMessages } from './services/work/workPrompts'
import type { StatusPickRequest } from './services/answer/CopilotService'
import { resolveDataDir } from './dataDir'

// Data lives in %APPDATA%/Cue (FR-D1); a pre-rename InterviewCopilot folder is moved there.
app.setName('Cue')
// CUE_DATA points a test run at its own data folder (and its own single-instance lock).
const dataDir = resolveDataDir(app.getPath('appData'), process.env.CUE_DATA)
app.setPath('userData', dataDir.dir)
initLogger(app.getPath('userData'))
const log = createLogger('main')
if (dataDir.migration === 'moved') log.info('moved data from %APPDATA%/InterviewCopilot to', dataDir.dir)
if (dataDir.migration === 'kept-legacy') log.warn('could not move the InterviewCopilot data folder; still using it:', dataDir.error)

if (!app.requestSingleInstanceLock()) app.quit()

/** Long edge of an imported chat screenshot: big enough to read small Teams text. */
const IMPORT_IMAGE_EDGE = 2400

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
/** Set when the user quits (tray menu); closing the main window otherwise only hides it to the tray. */
let quitting = false

function send(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
function broadcast(channel: string, payload?: unknown): void {
  send(mainWindow, channel, payload)
  send(overlayWindow, channel, payload)
}
function navigate(target: NavigateTarget): void {
  showMainWindow()
  send(mainWindow, IPC.uiNavigate, target)
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = openMainWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Closing the main window hides it to the system tray; the app keeps running until Quit. */
function openMainWindow(): BrowserWindow {
  const win = createMainWindow()
  watchRenderer(win, 'main')
  win.on('minimize', () => {
    win.hide()
  })
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

/** Only accept IPC from our own windows. */
function fromApp(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return isAppUrl(url)
}
function fromCapture(e: IpcMainEvent): boolean {
  return captureWindow !== null && !captureWindow.isDestroyed() && e.sender === captureWindow.webContents
}

function handle<T>(channel: string, fn: (e: IpcMainInvokeEvent, payload: unknown) => T): void {
  ipcMain.handle(channel, async (e, payload) => {
    if (!fromApp(e)) throw new Error('unauthorized sender')
    try {
      return await fn(e, payload)
    } catch (err) {
      if (err instanceof ZodError) throw new Error(`Invalid input: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      throw err
    }
  })
}

/** A crashed renderer is logged and reloaded instead of leaving a blank window (PRD §9). */
function watchRenderer(win: BrowserWindow, name: string, onGone?: () => void): void {
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`${name} renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    onGone?.()
    win.webContents.reload()
  })
  win.webContents.on('unresponsive', () => log.warn(`${name} window is not responding`))
}

function toggleOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (overlayWindow.isVisible()) overlayWindow.hide()
  else overlayWindow.showInactive()
}

function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    showMainWindow()
  }
}

app.whenReady().then(() => {
  const settings = new SettingsStore(app.getPath('userData'))

  // Grant media permissions only to our own pages; deny everything else.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb((permission === 'media' || permission === 'display-capture') && isAppUrl(wc.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    return (permission === 'media' || permission === 'display-capture') && isAppUrl(origin)
  })

  // --- cost (FR-C1..C4) and history (FR-D1/D2) ---
  const bundledPricing = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'config', 'pricing.json')
  const userPricing = join(app.getPath('userData'), 'pricing.json')
  /** The user's copy replaces the bundled table; re-read at the start of each session. */
  const loadPricing = (): Pricing => {
    for (const path of existsSync(userPricing) ? [userPricing, bundledPricing] : [bundledPricing]) {
      try {
        return readPricing(path)
      } catch (err) {
        log.warn(`could not read ${path}; ${path === userPricing ? 'using the bundled prices' : 'costs will show as $0'}`, err)
      }
    }
    return EMPTY_PRICING
  }
  let pricing = loadPricing()
  const cost = new CostTracker({ getPricing: () => pricing, getSettings: () => settings.get() })
  const history = new HistoryService({ dir: app.getPath('userData') })
  const mode = (): AppMode => settings.get().mode
  /** Work calls and interview sessions are kept apart in History (FR-MD1). */
  const historyKind = () => (mode() === 'work' ? ('work' as const) : ('copilot' as const))
  const projects = new ProjectStore({ dir: app.getPath('userData') })
  history.on('opened', () => {
    pricing = loadPricing()
    cost.reset()
  })
  cost.on('update', (u) => {
    broadcast(IPC.costUpdate, u)
    history.updateTotals(u.usd, u.sttSeconds)
  })
  cost.on('status', (status, u) => {
    const notice =
      status === 'capped'
        ? `Session cost cap reached ($${u.capUsd.toFixed(2)}) — answers now use the fast models.`
        : `Session cost is at 80% of the $${u.capUsd.toFixed(2)} cap.`
    send(overlayWindow, IPC.overlayNotice, notice)
  })

  const cooldowns = new Cooldowns()
  const compat = (id: CompatProviderId) =>
    new OpenAICompatProvider({
      id,
      cooldowns,
      getApiKey: () => settings.getApiKey(id),
      getReasoningEffort: () => settings.get().llm[id].reasoningEffort
    })
  const llm = new LlmRouter(
    {
      anthropic: new AnthropicProvider(() => settings.getApiKey('anthropic')),
      openrouter: compat('openrouter'),
      groq: compat('groq'),
      gemini: compat('gemini')
    },
    {
      getSettings: () => settings.get(),
      hasKey: (id) => Boolean(settings.getApiKey(id)),
      cooldowns,
      // Only usage inside a history session counts (not profile summaries made from the Profile tab).
      onUsage: (usage, req) => {
        if (!history.currentId()) return
        history.recordUsage(usage, req.purpose, cost.addLlm(usage))
      }
    }
  )
  const profiles = new ProfileService({ dir: app.getPath('userData'), provider: llm, getSettings: () => settings.get() })
  const detector = new QuestionDetector({
    minWords: () => settings.get().detection.minWords,
    classify: async (utterance, context, signal) => {
      const res = await llm.complete({
        model: activeModels(settings.get()).fastModel,
        role: 'fast',
        purpose: 'classify',
        system: [],
        messages: buildClassifierMessages(utterance, context),
        maxTokens: 200,
        signal
      })
      return res.text
    }
  })
  const workDetector = new WorkDetector({
    getProjects: () => projects.list(),
    minWords: () => settings.get().detection.minWords,
    classify: async (utterance, context, list, signal) => {
      const res = await llm.complete({
        model: activeModels(settings.get()).fastModel,
        role: 'fast',
        purpose: 'classify',
        system: [],
        messages: buildStatusClassifierMessages(utterance, context, list),
        maxTokens: 200,
        signal
      })
      return res.text
    }
  })
  /** Teams messages → proposals for review (FR-T1..T4). */
  const importer = new TeamsImporter({
    llm,
    store: projects,
    getSettings: () => settings.get(),
    getOwner: () => profiles.get().name.trim() || 'the user'
  })
  /** Teams sync (FR-T3): the refresh token is kept encrypted with the API keys. */
  const teamsGraph = new TeamsGraph({
    getConfig: () => settings.get().work.teams,
    getRefreshToken: () => settings.getSecret('teamsRefreshToken'),
    setRefreshToken: (token) => settings.setSecret('teamsRefreshToken', token)
  })
  const teams = new TeamsSync({ graph: teamsGraph, importer, store: projects, getSettings: () => settings.get() })
  const condenser = new ProjectCondenser({
    store: projects,
    complete: async (messages) =>
      (await llm.complete({ model: activeModels(settings.get()).fastModel, role: 'fast', purpose: 'summary', system: [], messages, maxTokens: 400 })).text
  })
  const answers = new AnswerService({
    provider: llm,
    getSettings: () => settings.get(),
    getProfile: () => profiles.get(),
    isCapped: () => cost.isCapped(),
    getMode: mode,
    projects
  })
  const screens = new ScreenService()
  /** The overlay is faded out for a hotkey screenshot so it doesn't cover what's behind it. */
  const captureScreen = async ({ manual }: { manual: boolean }) => {
    const { displayId, maxEdgePx } = settings.get().screen
    const overlay = overlayWindow
    const fade = manual && overlay !== null && !overlay.isDestroyed() && overlay.isVisible()
    if (fade) {
      overlay.setOpacity(0)
      await delay(150)
    }
    try {
      return await screens.capture({ displayId, maxEdgePx })
    } finally {
      if (fade && !overlay.isDestroyed()) overlay.setOpacity(settings.get().overlay.opacity)
    }
  }
  // Assigned below; voice-question routing needs the session state.
  let isVoiceAsk = () => false
  const copilot = new CopilotService({
    // Interview Mode looks for interview questions; Work Mode for status questions (FR-W8).
    detector: { detect: (utterances, context) => (mode() === 'work' ? workDetector.detect(utterances, context) : detector.detect(utterances, context)) },
    answers,
    getSettings: () => settings.get(),
    isVoiceAsk: () => isVoiceAsk(),
    captureScreen,
    getMode: mode,
    projectName: (id, taskId) => {
      const p = projects.get(id)
      if (!p) return null
      const item = taskId ? p.tasks.find((t) => t.id === taskId) : undefined
      return item ? `${p.name} · ${item.title}` : p.name
    },
    // Typed and voice questions in Work Mode are status-checked like heard speech (FR-W6).
    resolveQuestion: (text) => resolveWorkQuestion(text, projects.list()),
    // A question naming another project or item is never folded into the previous one (FR-W10).
    differentTopic: (prev, text) => mode() === 'work' && isDifferentTopic(prev, text, projects.list())
  })
  /** Which history session each Q&A belongs to (an answer may finish after its session stopped). */
  const qaSession = new Map<string, string>()
  /** The listening session stopped while an answer was still streaming: close history once it settles. */
  let closeHistoryWhenIdle = false
  copilot.on('question', (q) => {
    if (!qaSession.has(q.id)) qaSession.set(q.id, history.ensure(historyKind()))
    broadcast(IPC.questionDetected, q)
  })
  copilot.on('settled', (qa, { screenshots }) => {
    history.saveQa(qa, { screenshots, keep: settings.get().keepScreenshots, sessionId: qaSession.get(qa.id) })
    if (closeHistoryWhenIdle && !copilot.isBusy()) {
      closeHistoryWhenIdle = false
      history.close()
    }
  })
  copilot.on('screenshot', (p) => send(overlayWindow, IPC.screenPending, p))
  copilot.on('token', (t) => broadcast(IPC.answerToken, t))
  copilot.on('done', (d) => broadcast(IPC.answerDone, d))
  copilot.on('error', (e) => broadcast(IPC.answerError, e))
  copilot.on('reset', () => broadcast(IPC.qaReset))
  copilot.on('latency', (l) => send(mainWindow, IPC.debugLatency, l))

  /**
   * Work Mode quick-pick (FR-W6/W9): the projects, best guess first. `focus`: the user asked for it
   * (hotkey), so the overlay takes the keyboard for ↑↓ / 1–9 / Enter / Esc.
   */
  const showPick = (req: StatusPickRequest, opts: { focus?: boolean } = {}): WorkResult => {
    const list = projects.list()
    if (list.length === 0) {
      const error = 'Add your projects in the Projects tab first — status updates are written from them.'
      send(overlayWindow, IPC.overlayNotice, error)
      return { ok: false, error }
    }
    const ranked = req.question ? rankProjects(req.question, list).map((m) => m.project.id) : []
    const suggestedId = req.suggestedId ?? ranked[0] ?? null
    const order = [...new Set([...(suggestedId ? [suggestedId] : []), ...ranked, ...list.map((p) => p.id)])]
    const byId = new Map(list.map((p) => [p.id, p]))
    const pick: WorkPick = {
      question: req.question,
      projects: order.flatMap((id) => {
        const p = byId.get(id)
        return p ? [{ id: p.id, name: p.name, status: p.status }] : []
      }),
      suggestedId,
      ts: Date.now()
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (opts.focus) {
        overlayWindow.show()
        overlayWindow.focus()
      } else if (!overlayWindow.isVisible()) overlayWindow.showInactive()
    }
    send(overlayWindow, IPC.workPick, pick)
    return { ok: true }
  }
  copilot.on('pick', (req) => void showPick(req))

  /**
   * Work Mode commands typed in the overlay (FR-W3/W6): "status <project or item>" and
   * "update <project or item>: <text>". Null when the text isn't a command.
   */
  const workCommand = (text: string): WorkResult | null => {
    const update = /^(?:update|log)\s+(.+?)\s*:\s*([\s\S]+)$/i.exec(text)
    if (update) {
      const target = confidentTarget(update[1], projects.list())
      if (!target) return { ok: false, error: `Which project or item is "${update[1]}"? Use a name or alias from the Projects tab.` }
      projects.addUpdate(target.project.id, update[2], { taskId: target.task?.id })
      send(overlayWindow, IPC.overlayNotice, `Update logged on ${target.project.name}${target.task ? ` · ${target.task.title}` : ''}.`)
      return { ok: true }
    }
    const status = /^status(?:\s+(?:of|on|for|update on))?(?:\s+(.*))?$/i.exec(text)
    if (status) {
      const name = status[1]?.trim() ?? ''
      const match = name ? confidentTarget(name, projects.list()) : null
      if (match) return copilot.askStatus(match.project.id, undefined, match.task?.id)
      return showPick({ question: '', suggestedId: name ? (rankProjects(name, projects.list())[0]?.project.id ?? null) : null }, { focus: true })
    }
    return null
  }

  /** Which STT provider each lane is using right now (fallbacks change it mid-session). */
  const activeStt = new Map<string, SttProviderId>()
  /** The main STT provider, then the backups that have a key (FR-S1..S3). */
  const sttChain = (s: Settings) => sttProviderOrder(s).filter((id) => settings.getApiKey(id))
  const createSttFor = (id: SttProviderId, source: string, apiKey: string, s: Settings): SttProvider => {
    const chunked = { apiKey, label: source, language: s.stt.language, silenceMs: s.stt.utteranceEndMs, models: splitModels(sttModel(s, id)) }
    switch (id) {
      case 'assemblyai':
        return new AssemblyAIProvider({
          apiKey,
          label: source,
          model: s.stt.assemblyaiModel,
          language: s.stt.language,
          minTurnSilenceMs: s.stt.endpointingMs,
          maxTurnSilenceMs: s.stt.utteranceEndMs
        })
      case 'openrouter':
        return new OpenRouterSttProvider(chunked)
      case 'groq':
        return new GroqSttProvider(chunked)
      default:
        return new DeepgramProvider({
          apiKey,
          label: source,
          model: s.stt.model,
          language: s.stt.language,
          endpointingMs: s.stt.endpointingMs,
          utteranceEndMs: s.stt.utteranceEndMs
        })
    }
  }
  const createStt = (source: string, _apiKey: string, s: Settings): SttProvider =>
    new FallbackSttProvider(
      sttChain(s).map((id) => ({
        id,
        label: STT_PROVIDER_LABELS[id],
        create: () => createSttFor(id, source, settings.getApiKey(id) ?? '', s)
      })),
      { onActive: (id) => activeStt.set(source, id as SttProviderId) }
    )
  const audioDeps = {
    getSettings: () => settings.get(),
    getSttApiKey: () => {
      const id = sttChain(settings.get())[0]
      return id ? settings.getApiKey(id) : null
    },
    createStt,
    startCapture: (payload: Parameters<typeof send>[2]) => send(captureWindow, IPC.captureStart, payload),
    stopCapture: () => send(captureWindow, IPC.captureStop),
    setMic: (payload: Parameters<typeof send>[2]) => send(captureWindow, IPC.captureMic, payload),
    onAudioSent: (source: string, seconds: number) => {
      const s = settings.get()
      const id = activeStt.get(source) ?? s.stt.provider
      if (history.currentId()) cost.addStt(id, splitModels(sttModel(s, id))[0] ?? '', seconds)
    },
    getCost: () => cost.total()
  }
  const sessionManager = new SessionManager(audioDeps)
  /** Practice Mode listens to the mic alone; it never runs alongside a live session. */
  const practiceAudio = new SessionManager({ ...audioDeps, sources: () => ['mic'] })
  isVoiceAsk = () => Boolean(sessionManager.getState().voiceAsk)
  sessionManager.on('state', (s) => {
    broadcast(IPC.sessionState, s)
    if (sessionManager.isActive()) return
    copilot.stopSession()
    if (!history.currentId()) return
    if (copilot.isBusy()) closeHistoryWhenIdle = true
    else history.close()
  })
  sessionManager.on('transcript', (u) => {
    broadcast(IPC.transcriptUpdate, u)
    copilot.onTranscript(u)
  })
  sessionManager.on('utteranceEnd', (u) => {
    history.recordUtterance(u)
    copilot.onUtteranceEnd(u)
  })
  sessionManager.on('latency', (l) => send(mainWindow, IPC.debugLatency, l))
  sessionManager.on('notice', (message) => send(overlayWindow, IPC.overlayNotice, message))

  const practice = new PracticeService({
    llm,
    getSettings: () => settings.get(),
    getProfile: () => profiles.get(),
    history,
    audio: practiceAudio,
    isLiveSessionActive: () => sessionManager.isActive()
  })
  practice.on('state', (s) => send(mainWindow, IPC.practiceState, s))
  practiceAudio.on('transcript', (u) => practice.onTranscript(u))
  practiceAudio.on('state', (s) => {
    if (s.status === 'error') practice.onAudioFailed(s.message ?? 'Recording stopped.')
  })

  const startSession = (opts: { keepHistory?: boolean } = {}): SessionStartResult => {
    if (practice.isRunning()) return { ok: false, error: 'Finish the practice run first (Practice tab).', navigate: 'practice' }
    const wasActive = sessionManager.isActive()
    // Answers need a key for the primary or a fallback provider (PRD §9: block session start, deep-link to Settings).
    const provider = settings.get().llm.provider
    const result: SessionStartResult = llm.candidates().keyed.length > 0
      ? sessionManager.start()
      : { ok: false, error: `Add your ${LLM_PROVIDER_LABELS[provider]} API key in Settings to get answers.`, navigate: 'settings' }
    if (!result.ok && result.navigate) navigate(result.navigate)
    if (result.ok && !wasActive) {
      closeHistoryWhenIdle = false
      // Turning on voice questions keeps the Q&As (and history session) already on screen.
      if (opts.keepHistory) history.ensure(historyKind())
      else history.open(historyKind())
      copilot.startSession(opts)
    }
    return result
  }

  const navOverlay = (dir: OverlayNav) => send(overlayWindow, IPC.overlayNav, dir)

  /** Voice questions; turning them on starts a session if none is running. */
  const setVoiceAsk = (on: boolean): AnswerActionResult => {
    if (on && !sessionManager.isActive()) {
      const started = startSession({ keepHistory: true })
      if (!started.ok) return { ok: false, error: started.error }
    }
    const res = sessionManager.setVoiceAsk(on)
    if (!res.ok && res.navigate) navigate(res.navigate)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  }
  const focusAsk = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    overlayWindow.show()
    overlayWindow.focus()
    send(overlayWindow, IPC.overlayFocusAsk)
  }
  const hotkeys = new HotkeyService({
    startStop: () => (sessionManager.isActive() ? void sessionManager.stop() : void startSession()),
    toggleOverlay,
    toggleMain: () => toggleMainWindow(),
    quitApp: () => {
      quitting = true
      app.quit()
    },
    // Work Mode: the status quick-pick, which takes the keyboard (FR-W6).
    answerNow: () => {
      if (mode() === 'work') void showPick({ question: copilot.lastHeard(), suggestedId: null }, { focus: true })
      else void copilot.answerNow()
    },
    regenerate: () => void copilot.regenerate(),
    shorter: () => void copilot.shorter(),
    prevAnswer: () => navOverlay('prev'),
    nextAnswer: () => navOverlay('next'),
    toggleAutoAnswer: () => {
      settings.update({ detection: { autoAnswer: !settings.get().detection.autoAnswer } })
    },
    toggleVoiceAsk: () => void setVoiceAsk(!sessionManager.getState().voiceAsk),
    focusAsk,
    screenshot: () =>
      void copilot.captureScreen().then((res) => {
        if (!res.ok) send(overlayWindow, IPC.overlayNotice, res.error)
      }),
    addScreenshot: () =>
      void copilot.addScreenshot().then((res) => {
        if (!res.ok) send(overlayWindow, IPC.overlayNotice, res.error)
      })
  })
  /** Hotkeys another app already owns, shown in Settings instead of only being logged. */
  let hotkeyFailures = hotkeys.apply(settings.get())
  settings.on('changed', (s) => {
    teams.refresh()
    hotkeyFailures = hotkeys.apply(s)
    send(mainWindow, IPC.hotkeysStatus, hotkeyFailures)
    cost.refresh()
    broadcast(IPC.settingsChanged, s)
  })

  // --- capture window -> main ---
  ipcMain.on(IPC.audioChunk, (e, payload) => {
    if (!fromCapture(e)) return
    const parsed = AudioChunkSchema.safeParse(payload)
    if (!parsed.success) return
    sessionManager.handleAudioChunk(parsed.data)
    practiceAudio.handleAudioChunk(parsed.data)
  })
  ipcMain.on(IPC.audioLevel, (e, payload) => {
    if (!fromCapture(e)) return
    const parsed = AudioLevelSchema.safeParse(payload)
    if (!parsed.success) return
    sessionManager.handleAudioLevel(parsed.data)
    practiceAudio.handleAudioLevel(parsed.data)
    send(mainWindow, IPC.audioLevel, parsed.data)
  })
  ipcMain.on(IPC.captureStatus, (e, payload) => {
    if (!fromCapture(e)) return
    const parsed = CaptureStatusSchema.safeParse(payload)
    if (!parsed.success) return
    log.info(`capture ${parsed.data.source}: ${parsed.data.state}${parsed.data.message ? ` (${parsed.data.message})` : ''}`)
    sessionManager.handleCaptureStatus(parsed.data)
    practiceAudio.handleCaptureStatus(parsed.data)
  })

  // --- main window -> main ---
  handle(IPC.sessionStart, (_e, payload) => {
    SessionStartSchema.parse(payload)
    return startSession()
  })
  handle(IPC.sessionStop, async () => {
    await sessionManager.stop()
    return sessionManager.getState()
  })
  handle(IPC.sessionState, () => sessionManager.getState())
  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSet, (_e, patch) => {
    const next = (patch as { mode?: unknown } | null)?.mode
    // FR-MD1: the mode is chosen before a session and locked while one runs.
    if (next !== undefined && next !== settings.get().mode && sessionManager.isActive()) {
      throw new Error('Stop the session before switching modes.')
    }
    return settings.update(patch)
  })
  handle(IPC.apiKeyStatus, () => settings.apiKeyStatus())
  handle(IPC.apiKeySet, (_e, payload) => {
    const { provider, key } = ApiKeySetSchema.parse(payload)
    settings.setApiKey(provider, key)
    // A new key may fix what put this provider (or its models) on cooldown.
    cooldowns.clear(`provider:${provider}`)
    cooldowns.clear(`${provider}:`)
    return settings.apiKeyStatus()
  })
  handle(IPC.overlayToggle, () => toggleOverlay())
  handle(IPC.mainToggle, () => toggleMainWindow())
  handle(IPC.appQuit, () => {
    quitting = true
    app.quit()
  })
  handle(IPC.hotkeysStatus, () => hotkeyFailures)

  // --- answers (main window + overlay) ---
  handle(IPC.answerNow, () => copilot.answerNow())
  handle(IPC.answerRegenerate, () => copilot.regenerate())
  handle(IPC.answerShorter, () => copilot.shorter())
  handle(IPC.qaList, () => copilot.list())
  handle(IPC.answerAsk, (_e, payload) => {
    const text = AskSchema.parse(payload).text
    return (mode() === 'work' ? workCommand(text.trim()) : null) ?? copilot.ask(text)
  })
  handle(IPC.voiceAskSet, (_e, payload) => setVoiceAsk(VoiceAskSetSchema.parse(payload).on))

  // --- work mode (FR-W1..W6) ---
  projects.on('changed', (id) => {
    send(mainWindow, IPC.workProjectsChanged, projects.list())
    condenser.schedule(id)
  })
  projects.on('proposals', () => send(mainWindow, IPC.workProposalsChanged, projects.proposals()))
  handle(IPC.workImport, async (_e, payload) => {
    const input = ImportSchema.parse(payload)
    if ('text' in input) return importer.run({ text: input.text })
    // Chat screenshots: JPEG, large enough to read small Teams text.
    const images = input.images.map((url) => {
      let img = nativeImage.createFromDataURL(url)
      if (img.isEmpty()) throw new Error('One of the screenshots could not be read.')
      const { width, height } = img.getSize()
      const scale = Math.min(1, IMPORT_IMAGE_EDGE / Math.max(width, height))
      if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
      return { type: 'image' as const, mediaType: 'image/jpeg' as const, data: img.toJPEG(85).toString('base64') }
    })
    return importer.run({ images })
  })
  handle(IPC.workProposals, () => projects.proposals())
  teams.on('status', (s) => send(mainWindow, IPC.teamsStatus, s))
  handle(IPC.teamsStatus, () => teams.status())
  handle(IPC.teamsSignIn, () => teams.signIn())
  // Only the sign-in page Teams sync itself asked for is opened, never a URL from the renderer.
  handle(IPC.teamsOpenSignIn, async () => {
    const uri = teams.status().signIn?.verificationUri
    if (uri && /^https?:\/\//i.test(uri)) await shell.openExternal(uri)
  })
  handle(IPC.teamsCancelSignIn, () => teams.cancelSignIn())
  handle(IPC.teamsSignOut, () => teams.signOut())
  handle(IPC.teamsSources, () => teams.listSources())
  handle(IPC.teamsSyncNow, async () => {
    await teams.syncNow()
    return teams.status()
  })
  void teams.start()
  handle(IPC.workProposalDecide, (_e, payload) => projects.decideProposal(ProposalDecisionSchema.parse(payload)))
  handle(IPC.workProjects, () => projects.list())
  handle(IPC.workProjectSave, (_e, payload) => projects.save(payload))
  handle(IPC.workProjectDelete, (_e, payload) => {
    projects.delete(WorkIdSchema.parse(payload).id)
    return projects.list()
  })
  handle(IPC.workTaskSave, (_e, payload) => projects.saveTask(payload))
  handle(IPC.workTaskDelete, (_e, payload) => projects.deleteTask(WorkIdSchema.parse(payload).id))
  handle(IPC.workUpdateAdd, (_e, payload) => {
    const { projectId, taskId, text, author } = UpdateAddSchema.parse(payload)
    return projects.addUpdate(projectId, text, { taskId, author })
  })
  handle(IPC.workUpdateDelete, (_e, payload) => projects.deleteUpdate(UpdateIdSchema.parse(payload).id))
  handle(IPC.workStatus, (_e, payload) => {
    const { projectId, taskId, question } = WorkStatusSchema.parse(payload)
    // Picked a project for a question that names one of its items: answer about that item.
    const project = projects.get(projectId)
    const item = taskId ?? (question && project ? confidentTarget(question, [project])?.task?.id : undefined)
    return copilot.askStatus(projectId, question, item)
  })
  // Recompute summaries that went stale while the app was closed (or failed last time).
  for (const p of projects.list()) condenser.schedule(p.id)

  // --- screen ---
  handle(IPC.screenCapture, () => copilot.captureScreen())
  handle(IPC.screenAdd, () => copilot.addScreenshot())
  handle(IPC.screenAnswer, () => copilot.answerScreenshots())
  handle(IPC.screenClear, (_e, payload) => copilot.clearScreenshot(ScreenClearSchema.parse(payload)?.index))
  handle(IPC.screenPending, () => copilot.pendingScreenshot())
  handle(IPC.screenDisplays, () => screens.listDisplays())

  // --- cost ---
  handle(IPC.costGet, () => cost.snapshot())
  handle(IPC.costOpenPricing, async () => {
    if (!existsSync(userPricing)) copyFileSync(bundledPricing, userPricing)
    const error = await shell.openPath(userPricing)
    return error ? { ok: false, error } : { ok: true }
  })

  // --- history ---
  handle(IPC.historyList, () => history.list())
  handle(IPC.historyGet, (_e, payload) => history.get(HistoryIdSchema.parse(payload).id))
  handle(IPC.historyDelete, (_e, payload) => {
    history.delete(HistoryIdSchema.parse(payload).id)
    return history.list()
  })
  handle(IPC.historyDeleteAll, async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      type: 'warning' as const,
      buttons: ['Delete everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Delete all history',
      message: 'Delete every saved session, transcript, answer and screenshot?',
      detail: 'This cannot be undone. Your profile, settings and API keys are kept.'
    }
    const { response } = owner ? await dialog.showMessageBox(owner, opts) : await dialog.showMessageBox(opts)
    if (response === 0) history.deleteAll()
    return history.list()
  })
  handle(IPC.historyExport, async (e, payload): Promise<HistoryExportResult> => {
    const s = history.get(HistoryIdSchema.parse(payload).id)
    if (!s) return { ok: false, error: 'Session not found.' }
    const owner = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Export session',
      defaultPath: join(app.getPath('documents'), exportFileName(s.startedAt, s.kind)),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const pick = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts)
    if (pick.canceled || !pick.filePath) return { ok: false, canceled: true }
    writeFileSync(pick.filePath, sessionToMarkdown(s), 'utf8')
    return { ok: true, path: pick.filePath }
  })

  // --- practice (FR-P1..P4) ---
  handle(IPC.practiceState, () => practice.getState())
  handle(IPC.practiceStart, (_e, payload) => {
    const opts = PracticeStartSchema.parse(payload)
    settings.update({ practice: { round: opts.round, count: opts.count } })
    return practice.start(opts).then((res) => {
      if (!res.ok && res.navigate) navigate(res.navigate)
      return res
    })
  })
  handle(IPC.practiceRecord, () => {
    const res = practice.record()
    if (!res.ok && res.navigate) navigate(res.navigate)
    return res
  })
  handle(IPC.practiceFinishAnswer, () => practice.finishAnswer())
  handle(IPC.practiceSubmit, (_e, payload) => practice.submit(PracticeSubmitSchema.parse(payload).text))
  handle(IPC.practiceRetry, () => practice.retryFeedback())
  handle(IPC.practiceRedo, () => practice.redo())
  handle(IPC.practiceSkip, () => practice.skip())
  handle(IPC.practiceNext, () => practice.next())
  handle(IPC.practiceFinish, () => practice.finish())
  handle(IPC.practiceReset, () => practice.reset())

  // --- app ---
  handle(IPC.appInfo, () => ({ version: app.getVersion(), dataDir: app.getPath('userData') }))
  /** FR-D5: wipe everything the app stored on this PC, then start fresh. */
  handle(IPC.appDeleteAllData, async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      type: 'warning' as const,
      buttons: ['Delete everything and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Delete all data',
      message: 'Delete all Cue data on this PC?',
      detail: 'History, transcripts, screenshots, practice runs, projects, your profile, settings, API keys and logs. This cannot be undone.'
    }
    const { response } = owner ? await dialog.showMessageBox(owner, opts) : await dialog.showMessageBox(opts)
    if (response !== 0) return { ok: false }
    log.info('deleting all data at the user\'s request')
    await practice.dispose()
    await Promise.all([sessionManager.stop(), practiceAudio.stop()])
    hotkeys.dispose()
    teams.dispose()
    condenser.dispose()
    projects.dispose()
    history.dispose()
    const dir = app.getPath('userData')
    for (const name of ['data.db', 'data.db-wal', 'data.db-shm', 'screenshots', 'profile.json', 'settings.json', 'secrets.json', 'pricing.json', 'logs']) {
      try {
        rmSync(join(dir, name), { recursive: true, force: true })
      } catch (err) {
        log.warn(`could not delete ${name}`, err)
      }
    }
    quitting = true
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })

  // --- profile ---
  handle(IPC.profileGet, () => profiles.get())
  handle(IPC.profileSave, (_e, payload) => profiles.save(payload))
  handle(IPC.profileImportResume, async (e): Promise<ResumeImportResult> => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Import resume', properties: ['openFile' as const], filters: [{ name: 'Resume', extensions: RESUME_EXTENSIONS }] }
    const pick = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true }
    try {
      return { ok: true, ...(await extractDocumentText(pick.filePaths[0])) }
    } catch (err) {
      log.warn('resume import failed', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  captureWindow = createCaptureWindow()
  overlayWindow = createOverlayWindow(settings)
  mainWindow = openMainWindow()
  // Audio stops with a crashed capture page; end the session with a clear message rather than hang.
  watchRenderer(captureWindow, 'capture', () => {
    if (sessionManager.isActive()) void sessionManager.stop({ error: 'Audio capture crashed — start the session again.' })
    if (practiceAudio.isActive()) void practiceAudio.stop({ error: 'Audio capture crashed — record the answer again.' })
  })
  watchRenderer(overlayWindow, 'overlay')
  // Closing the overlay (Alt+F4) only hides it; Ctrl+Shift+H brings it back. Quit is explicit.
  overlayWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    overlayWindow?.hide()
  })

  // System tray icon disabled (controls available via overlay header and Ctrl+Shift+O / Ctrl+Shift+Q)

  app.on('second-instance', () => navigate('session'))
  app.on('will-quit', () => {
    hotkeys.dispose()
    teams.dispose()
    condenser.dispose()
    projects.dispose()
    history.dispose()
  })
  app.on('before-quit', () => {
    quitting = true
    void practice.dispose()
    void sessionManager.stop()
    void practiceAudio.stop()
  })
})

// Windows hidden to the tray don't count as closed; this only fires if every window is destroyed.
app.on('window-all-closed', () => {
  if (quitting) app.quit()
})

process.on('uncaughtException', (err) => log.error('uncaught exception', err))
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err))
