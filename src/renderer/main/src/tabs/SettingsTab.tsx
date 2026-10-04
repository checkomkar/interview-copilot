import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DisplayInfo, LatencyStage } from '@shared/ipc'
import {
  STT_PROVIDERS,
  STT_PROVIDER_LABELS,
  LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  MAX_MODEL_CHAIN,
  OPENROUTER_PRESETS,
  REASONING_EFFORTS,
  modelsFor,
  splitModels,
  type ApiKeyProvider,
  type HotkeyAction,
  type LlmProviderId,
  type ReasoningEffort,
  type Settings,
  type SttProviderId
} from '@shared/settings'
import { useApp } from '../store'
import { isMac, keys } from '../../../shared/keys'

/** Hotkeys from later phases are saved but not bound yet. */
const CURRENT_PHASE = 4

const HOTKEY_LABELS: Record<HotkeyAction, { label: string; phase: number }> = {
  startStop: { label: 'Start / stop session', phase: 1 },
  toggleOverlay: { label: 'Show / hide overlay', phase: 1 },
  toggleMain: { label: 'Show / hide dashboard', phase: 1 },
  quitApp: { label: 'Quit Cue', phase: 1 },
  answerNow: { label: 'Answer last utterance now', phase: 2 },
  regenerate: { label: 'Regenerate', phase: 2 },
  shorter: { label: 'Shorter', phase: 2 },
  toggleAutoAnswer: { label: 'Toggle auto-answer', phase: 2 },
  prevAnswer: { label: 'Previous answer', phase: 2 },
  nextAnswer: { label: 'Next answer', phase: 2 },
  toggleVoiceAsk: { label: 'Voice questions on / off', phase: 2 },
  focusAsk: { label: 'Type a question (focus overlay)', phase: 2 },
  screenshot: { label: 'Screenshot + answer', phase: 3 },
  addScreenshot: { label: 'Add screenshot (answer later)', phase: 3 }
}

export function SettingsTab() {
  const settings = useApp((s) => s.settings)
  if (!settings) return <div className="p-8 text-sm text-muted">Loading…</div>
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
        <h1 className="text-xl font-semibold">Settings</h1>
        <ApiKeysSection />
        <AudioSection settings={settings} />
        <SttSection settings={settings} />
        <LlmSection settings={settings} />
        <DetectionSection settings={settings} />
        <ScreenSection settings={settings} />
        <CostSection settings={settings} />
        <OverlaySection settings={settings} />
        <HotkeysSection settings={settings} />
        <DebugSection />
        <DataSection />
      </div>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[200px_1fr] items-center gap-4">
      <span className="text-sm">
        {label}
        {hint && <span className="block text-[11px] text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded-md border border-line bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50'

/** Text input that commits on blur / Enter, so typing doesn't spam settings writes. */
function TextSetting({ value, onCommit, type = 'text' }: { value: string | number; onCommit: (v: string) => void; type?: string }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    if (draft !== String(value)) onCommit(draft)
  }
  return (
    <input
      className={inputCls}
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumberSetting({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return <TextSetting type="number" value={value} onCommit={(v) => onCommit(Number(v))} />
}

function ApiKeysSection() {
  const keys = useApp((s) => s.keys)
  return (
    <Section
      title="API keys"
      description={`Encrypted with ${isMac ? 'the macOS Keychain' : 'Windows DPAPI'} (Electron safeStorage). Keys never leave the main process except to call the provider.`}
    >
      <ApiKeyRow provider="deepgram" label="Deepgram" hint="Speech-to-text · console.deepgram.com" isSet={keys?.deepgram ?? false} />
      <ApiKeyRow provider="assemblyai" label="AssemblyAI" hint="Speech-to-text · assemblyai.com/dashboard" isSet={keys?.assemblyai ?? false} />
      <ApiKeyRow provider="anthropic" label="Anthropic" hint="Paid · console.anthropic.com" isSet={keys?.anthropic ?? false} />
      <ApiKeyRow provider="openrouter" label="OpenRouter" hint="Answers and speech-to-text · openrouter.ai/keys" isSet={keys?.openrouter ?? false} />
      <ApiKeyRow provider="groq" label="Groq" hint="Free tier · answers and speech-to-text · console.groq.com/keys" isSet={keys?.groq ?? false} />
      <ApiKeyRow provider="gemini" label="Google Gemini" hint="Free tier · aistudio.google.com/apikey" isSet={keys?.gemini ?? false} />
    </Section>
  )
}

function ApiKeyRow({ provider, label, hint, isSet }: { provider: ApiKeyProvider; label: string; hint: string; isSet: boolean }) {
  const setApiKey = useApp((s) => s.setApiKey)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (key: string) => {
    setBusy(true)
    setError(null)
    try {
      await setApiKey(provider, key)
      setValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <span className="text-sm">
        {label}
        <span className="block text-[11px] text-muted">{hint}</span>
      </span>
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <input
            className={inputCls}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={isSet ? '•••••••••• (saved — paste to replace)' : 'Paste API key'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save(value)}
          />
          <button
            disabled={busy || !value.trim()}
            onClick={() => void save(value)}
            className="rounded-md bg-accent px-3 text-sm font-medium text-bg disabled:opacity-40"
          >
            Save
          </button>
          {isSet && (
            <button disabled={busy} onClick={() => void save('')} className="rounded-md border border-line px-3 text-sm text-muted hover:text-fg">
              Clear
            </button>
          )}
        </div>
        <span className={`text-[11px] ${error ? 'text-bad' : isSet ? 'text-ok' : 'text-muted'}`}>
          {error ?? (isSet ? '✓ Saved' : 'Not set')}
        </span>
      </div>
    </div>
  )
}

function AudioSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])

  const refresh = async (unlockLabels = false) => {
    if (unlockLabels) {
      // Device labels are hidden until mic access has been granted once.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    }
    const all = await navigator.mediaDevices.enumerateDevices()
    setMics(all.filter((d) => d.kind === 'audioinput'))
  }
  useEffect(() => {
    void refresh()
  }, [])
  const labelsHidden = mics.length > 0 && mics.every((d) => !d.label)

  return (
    <Section
      title="Audio"
      description={
        isMac
          ? 'System audio from all apps is captured via macOS screen & system audio recording (macOS 13+). Cue asks for that permission on the first session.'
          : 'System audio is captured from the default Windows output device via WASAPI loopback. To capture a different device, make it the default in Windows sound settings.'
      }
    >
      <Row label="Capture microphone" hint='Shown as "Me" in the transcript'>
        <input
          type="checkbox"
          className="size-4 justify-self-start accent-accent"
          checked={settings.audio.micEnabled}
          onChange={(e) => void update({ audio: { micEnabled: e.target.checked } })}
        />
      </Row>
      <Row label="Microphone device">
        <div className="flex gap-2">
          <select
            className={inputCls}
            disabled={!settings.audio.micEnabled}
            value={settings.audio.micDeviceId ?? ''}
            onChange={(e) => void update({ audio: { micDeviceId: e.target.value || null } })}
          >
            <option value="">System default</option>
            {mics
              .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
          {labelsHidden && (
            <button onClick={() => void refresh(true)} className="shrink-0 rounded-md border border-line px-3 text-sm text-muted hover:text-fg">
              Show names
            </button>
          )}
        </div>
      </Row>
    </Section>
  )
}

const STT_HINTS: Record<SttProviderId, string> = {
  deepgram: 'Streaming · Nova-3: ~$0.46/hour',
  assemblyai: 'Streaming · Universal-Streaming: ~$0.15/hour',
  openrouter: 'Per phrase, after a pause (slower) · Whisper Turbo: ~$0.01/hour of speech',
  groq: 'Per phrase, after a pause (slower) · free tier: 8 hours/day'
}

const STT_MODEL_FIELDS: Record<SttProviderId, { key: 'model' | 'assemblyaiModel' | 'openrouterModel' | 'groqModel'; hint?: string }> = {
  deepgram: { key: 'model' },
  assemblyai: { key: 'assemblyaiModel', hint: 'universal-streaming-english, universal-streaming-multilingual or universal-3-6-pro' },
  openrouter: { key: 'openrouterModel', hint: 'Tried in order, e.g. openai/whisper-large-v3-turbo, openai/gpt-4o-mini-transcribe' },
  groq: { key: 'groqModel', hint: 'Tried in order: whisper-large-v3-turbo, whisper-large-v3' }
}

function SttSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const keys = useApp((s) => s.keys)
  const stt = settings.stt
  const fallbacks = stt.fallbackProviders.filter((p) => p !== stt.provider)
  const toggleFallback = (id: SttProviderId, on: boolean) => {
    const next = on ? [...fallbacks, id] : fallbacks.filter((p) => p !== id)
    // Keep the listed order so failover is predictable.
    void update({ stt: { fallbackProviders: STT_PROVIDERS.filter((p) => next.includes(p)) } })
  }
  // Model fields for the main provider and the backups in use.
  const shown = [stt.provider, ...fallbacks]
  return (
    <Section
      title="Speech-to-text"
      description="Transcription for the interviewer, your mic and practice answers. If the main provider can't connect or fails, the backups take over in order. Changes apply to the next session."
    >
      <Row label="Main provider" hint={STT_HINTS[stt.provider]}>
        <div className="flex items-center gap-3">
          <select className={inputCls} value={stt.provider} onChange={(e) => void update({ stt: { provider: e.target.value as SttProviderId } })}>
            {STT_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {STT_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
          {keys && !keys[stt.provider] && <span className="shrink-0 text-[11px] text-warn">No API key</span>}
        </div>
      </Row>
      {/* Not a <Row>: a <label> would forward clicks on its text to the first checkbox. */}
      <div className="grid grid-cols-[200px_1fr] items-start gap-4">
        <span className="text-sm">
          Backup providers
          <span className="block text-[11px] text-muted">Tried in this order; only those with a key</span>
        </span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {STT_PROVIDERS.filter((p) => p !== stt.provider).map((p) => (
            <label key={p} className="flex cursor-pointer items-center gap-2 text-sm select-none">
              <input type="checkbox" className="size-4 accent-accent" checked={fallbacks.includes(p)} onChange={(e) => toggleFallback(p, e.target.checked)} />
              {STT_PROVIDER_LABELS[p]}
              {keys && !keys[p] && <span className="text-[11px] text-muted">(no key)</span>}
            </label>
          ))}
        </div>
      </div>
      {shown.map((p) => {
        const field = STT_MODEL_FIELDS[p]
        return (
          <Row key={p} label={`${STT_PROVIDER_LABELS[p]} model`} hint={field.hint}>
            <TextSetting value={stt[field.key]} onCommit={(v) => void update({ stt: { [field.key]: v } })} />
          </Row>
        )
      })}
      <Row label="Language">
        <TextSetting value={stt.language} onCommit={(language) => void update({ stt: { language } })} />
      </Row>
      <Row label="Endpointing (ms)" hint="Pause that finalizes a phrase">
        <NumberSetting value={stt.endpointingMs} onCommit={(endpointingMs) => void update({ stt: { endpointingMs } })} />
      </Row>
      <Row label="Utterance end (ms)" hint="Silence that ends an utterance (≥ 1000); OpenRouter and Groq send a phrase after this pause">
        <NumberSetting value={stt.utteranceEndMs} onCommit={(utteranceEndMs) => void update({ stt: { utteranceEndMs } })} />
      </Row>
    </Section>
  )
}

function LlmSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const keys = useApp((s) => s.keys)
  const llm = settings.llm
  const fallbacks = llm.fallbackProviders.filter((p) => p !== llm.provider)
  const toggleFallback = (id: LlmProviderId, on: boolean) => {
    const next = on ? [...fallbacks, id] : fallbacks.filter((p) => p !== id)
    // Keep the listed order so failover is predictable.
    void update({ llm: { fallbackProviders: LLM_PROVIDERS.filter((p) => next.includes(p)) } })
  }
  return (
    <Section
      title="Answers"
      description="Model fields take up to 12 IDs (comma or one per line), tried in order: a model that is rate-limited or out of quota is skipped for a while and the next one is used. When the main provider fails or runs out, the backups are tried in order."
    >
      <Row label="Main provider" hint="Applies to the next request">
        <div className="flex items-center gap-3">
          <select className={inputCls} value={llm.provider} onChange={(e) => void update({ llm: { provider: e.target.value as LlmProviderId } })}>
            {LLM_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {LLM_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
          {keys && !keys[llm.provider] && <span className="shrink-0 text-[11px] text-warn">No API key</span>}
        </div>
      </Row>
      {/* Not a <Row>: a <label> would forward clicks on its text to the first checkbox. */}
      <div className="grid grid-cols-[200px_1fr] items-start gap-4">
        <span className="text-sm">
          Backup providers
          <span className="block text-[11px] text-muted">Tried in this order; only those with a key</span>
        </span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {LLM_PROVIDERS.filter((p) => p !== llm.provider).map((p) => (
            <label key={p} className="flex cursor-pointer items-center gap-2 text-sm select-none">
              <input type="checkbox" className="size-4 accent-accent" checked={fallbacks.includes(p)} onChange={(e) => toggleFallback(p, e.target.checked)} />
              {LLM_PROVIDER_LABELS[p]}
              {keys && !keys[p] && <span className="text-[11px] text-muted">(no key)</span>}
            </label>
          ))}
        </div>
      </div>

      <Row label="Screenshots go to" hint="First provider for screenshot answers; the rest follow as backups">
        <select
          className={inputCls}
          value={llm.visionProvider}
          onChange={(e) => void update({ llm: { visionProvider: e.target.value as LlmProviderId | 'auto' } })}
        >
          <option value="auto">Same order as answers (main, then backups)</option>
          {LLM_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {LLM_PROVIDER_LABELS[p]} first{keys && !keys[p] ? ' (no key)' : ''}
            </option>
          ))}
        </select>
      </Row>

      {[llm.provider, ...fallbacks].map((p, i) => (
        <ProviderModels key={p} provider={p} settings={settings} badge={i === 0 ? 'main' : `backup ${i}`} />
      ))}

      <Row label="Max tokens">
        <NumberSetting value={llm.maxTokens} onCommit={(maxTokens) => void update({ llm: { maxTokens } })} />
      </Row>
      <Row label="Max tokens (coding)" hint="Also system design and screenshots">
        <NumberSetting value={llm.maxTokensCoding} onCommit={(maxTokensCoding) => void update({ llm: { maxTokensCoding } })} />
      </Row>
      <Row label="Coding answers" hint="Shorter always gives just the optimal solution">
        <select
          className={inputCls}
          value={llm.codingAnswer}
          onChange={(e) => void update({ llm: { codingAnswer: e.target.value as 'stepwise' | 'direct' } })}
        >
          <option value="stepwise">Step by step: pseudocode → brute force → optimal</option>
          <option value="direct">Optimal only: approach, complexity, code</option>
        </select>
      </Row>
      <Row label="Diagrams" hint="System design, and questions asking to draw something, get a diagram in the overlay">
        <input
          type="checkbox"
          className="size-4 justify-self-start accent-accent"
          checked={llm.diagrams}
          onChange={(e) => void update({ llm: { diagrams: e.target.checked } })}
        />
      </Row>
      <Row label="Preferred language" hint="For coding answers">
        <TextSetting value={settings.preferredLanguage} onCommit={(preferredLanguage) => void update({ preferredLanguage })} />
      </Row>
    </Section>
  )
}

const MODEL_HINTS: Record<LlmProviderId, string> = {
  anthropic: 'e.g. claude-sonnet-5-5',
  openrouter: 'OpenRouter slugs; free ones end in :free',
  groq: 'e.g. openai/gpt-oss-120b',
  gemini: 'e.g. gemini-3.8-flash'
}

/** Model chains (and reasoning effort) for one provider. */
function ProviderModels({ provider, settings, badge }: { provider: LlmProviderId; settings: Settings; badge: string }) {
  const update = useApp((s) => s.updateSettings)
  const models = modelsFor(settings, provider)
  const setModels = (patch: { answerModel?: string; fastModel?: string; visionModel?: string }) =>
    void update({ llm: provider === 'anthropic' ? patch : { [provider]: patch } })
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        {LLM_PROVIDER_LABELS[provider]}
        <span className="rounded bg-raised px-1.5 py-px text-[10px] tracking-wide text-muted uppercase">{badge}</span>
      </div>
      <Row label="Answer models" hint={MODEL_HINTS[provider]}>
        <ModelListSetting value={models.answerModel} onCommit={(answerModel) => setModels({ answerModel })} />
      </Row>
      <Row label="Fast models" hint="Classifier, summaries">
        <ModelListSetting value={models.fastModel} onCommit={(fastModel) => setModels({ fastModel })} />
      </Row>
      <Row label="Screenshot models" hint="Must accept images; empty = skip this provider for screenshots">
        <ModelListSetting value={models.visionModel} allowEmpty onCommit={(visionModel) => setModels({ visionModel })} />
      </Row>
      {provider === 'openrouter' && (
        <div className="grid grid-cols-[200px_1fr] items-center gap-4">
          <span className="text-sm">
            Presets
            <span className="block text-[11px] text-muted">Free: 20 req/min, 50/day without credits · Paid: pay per token from credits</span>
          </span>
          <div className="flex gap-2">
            {Object.values(OPENROUTER_PRESETS).map((preset) => {
              const active = models.answerModel === preset.answerModel && models.fastModel === preset.fastModel
              return (
                <button
                  key={preset.label}
                  onClick={() => setModels({ answerModel: preset.answerModel, fastModel: preset.fastModel, visionModel: preset.visionModel })}
                  className={`rounded-md border px-3 py-1.5 text-sm ${active ? 'border-accent text-fg' : 'border-line text-muted hover:text-fg'}`}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {provider !== 'anthropic' && (
        <Row label="Reasoning effort" hint={provider === 'openrouter' ? 'Answers only; lower is faster' : 'Lower is faster'}>
          <select
            className={inputCls}
            value={settings.llm[provider].reasoningEffort}
            onChange={(e) => void update({ llm: { [provider]: { reasoningEffort: e.target.value as ReasoningEffort } } })}
          >
            {REASONING_EFFORTS.map((r) => (
              <option key={r} value={r}>
                {r === 'default' ? 'Model default' : r}
              </option>
            ))}
          </select>
        </Row>
      )}
    </div>
  )
}

/** Model chain editor: one ID per line, saved comma-separated on blur. */
function ModelListSetting({ value, onCommit, allowEmpty }: { value: string; onCommit: (v: string) => void; allowEmpty?: boolean }) {
  const toLines = (v: string) => splitModels(v).join('\n')
  const [draft, setDraft] = useState(toLines(value))
  useEffect(() => setDraft(toLines(value)), [value])
  const count = splitModels(draft).length
  return (
    <div className="flex flex-col gap-1">
      <textarea
        className={`${inputCls} resize-y font-mono text-[12px] leading-relaxed`}
        rows={Math.min(6, Math.max(2, count))}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const joined = splitModels(draft).join(', ')
          if ((joined || allowEmpty) && joined !== splitModels(value).join(', ')) onCommit(joined)
          else setDraft(toLines(value))
        }}
      />
      <span className="text-[11px] text-muted">
        {count === 0 ? 'None' : `${count} model${count === 1 ? '' : 's'} · tried top to bottom (max ${MAX_MODEL_CHAIN})`}
      </span>
    </div>
  )
}

function DetectionSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const d = settings.detection
  return (
    <Section
      title="Question detection"
      description="Interviewer utterances are checked with quick rules first; unclear ones longer than the minimum go to the fast model."
    >
      <Row label="Auto-answer" hint="Off: only the hotkey answers">
        <input
          type="checkbox"
          className="size-4 justify-self-start accent-accent"
          checked={d.autoAnswer}
          onChange={(e) => void update({ detection: { autoAnswer: e.target.checked } })}
        />
      </Row>
      <Row label="Minimum words" hint="Shorter non-questions are ignored">
        <NumberSetting value={d.minWords} onCommit={(minWords) => void update({ detection: { minWords } })} />
      </Row>
      <Row label="Mid-sentence pause (ms)" hint="Extra wait when a sentence sounds unfinished; 0 = off">
        <NumberSetting value={d.pauseGraceMs} onCommit={(pauseGraceMs) => void update({ detection: { pauseGraceMs } })} />
      </Row>
      <Row label="Debounce (ms)" hint="At most one answer per window">
        <NumberSetting value={d.debounceMs} onCommit={(debounceMs) => void update({ detection: { debounceMs } })} />
      </Row>
    </Section>
  )
}

function ScreenSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  useEffect(() => {
    void window.api.screen.displays().then(setDisplays)
  }, [])
  const sc = settings.screen
  return (
    <Section
      title="Screen"
      description={keys('Ctrl+Shift+S captures the screen and answers with a screenshot model — right away, or with the question the interviewer is asking. For long questions, add up to 3 screenshots while scrolling (Ctrl+Shift+Alt+S or the overlay camera button), then Answer: they are sent together for one answer. The overlay hides itself for each capture.')}
    >
      <Row label="Display">
        <select className={inputCls} value={sc.displayId ?? ''} onChange={(e) => void update({ screen: { displayId: e.target.value || null } })}>
          <option value="">Primary display</option>
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {d.primary ? ' — primary' : ''}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Always include screenshot" hint="Every answer gets a fresh screenshot (coding rounds)">
        <input
          type="checkbox"
          className="size-4 justify-self-start accent-accent"
          checked={sc.alwaysInclude}
          onChange={(e) => void update({ screen: { alwaysInclude: e.target.checked } })}
        />
      </Row>
      <Row label="Screenshots per question" hint="For long, scrolled problems (1–10). Groq takes at most 3; more go to OpenRouter / Gemini">
        <NumberSetting value={sc.maxScreenshots} onCommit={(maxScreenshots) => void update({ screen: { maxScreenshots } })} />
      </Row>
      <Row label="Max size (px)" hint="Long edge; smaller is faster and cheaper">
        <NumberSetting value={sc.maxEdgePx} onCommit={(maxEdgePx) => void update({ screen: { maxEdgePx } })} />
      </Row>
      <Row label="Keep screenshots" hint="Save them with the session in History">
        <input
          type="checkbox"
          className="size-4 justify-self-start accent-accent"
          checked={settings.keepScreenshots}
          onChange={(e) => void update({ keepScreenshots: e.target.checked })}
        />
      </Row>
    </Section>
  )
}

function CostSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    const res = await window.api.cost.openPricing()
    setError(res.ok ? null : (res.error ?? 'Could not open the file.'))
  }
  return (
    <Section
      title="Cost"
      description="Speech-to-text minutes and LLM tokens are priced from pricing.json (OpenRouter reports its own costs). Groq and Gemini free tiers count as $0."
    >
      <Row label="Session cost cap (USD)" hint="Warning at 80%; at 100% answers use the fast models. 0 = no cap">
        <NumberSetting value={settings.cost.sessionCapUsd} onCommit={(sessionCapUsd) => void update({ cost: { sessionCapUsd } })} />
      </Row>
      {/* Not a <Row>: a <label> would forward clicks on its text to the button. */}
      <div className="grid grid-cols-[200px_1fr] items-center gap-4">
        <span className="text-sm">
          Prices
          <span className="block text-[11px] text-muted">Applies from the next session</span>
        </span>
        <div className="flex items-center gap-3">
          <button onClick={() => void open()} className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg">
            Open pricing file
          </button>
          {error && <span className="text-[11px] text-bad">{error}</span>}
        </div>
      </div>
    </Section>
  )
}

function OverlaySection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const o = settings.overlay
  return (
    <Section title="Overlay">
      <Row label={`Opacity (${Math.round(o.opacity * 100)}%)`}>
        <input
          type="range"
          min={40}
          max={100}
          value={Math.round(o.opacity * 100)}
          onChange={(e) => void update({ overlay: { opacity: Number(e.target.value) / 100 } })}
          className="accent-accent"
        />
      </Row>
      <Row label={`Font size (${o.fontSize}px)`}>
        <input
          type="range"
          min={12}
          max={22}
          value={o.fontSize}
          onChange={(e) => void update({ overlay: { fontSize: Number(e.target.value) } })}
          className="accent-accent"
        />
      </Row>
      <Row label="Theme">
        <select className={inputCls} value={o.theme} onChange={(e) => void update({ overlay: { theme: e.target.value as 'dark' | 'light' } })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Row>
      <Row label="Layout" hint="Also switchable from the overlay header">
        <select className={inputCls} value={o.view} onChange={(e) => void update({ overlay: { view: e.target.value as 'single' | 'list' } })}>
          <option value="single">One answer at a time (‹ ›)</option>
          <option value="list">All questions and answers (scroll)</option>
        </select>
      </Row>
      <Row label="Position">
        <button
          onClick={() => void update({ overlay: { bounds: null } })}
          className="justify-self-start rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
        >
          Reset on next launch
        </button>
      </Row>
    </Section>
  )
}

function HotkeysSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const [failed, setFailed] = useState<HotkeyAction[]>([])
  useEffect(() => {
    void window.api.settings.hotkeyFailures().then(setFailed)
    return window.api.settings.onHotkeyFailures(setFailed)
  }, [])
  return (
    <Section
      title="Global hotkeys"
      description='Electron accelerator syntax, e.g. "CommandOrControl+Shift+Enter". Actions from later phases are saved now and become active when implemented.'
    >
      {(Object.keys(HOTKEY_LABELS) as HotkeyAction[]).map((action) => (
        <Row key={action} label={HOTKEY_LABELS[action].label} hint={HOTKEY_LABELS[action].phase > CURRENT_PHASE ? `Phase ${HOTKEY_LABELS[action].phase}` : undefined}>
          <div className="flex flex-col gap-1">
            <TextSetting value={settings.hotkeys[action]} onCommit={(v) => void update({ hotkeys: { [action]: v } })} />
            {failed.includes(action) && (
              <span className="text-[11px] text-bad">Another app is using this shortcut, so it doesn't work — pick a different one.</span>
            )}
          </div>
        </Row>
      ))}
    </Section>
  )
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

const STAGES: { stage: LatencyStage; label: string; hint: string }[] = [
  { stage: 'stt', label: 'STT lag', hint: 'audio streamed but not yet transcribed when a result arrives' },
  { stage: 'detect', label: 'Detection', hint: 'utterance end → question detected' },
  { stage: 'firstToken', label: 'First token', hint: 'utterance end (or hotkey) → first answer token; target < 3 s' }
]

function DebugSection() {
  const latency = useApp((s) => s.latency)
  return (
    <Section title="Debug · latency" description="Last 100 samples per stage, current session.">
      {STAGES.map(({ stage, label, hint }) => (
        <LatencyRow key={stage} label={label} hint={hint} samples={latency[stage]} />
      ))}
    </Section>
  )
}

function LatencyRow({ label, hint, samples }: { label: string; hint: string; samples: number[] }) {
  const stats = useMemo(() => {
    const sorted = [...samples].sort((a, b) => a - b)
    return { last: samples.at(-1) ?? 0, p50: percentile(sorted, 50), p95: percentile(sorted, 95), n: samples.length }
  }, [samples])
  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <span className="text-sm">
        {label}
        <span className="block text-[11px] text-muted">{hint}</span>
      </span>
      {stats.n === 0 ? (
        <p className="text-sm text-muted">No samples yet.</p>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {(
            [
              ['Last', stats.last],
              ['p50', stats.p50],
              ['p95', stats.p95],
              ['Samples', stats.n]
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-lg bg-raised px-3 py-2">
              <div className="text-[10px] tracking-wide text-muted uppercase">{k}</div>
              <div className="font-mono text-sm tabular-nums">{k === 'Samples' ? v : `${v} ms`}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** FR-D5: remove everything the app stored on this PC. */
function DataSection() {
  const [dir, setDir] = useState('')
  useEffect(() => {
    void window.api.app.info().then((i) => setDir(i.dataDir))
  }, [])
  return (
    <Section title="Data" description={`Everything is stored on this PC${dir ? ` in ${dir}` : ''}.`}>
      <Row label="Delete all data" hint="History, practice runs, screenshots, profile, settings, API keys and logs; the app restarts">
        <button
          onClick={() => void window.api.app.deleteAllData()}
          className="justify-self-start rounded-md border border-bad/40 px-3 py-1.5 text-sm text-bad hover:bg-bad/10"
        >
          Delete all data…
        </button>
      </Row>
    </Section>
  )
}
