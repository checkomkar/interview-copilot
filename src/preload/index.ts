import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/channels'
import type {
  AnswerActionResult,
  AnswerDone,
  AnswerError,
  AnswerToken,
  AudioLevel,
  AudioSource,
  CaptureMicPayload,
  CaptureStartPayload,
  CaptureStatus,
  CostUpdate,
  DisplayInfo,
  LatencySample,
  NavigateTarget,
  OverlayNav,
  QaSnapshot,
  QuestionDetected,
  ScreenshotPending,
  SessionStartResult,
  SessionState,
  TranscriptUpdate
} from '../shared/ipc'
import type { ProfileInput, Profile, ProfileSaveResult, ResumeImportResult } from '../shared/profile'
import type { PracticeResult, PracticeStart, PracticeState } from '../shared/practice'
import type {
  ImportInput,
  ImportResult,
  Project,
  ProjectInput,
  Proposal,
  ProposalDecision,
  TaskInput,
  TeamsSource,
  TeamsStatus,
  WorkPick,
  WorkResult
} from '../shared/work'
import type { HistoryExportResult, HistorySession, HistorySessionSummary } from '../shared/history'
import type { ApiKeyProvider, ApiKeyStatus, DeepPartial, HotkeyAction, Settings } from '../shared/settings'

type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  session: {
    start: (): Promise<SessionStartResult> => ipcRenderer.invoke(IPC.sessionStart, {}),
    stop: (): Promise<SessionState> => ipcRenderer.invoke(IPC.sessionStop),
    getState: (): Promise<SessionState> => ipcRenderer.invoke(IPC.sessionState),
    onState: (cb: (s: SessionState) => void) => subscribe(IPC.sessionState, cb),
    onTranscript: (cb: (u: TranscriptUpdate) => void) => subscribe(IPC.transcriptUpdate, cb),
    onLevel: (cb: (l: AudioLevel) => void) => subscribe(IPC.audioLevel, cb),
    onLatency: (cb: (l: LatencySample) => void) => subscribe(IPC.debugLatency, cb)
  },
  answers: {
    now: (): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.answerNow),
    regenerate: (): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.answerRegenerate),
    shorter: (): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.answerShorter),
    ask: (text: string): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.answerAsk, { text }),
    setVoiceAsk: (on: boolean): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.voiceAskSet, { on }),
    onFocusAsk: (cb: () => void) => subscribe(IPC.overlayFocusAsk, cb),
    list: (): Promise<QaSnapshot[]> => ipcRenderer.invoke(IPC.qaList),
    onQuestion: (cb: (q: QuestionDetected) => void) => subscribe(IPC.questionDetected, cb),
    onToken: (cb: (t: AnswerToken) => void) => subscribe(IPC.answerToken, cb),
    onDone: (cb: (d: AnswerDone) => void) => subscribe(IPC.answerDone, cb),
    onError: (cb: (e: AnswerError) => void) => subscribe(IPC.answerError, cb),
    onReset: (cb: () => void) => subscribe(IPC.qaReset, cb),
    onNav: (cb: (dir: OverlayNav) => void) => subscribe(IPC.overlayNav, cb),
    /** One-off messages for the overlay (hotkey failures, cost cap). */
    onNotice: (cb: (message: string) => void) => subscribe(IPC.overlayNotice, cb)
  },
  screen: {
    capture: (): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.screenCapture),
    /** Add a screenshot to the next answer without answering yet. */
    add: (): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.screenAdd),
    /** Answer from the waiting screenshots. */
    answer: (): Promise<AnswerActionResult> => ipcRenderer.invoke(IPC.screenAnswer),
    /** Remove one waiting screenshot by position, or all. */
    clear: (index?: number): Promise<void> => ipcRenderer.invoke(IPC.screenClear, index === undefined ? {} : { index }),
    pending: (): Promise<ScreenshotPending> => ipcRenderer.invoke(IPC.screenPending),
    displays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke(IPC.screenDisplays),
    onPending: (cb: (p: ScreenshotPending) => void) => subscribe(IPC.screenPending, cb)
  },
  cost: {
    get: (): Promise<CostUpdate> => ipcRenderer.invoke(IPC.costGet),
    onUpdate: (cb: (c: CostUpdate) => void) => subscribe(IPC.costUpdate, cb),
    openPricing: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.costOpenPricing)
  },
  history: {
    list: (): Promise<HistorySessionSummary[]> => ipcRenderer.invoke(IPC.historyList),
    get: (id: string): Promise<HistorySession | null> => ipcRenderer.invoke(IPC.historyGet, { id }),
    delete: (id: string): Promise<HistorySessionSummary[]> => ipcRenderer.invoke(IPC.historyDelete, { id }),
    deleteAll: (): Promise<HistorySessionSummary[]> => ipcRenderer.invoke(IPC.historyDeleteAll),
    exportMarkdown: (id: string): Promise<HistoryExportResult> => ipcRenderer.invoke(IPC.historyExport, { id })
  },
  profile: {
    get: (): Promise<Profile> => ipcRenderer.invoke(IPC.profileGet),
    save: (input: ProfileInput): Promise<ProfileSaveResult> => ipcRenderer.invoke(IPC.profileSave, input),
    importResume: (): Promise<ResumeImportResult> => ipcRenderer.invoke(IPC.profileImportResume)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: DeepPartial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, patch),
    setApiKey: (provider: ApiKeyProvider, key: string): Promise<ApiKeyStatus> =>
      ipcRenderer.invoke(IPC.apiKeySet, { provider, key }),
    apiKeyStatus: (): Promise<ApiKeyStatus> => ipcRenderer.invoke(IPC.apiKeyStatus),
    onChanged: (cb: (s: Settings) => void) => subscribe(IPC.settingsChanged, cb),
    /** Hotkeys that couldn't be registered (another app owns them). */
    hotkeyFailures: (): Promise<HotkeyAction[]> => ipcRenderer.invoke(IPC.hotkeysStatus),
    onHotkeyFailures: (cb: (failed: HotkeyAction[]) => void) => subscribe(IPC.hotkeysStatus, cb)
  },
  practice: {
    getState: (): Promise<PracticeState> => ipcRenderer.invoke(IPC.practiceState),
    onState: (cb: (s: PracticeState) => void) => subscribe(IPC.practiceState, cb),
    start: (opts: PracticeStart): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceStart, opts),
    /** Start recording the spoken answer. */
    record: (): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceRecord),
    /** Stop recording and get feedback. */
    finishAnswer: (): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceFinishAnswer),
    submit: (text: string): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceSubmit, { text }),
    retry: (): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceRetry),
    redo: (): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceRedo),
    skip: (): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceSkip),
    next: (): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceNext),
    finish: (): Promise<PracticeResult> => ipcRenderer.invoke(IPC.practiceFinish),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.practiceReset)
  },
  /** Work Mode project store and status quick-pick (FR-W1..W6). */
  work: {
    list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.workProjects),
    onChanged: (cb: (projects: Project[]) => void) => subscribe(IPC.workProjectsChanged, cb),
    save: (input: ProjectInput): Promise<Project> => ipcRenderer.invoke(IPC.workProjectSave, input),
    delete: (id: string): Promise<Project[]> => ipcRenderer.invoke(IPC.workProjectDelete, { id }),
    saveTask: (input: TaskInput): Promise<Project> => ipcRenderer.invoke(IPC.workTaskSave, input),
    deleteTask: (id: string): Promise<Project | null> => ipcRenderer.invoke(IPC.workTaskDelete, { id }),
    /** `taskId`: the item it is about; `author`: who said it, when not the user. */
    addUpdate: (projectId: string, text: string, opts: { taskId?: string; author?: string } = {}): Promise<Project> =>
      ipcRenderer.invoke(IPC.workUpdateAdd, { projectId, text, ...opts }),
    deleteUpdate: (id: number): Promise<Project | null> => ipcRenderer.invoke(IPC.workUpdateDelete, { id }),
    /** Overlay: a status update on the picked project. */
    status: (projectId: string, question?: string): Promise<WorkResult> =>
      ipcRenderer.invoke(IPC.workStatus, question ? { projectId, question } : { projectId }),
    onPick: (cb: (pick: WorkPick) => void) => subscribe(IPC.workPick, cb),
    /** Pasted Teams text or chat screenshots → proposals for review (FR-T1/T2). */
    importUpdates: (input: ImportInput): Promise<ImportResult> => ipcRenderer.invoke(IPC.workImport, input),
    proposals: (): Promise<Proposal[]> => ipcRenderer.invoke(IPC.workProposals),
    onProposals: (cb: (pending: Proposal[]) => void) => subscribe(IPC.workProposalsChanged, cb),
    decide: (decision: ProposalDecision): Promise<Proposal> => ipcRenderer.invoke(IPC.workProposalDecide, decision)
  },
  /** Teams sync (FR-T3); tokens never reach the renderer. */
  teams: {
    status: (): Promise<TeamsStatus> => ipcRenderer.invoke(IPC.teamsStatus),
    onStatus: (cb: (s: TeamsStatus) => void) => subscribe(IPC.teamsStatus, cb),
    /** Start device-code sign-in; the code shows in the status. */
    signIn: (): Promise<{ userCode: string; verificationUri: string }> => ipcRenderer.invoke(IPC.teamsSignIn),
    openSignIn: (): Promise<void> => ipcRenderer.invoke(IPC.teamsOpenSignIn),
    cancelSignIn: (): Promise<void> => ipcRenderer.invoke(IPC.teamsCancelSignIn),
    signOut: (): Promise<void> => ipcRenderer.invoke(IPC.teamsSignOut),
    sources: (): Promise<TeamsSource[]> => ipcRenderer.invoke(IPC.teamsSources),
    syncNow: (): Promise<TeamsStatus> => ipcRenderer.invoke(IPC.teamsSyncNow)
  },
  app: {
    /** process.platform, for platform-specific text (shortcut symbols on macOS). */
    platform: process.platform,
    info: (): Promise<{ version: string; dataDir: string }> => ipcRenderer.invoke(IPC.appInfo),
    /** Asks for confirmation, wipes history, profile, settings and keys, then restarts the app. */
    deleteAllData: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.appDeleteAllData),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.appQuit)
  },
  ui: {
    onNavigate: (cb: (target: NavigateTarget) => void) => subscribe(IPC.uiNavigate, cb),
    toggleOverlay: (): Promise<void> => ipcRenderer.invoke(IPC.overlayToggle),
    toggleMain: (): Promise<void> => ipcRenderer.invoke(IPC.mainToggle),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.appQuit)
  },
  /** Used only by the hidden capture window. */
  capture: {
    onStart: (cb: (p: CaptureStartPayload) => void) => subscribe(IPC.captureStart, cb),
    onStop: (cb: () => void) => subscribe(IPC.captureStop, cb),
    onMic: (cb: (p: CaptureMicPayload) => void) => subscribe(IPC.captureMic, cb),
    sendChunk: (source: AudioSource, pcm: ArrayBuffer) => ipcRenderer.send(IPC.audioChunk, { source, pcm, ts: Date.now() }),
    sendLevel: (source: AudioSource, rms: number) => ipcRenderer.send(IPC.audioLevel, { source, rms }),
    sendStatus: (status: CaptureStatus) => ipcRenderer.send(IPC.captureStatus, status)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
