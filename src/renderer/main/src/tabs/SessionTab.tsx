import type { CostUpdate } from '@shared/ipc'
import { APP_MODES, APP_MODE_LABELS } from '@shared/settings'
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
  const cost = useApp((s) => s.cost)
  const start = useApp((s) => s.startSession)
  const stop = useApp((s) => s.stopSession)
  const update = useApp((s) => s.updateSettings)
  const clear = useApp((s) => s.clearTranscript)

  const active = session.status === 'starting' || session.status === 'listening' || session.status === 'reconnecting'
  const micOn = (settings?.audio.micEnabled ?? false) || Boolean(session.voiceAsk)
  const autoAnswer = settings?.detection.autoAnswer ?? true
  const mode = settings?.mode ?? 'work'
  const work = mode === 'work'

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line px-6 py-4">
        <div
          role="radiogroup"
          aria-label="Mode"
          className="flex rounded-lg border border-line p-0.5"
          title={active ? 'Stop the session to switch modes' : 'Work: status updates from your projects. Interview: interview answers from your profile.'}
        >
          {APP_MODES.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              disabled={active}
              onClick={() => void update({ mode: m })}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed ${
                mode === m ? 'bg-raised font-medium text-fg' : 'text-muted hover:text-fg disabled:hover:text-muted'
              }`}
            >
              {APP_MODE_LABELS[m]}
            </button>
          ))}
        </div>
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
        <Stat
          label={cost?.capUsd ? `Cost · cap $${cost.capUsd.toFixed(2)}` : 'Cost'}
          value={`$${(cost?.usd ?? session.cost).toFixed(2)}`}
          tone={cost?.status === 'capped' ? 'text-bad' : cost?.status === 'warn' ? 'text-warn' : undefined}
          title={cost ? costTitle(cost) : undefined}
        />

        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted select-none">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={autoAnswer}
            onChange={(e) => void update({ detection: { autoAnswer: e.target.checked } })}
          />
          {work ? 'Auto-detect status questions' : 'Auto-answer'}
        </label>
        <button
          onClick={() => void window.api.ui.toggleOverlay()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
        >
          Toggle overlay
        </button>
      </header>

      {cost && cost.status !== 'ok' && (
        <div className={`border-b px-6 py-2 text-sm ${cost.status === 'capped' ? 'border-bad/30 bg-bad/10 text-bad' : 'border-warn/30 bg-warn/10 text-warn'}`}>
          {cost.status === 'capped'
            ? `Cost cap of $${cost.capUsd.toFixed(2)} reached — answers now use the fast models. Raise the cap in Settings → Cost.`
            : `Session cost is over 80% of the $${cost.capUsd.toFixed(2)} cap.`}
        </div>
      )}
      {(session.hint || (session.message && session.status !== 'error')) && (
        <div className="border-b border-warn/30 bg-warn/10 px-6 py-2 text-sm text-warn">{session.hint ?? session.message}</div>
      )}

      <section className="flex flex-col gap-2.5 border-b border-line px-6 py-4">
        <LevelMeter label={work ? 'Call' : 'Interviewer'} level={levels.loopback} active={active} color="var(--color-them)" />
        {micOn && <LevelMeter label="Me (mic)" level={levels.mic} active={active} color="var(--color-me)" />}
        <p className="text-[11px] text-muted">
          {work
            ? 'Work Mode: when someone asks for a status update, the overlay writes one from your Projects. Ctrl+Shift+Space picks a project yourself. '
            : 'Interview Mode: questions are answered from your Profile. '}
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

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div className="flex flex-col" title={title}>
      <span className="text-[10px] tracking-wide text-muted uppercase">{label}</span>
      <span className={`font-mono text-sm tabular-nums ${tone ?? ''}`}>{value}</span>
    </div>
  )
}

function costTitle(c: CostUpdate): string {
  const lines = [
    `Speech-to-text: ${Math.round(c.sttSeconds / 60)} min`,
    `LLM tokens: ${c.inputTokens.toLocaleString()} in · ${c.cacheReadTokens.toLocaleString()} cached · ${c.outputTokens.toLocaleString()} out`
  ]
  if (c.unpriced.length) lines.push(`No price in pricing.json (counted as $0): ${c.unpriced.join(', ')}`)
  return lines.join('\n')
}
