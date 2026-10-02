import { create } from 'zustand'
import type { AudioSource, LatencyStage, NavigateTarget, SessionState, TranscriptUpdate } from '@shared/ipc'
import type { ApiKeyStatus, DeepPartial, Settings } from '@shared/settings'

const MAX_UTTERANCES = 500
const MAX_LATENCY_SAMPLES = 100

interface AppState {
  tab: NavigateTarget
  settings: Settings | null
  keys: ApiKeyStatus | null
  session: SessionState
  utterances: TranscriptUpdate[]
  levels: Record<AudioSource, number>
  latency: Record<LatencyStage, number[]>
  banner: string | null
  setTab: (tab: NavigateTarget) => void
  setBanner: (msg: string | null) => void
  updateSettings: (patch: DeepPartial<Settings>) => Promise<void>
  setApiKey: (provider: keyof ApiKeyStatus, key: string) => Promise<void>
  startSession: () => Promise<void>
  stopSession: () => Promise<void>
  clearTranscript: () => void
}

export const useApp = create<AppState>((set) => ({
  tab: 'session',
  settings: null,
  keys: null,
  session: { status: 'idle', elapsed: 0, cost: 0 },
  utterances: [],
  levels: { loopback: 0, mic: 0 },
  latency: emptyLatency(),
  banner: null,
  setTab: (tab) => set({ tab }),
  setBanner: (banner) => set({ banner }),
  updateSettings: async (patch) => {
    try {
      set({ settings: await window.api.settings.set(patch) })
    } catch (err) {
      set({ banner: errorMessage(err) })
    }
  },
  setApiKey: async (provider, key) => {
    set({ keys: await window.api.settings.setApiKey(provider, key) })
  },
  startSession: async () => {
    set({ banner: null, utterances: [], latency: emptyLatency() })
    const res = await window.api.session.start()
    if (!res.ok) set({ banner: res.error, ...(res.navigate ? { tab: res.navigate } : {}) })
  },
  stopSession: async () => {
    set({ session: await window.api.session.stop() })
  },
  clearTranscript: () => set({ utterances: [] })
}))

function emptyLatency(): Record<LatencyStage, number[]> {
  return { stt: [], detect: [], firstToken: [] }
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function upsert(list: TranscriptUpdate[], u: TranscriptUpdate): TranscriptUpdate[] {
  for (let i = list.length - 1; i >= Math.max(0, list.length - 20); i--) {
    if (list[i].id === u.id) {
      const next = list.slice()
      next[i] = u
      return next
    }
  }
  const next = [...list, u]
  return next.length > MAX_UTTERANCES ? next.slice(-MAX_UTTERANCES) : next
}

export function initStore(): void {
  const { api } = window
  void api.settings.get().then((settings) => useApp.setState({ settings }))
  void api.settings.apiKeyStatus().then((keys) => useApp.setState({ keys }))
  void api.session.getState().then((session) => useApp.setState({ session }))

  api.settings.onChanged((settings) => useApp.setState({ settings }))
  api.session.onState((session) => {
    useApp.setState({ session })
    if (session.status === 'error' && session.message) useApp.setState({ banner: session.message })
  })
  api.session.onTranscript((u) => useApp.setState((s) => ({ utterances: upsert(s.utterances, u) })))
  api.session.onLevel(({ source, rms }) => useApp.setState((s) => ({ levels: { ...s.levels, [source]: rms } })))
  api.session.onLatency((l) =>
    useApp.setState((s) => ({
      latency: { ...s.latency, [l.stage]: [...s.latency[l.stage], l.ms].slice(-MAX_LATENCY_SAMPLES) }
    }))
  )
  api.ui.onNavigate((tab) => useApp.setState({ tab }))
}
