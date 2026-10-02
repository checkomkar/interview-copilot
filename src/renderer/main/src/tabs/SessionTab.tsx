import { useApp } from '../store'
import { LevelMeter } from '../components/LevelMeter'
import { Transcript } from '../components/Transcript'
import { formatHotkey } from '../format'

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return h > 0 ? `${h}:${mmss}` : mmss
}

export function SessionTab() {
  const session = useApp((s) => s.session)
  const settings = useApp((s) => s.settings)
  const levels = useApp((s) => s.levels)
  const start = useApp((s) => s.startSession)
  const stop = useApp((s) => s.stopSession)
  const update = useApp((s) => s.updateSettings)
  const clear = useApp((s) => s.clearTranscript)

  const active = session.status === 'starting' || session.status === 'listening' || session.status === 'reconnecting'
  const micOn = (settings?.audio.micEnabled ?? false) || Boolean(session.voiceAsk)
  const autoAnswer = settings?.detection.autoAnswer ?? true

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line px-6 py-4">
        <button
          onClick={() => void (active ? stop() : start())}
          className={`rounded-lg px-5 py-2 text-sm font-semibold transition-colors ${
            active ? 'bg-bad/15 text-bad hover:bg-bad/25' : 'bg-accent text-bg hover:bg-accent/90'
          }`}
        >
          {active ? 'Stop session' : 'Start session'}
        </button>
        {settings && (
          <span className="-ml-3 font-mono text-[11px] text-muted">{formatHotkey(settings.hotkeys.startStop)}</span>
        )}

        <Stat label="Elapsed" value={formatElapsed(session.elapsed)} />
        <Stat label="Cost" value={`$${session.cost.toFixed(2)}`} />

        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted select-none">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={autoAnswer}
            onChange={(e) => void update({ detection: { autoAnswer: e.target.checked } })}
          />
          Auto-answer
        </label>
        <button
          onClick={() => void window.api.ui.toggleOverlay()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
        >
          Toggle overlay
        </button>
      </header>

      {(session.hint || (session.message && session.status !== 'error')) && (
        <div className="border-b border-warn/30 bg-warn/10 px-6 py-2 text-sm text-warn">{session.hint ?? session.message}</div>
      )}

      <section className="flex flex-col gap-2.5 border-b border-line px-6 py-4">
        <LevelMeter label="Interviewer" level={levels.loopback} active={active} color="var(--color-them)" />
        {micOn && <LevelMeter label="Me (mic)" level={levels.mic} active={active} color="var(--color-me)" />}
        <p className="text-[11px] text-muted">
          Captures system audio from your default Windows output device.
          {!micOn && ' Microphone capture is off (enable it in Settings).'}
        </p>
      </section>

      <div className="flex items-center justify-between px-6 pt-3">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Live transcript</h2>
        <button onClick={clear} className="text-xs text-muted hover:text-fg">
          Clear
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Transcript />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] tracking-wide text-muted uppercase">{label}</span>
      <span className="font-mono text-sm tabular-nums">{value}</span>
    </div>
  )
}
