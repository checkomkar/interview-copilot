import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { ZodError } from 'zod'
import {
  ApiKeySetSchema,
  AudioChunkSchema,
  AudioLevelSchema,
  CaptureStatusSchema,
  IPC,
  SessionStartSchema,
  AskSchema,
  VoiceAskSetSchema,
  type AnswerActionResult,
  type NavigateTarget,
  type SessionStartResult,
  type OverlayNav
} from '@shared/ipc'
import type { ResumeImportResult } from '@shared/profile'
import { createLogger, initLogger } from './logger'
import { SettingsStore } from './settings/SettingsStore'
import { SessionManager } from './services/session/SessionManager'
import { DeepgramProvider } from './services/stt/DeepgramProvider'
import { HotkeyService } from './services/hotkeys/HotkeyService'
import { activeModels, LLM_PROVIDER_LABELS, type CompatProviderId } from '@shared/settings'
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
import { createMainWindow } from './windows/mainWindow'
import { createOverlayWindow } from './windows/overlayWindow'
import { createCaptureWindow } from './windows/captureWindow'
import { isAppUrl } from './windows/load'

// Data lives in %APPDATA%/InterviewCopilot (FR-D1).
app.setName('InterviewCopilot')
app.setPath('userData', join(app.getPath('appData'), 'InterviewCopilot'))
initLogger(app.getPath('userData'))
const log = createLogger('main')

if (!app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null

function send(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
function broadcast(channel: string, payload?: unknown): void {
  send(mainWindow, channel, payload)
  send(overlayWindow, channel, payload)
}
function navigate(target: NavigateTarget): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
  mainWindow.show()
  mainWindow.focus()
  send(mainWindow, IPC.uiNavigate, target)
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

function toggleOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (overlayWindow.isVisible()) overlayWindow.hide()
  else overlayWindow.showInactive()
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
    { getSettings: () => settings.get(), hasKey: (id) => Boolean(settings.getApiKey(id)), cooldowns }
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
  const answers = new AnswerService({ provider: llm, getSettings: () => settings.get(), getProfile: () => profiles.get() })
  // Assigned below; voice-question routing needs the session state.
  let isVoiceAsk = () => false
  const copilot = new CopilotService({ detector, answers, getSettings: () => settings.get(), isVoiceAsk: () => isVoiceAsk() })
  copilot.on('question', (q) => broadcast(IPC.questionDetected, q))
  copilot.on('token', (t) => broadcast(IPC.answerToken, t))
  copilot.on('done', (d) => broadcast(IPC.answerDone, d))
  copilot.on('error', (e) => broadcast(IPC.answerError, e))
  copilot.on('reset', () => broadcast(IPC.qaReset))
  copilot.on('latency', (l) => send(mainWindow, IPC.debugLatency, l))

  const sessionManager = new SessionManager({
    getSettings: () => settings.get(),
    getSttApiKey: () => settings.getApiKey('deepgram'),
    createStt: (source, apiKey, s) =>
      new DeepgramProvider({
        apiKey,
        label: source,
        model: s.stt.model,
        language: s.stt.language,
        endpointingMs: s.stt.endpointingMs,
        utteranceEndMs: s.stt.utteranceEndMs
      }),
    startCapture: (payload) => send(captureWindow, IPC.captureStart, payload),
    stopCapture: () => send(captureWindow, IPC.captureStop),
    setMic: (payload) => send(captureWindow, IPC.captureMic, payload)
  })
  isVoiceAsk = () => Boolean(sessionManager.getState().voiceAsk)
  sessionManager.on('state', (s) => {
    broadcast(IPC.sessionState, s)
    if (!sessionManager.isActive()) copilot.stopSession()
  })
  sessionManager.on('transcript', (u) => {
    broadcast(IPC.transcriptUpdate, u)
    copilot.onTranscript(u)
  })
  sessionManager.on('utteranceEnd', (u) => copilot.onUtteranceEnd(u))
  sessionManager.on('latency', (l) => send(mainWindow, IPC.debugLatency, l))

  const startSession = (opts: { keepHistory?: boolean } = {}): SessionStartResult => {
    const wasActive = sessionManager.isActive()
    // Answers need a key for the primary or a fallback provider (PRD §9: block session start, deep-link to Settings).
    const provider = settings.get().llm.provider
    const result: SessionStartResult = llm.candidates().keyed.length > 0
      ? sessionManager.start()
      : { ok: false, error: `Add your ${LLM_PROVIDER_LABELS[provider]} API key in Settings to get answers.`, navigate: 'settings' }
    if (!result.ok && result.navigate) navigate(result.navigate)
    if (result.ok && !wasActive) copilot.startSession(opts)
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
    answerNow: () => void copilot.answerNow(),
    regenerate: () => void copilot.regenerate(),
    shorter: () => void copilot.shorter(),
    prevAnswer: () => navOverlay('prev'),
    nextAnswer: () => navOverlay('next'),
    toggleAutoAnswer: () => {
      settings.update({ detection: { autoAnswer: !settings.get().detection.autoAnswer } })
    },
    toggleVoiceAsk: () => void setVoiceAsk(!sessionManager.getState().voiceAsk),
    focusAsk
  })
  hotkeys.apply(settings.get())
  settings.on('changed', (s) => {
    hotkeys.apply(s)
    broadcast(IPC.settingsChanged, s)
  })

  // --- capture window -> main ---
  ipcMain.on(IPC.audioChunk, (e, payload) => {
    if (!fromCapture(e)) return
    const parsed = AudioChunkSchema.safeParse(payload)
    if (parsed.success) sessionManager.handleAudioChunk(parsed.data)
  })
  ipcMain.on(IPC.audioLevel, (e, payload) => {
    if (!fromCapture(e)) return
    const parsed = AudioLevelSchema.safeParse(payload)
    if (!parsed.success) return
    sessionManager.handleAudioLevel(parsed.data)
    send(mainWindow, IPC.audioLevel, parsed.data)
  })
  ipcMain.on(IPC.captureStatus, (e, payload) => {
    if (!fromCapture(e)) return
    const parsed = CaptureStatusSchema.safeParse(payload)
    if (!parsed.success) return
    log.info(`capture ${parsed.data.source}: ${parsed.data.state}${parsed.data.message ? ` (${parsed.data.message})` : ''}`)
    sessionManager.handleCaptureStatus(parsed.data)
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
  handle(IPC.settingsSet, (_e, patch) => settings.update(patch))
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

  // --- answers (main window + overlay) ---
  handle(IPC.answerNow, () => copilot.answerNow())
  handle(IPC.answerRegenerate, () => copilot.regenerate())
  handle(IPC.answerShorter, () => copilot.shorter())
  handle(IPC.qaList, () => copilot.list())
  handle(IPC.answerAsk, (_e, payload) => copilot.ask(AskSchema.parse(payload).text))
  handle(IPC.voiceAskSet, (_e, payload) => setVoiceAsk(VoiceAskSetSchema.parse(payload).on))

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
  mainWindow = createMainWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
    app.quit()
  })

  app.on('second-instance', () => navigate('session'))
  app.on('will-quit', () => hotkeys.dispose())
  app.on('before-quit', () => void sessionManager.stop())
})

app.on('window-all-closed', () => app.quit())

process.on('uncaughtException', (err) => log.error('uncaught exception', err))
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err))
