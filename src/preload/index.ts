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
  LatencySample,
  NavigateTarget,
  OverlayNav,
  QaSnapshot,
  QuestionDetected,
  SessionStartResult,
  SessionState,
  TranscriptUpdate
} from '../shared/ipc'
import type { ProfileInput, Profile, ProfileSaveResult, ResumeImportResult } from '../shared/profile'
import type { ApiKeyProvider, ApiKeyStatus, DeepPartial, Settings } from '../shared/settings'

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
    onNav: (cb: (dir: OverlayNav) => void) => subscribe(IPC.overlayNav, cb)
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
    onChanged: (cb: (s: Settings) => void) => subscribe(IPC.settingsChanged, cb)
  },
  ui: {
    onNavigate: (cb: (target: NavigateTarget) => void) => subscribe(IPC.uiNavigate, cb),
    toggleOverlay: (): Promise<void> => ipcRenderer.invoke(IPC.overlayToggle)
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
