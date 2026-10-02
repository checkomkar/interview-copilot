import { useEffect, useState, type ReactNode } from 'react'
import { EMPTY_PROFILE, type Profile, type ProfileInput } from '@shared/profile'
import { LLM_PROVIDER_LABELS, providerOrder } from '@shared/settings'
import { useApp } from '../store'

const inputCls = 'w-full rounded-md border border-line bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent'
const areaCls = `${inputCls} resize-y font-mono text-[12px] leading-relaxed`

function toInput(p: Profile): ProfileInput {
  return {
    name: p.name,
    company: p.company,
    role: p.role,
    notes: p.notes,
    resumeText: p.resumeText,
    resumeFileName: p.resumeFileName,
    jdText: p.jdText
  }
}

export function ProfileTab() {
  const keys = useApp((s) => s.keys)
  const settings = useApp((s) => s.settings)
  const provider = settings?.llm.provider ?? 'anthropic'
  const anyKey = settings && keys ? providerOrder(settings).some((p) => keys[p]) : true
  const setTab = useApp((s) => s.setTab)
  const [saved, setSaved] = useState<Profile>(EMPTY_PROFILE)
  const [draft, setDraft] = useState<ProfileInput>(toInput(EMPTY_PROFILE))
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<'save' | 'import' | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    void window.api.profile.get().then((p) => {
      setSaved(p)
      setDraft(toInput(p))
      setLoaded(true)
    })
  }, [])

  const set = <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(toInput(saved))

  const importResume = async () => {
    setBusy('import')
    setMessage(null)
    try {
      const res = await window.api.profile.importResume()
      if (res.ok) setDraft((d) => ({ ...d, resumeText: res.text, resumeFileName: res.fileName }))
      else if (!res.canceled) setMessage({ kind: 'bad', text: res.error })
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setMessage(null)
    try {
      const res = await window.api.profile.save(draft)
      setSaved(res.profile)
      setDraft(toInput(res.profile))
      setMessage(res.summaryError ? { kind: 'warn', text: `Saved. ${res.summaryError}` } : { kind: 'ok', text: 'Saved.' })
    } catch (err) {
      setMessage({ kind: 'bad', text: (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setBusy(null)
    }
  }

  if (!loaded) return <div className="p-8 text-sm text-muted">Loading…</div>

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
        <div>
          <h1 className="text-xl font-semibold">Profile</h1>
          <p className="mt-1 text-sm text-muted">
            Answers use this to speak as you, from your real experience. On save, the resume and job description are summarized with the fast
            model; the summaries are sent with every answer and cached. Work Mode uses only your name and role from here — its context comes from
            the Projects tab.
          </p>
        </div>

        {!anyKey && (
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2.5 text-sm text-warn">
            Add your {LLM_PROVIDER_LABELS[provider]} API key in{' '}
            <button className="underline" onClick={() => setTab('settings')}>
              Settings
            </button>{' '}
            to generate summaries. You can still save; answers will use the raw text.
          </div>
        )}

        <Card title="You and the role">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Your name">
              <input className={inputCls} value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Omkar" />
            </Field>
            <Field label="Role">
              <input className={inputCls} value={draft.role} onChange={(e) => set('role', e.target.value)} placeholder="Senior Frontend Engineer" />
            </Field>
            <Field label="Company">
              <input className={inputCls} value={draft.company} onChange={(e) => set('company', e.target.value)} placeholder="Acme" />
            </Field>
          </div>
        </Card>

        <Card
          title="Resume"
          action={
            <div className="flex items-center gap-3">
              {draft.resumeFileName && <span className="truncate text-xs text-muted">{draft.resumeFileName}</span>}
              <button
                onClick={() => void importResume()}
                disabled={busy !== null}
                className="rounded-md border border-line px-3 py-1 text-sm text-muted hover:text-fg disabled:opacity-50"
              >
                {busy === 'import' ? 'Reading…' : 'Import PDF / DOCX / TXT'}
              </button>
            </div>
          }
        >
          <textarea
            className={areaCls}
            rows={10}
            value={draft.resumeText}
            onChange={(e) => set('resumeText', e.target.value)}
            placeholder="Import a file or paste your resume text"
          />
          <Summary label="Resume summary" text={saved.resumeSummary} stale={draft.resumeText !== saved.resumeText} />
        </Card>

        <Card title="Job description">
          <textarea className={areaCls} rows={8} value={draft.jdText} onChange={(e) => set('jdText', e.target.value)} placeholder="Paste the job description" />
          <Summary label="JD summary" text={saved.jdSummary} stale={draft.jdText !== saved.jdText} />
        </Card>

        <Card title="Notes" description='Anything answers should know, e.g. "My top 3 projects: …", "Preferred language: TypeScript", "Avoid mentioning X".'>
          <textarea className={areaCls} rows={5} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </Card>

        <div className="sticky bottom-0 -mx-8 flex items-center gap-4 border-t border-line bg-bg/95 px-8 py-3 backdrop-blur">
          <button
            onClick={() => void save()}
            disabled={busy !== null || !dirty}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg disabled:opacity-40"
          >
            {busy === 'save' ? 'Saving & summarizing…' : 'Save profile'}
          </button>
          {message ? (
            <span className={`text-sm ${message.kind === 'ok' ? 'text-ok' : message.kind === 'warn' ? 'text-warn' : 'text-bad'}`}>{message.text}</span>
          ) : (
            dirty && <span className="text-sm text-muted">Unsaved changes</span>
          )}
        </div>
      </div>
    </div>
  )
}

function Card({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  )
}

function Summary({ label, text, stale }: { label: string; text: string; stale: boolean }) {
  if (!text) return null
  return (
    <details className="rounded-lg bg-raised px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted select-none">
        {label}
        {stale && ' · out of date until you save'}
      </summary>
      <pre className="mt-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-fg/90">{text}</pre>
    </details>
  )
}
