import { useEffect, useState, type ReactNode } from 'react'
import type { TeamsSource, TeamsStatus } from '@shared/work'
import { useApp } from '../store'

const inputCls = 'w-full rounded-md border border-line bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent'
const MOCK_URL = 'http://localhost:4100'

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** FR-T3/T5: follow Teams chats with a work account (or the local mock) and sync their messages. */
export function TeamsSyncCard() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const [status, setStatus] = useState<TeamsStatus | null>(null)
  const [sources, setSources] = useState<TeamsSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const t = settings?.work.teams

  useEffect(() => {
    void window.api.teams.status().then(setStatus)
    return window.api.teams.onStatus(setStatus)
  }, [])
  useEffect(() => {
    if (status?.account && sources === null) void loadSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.account])

  const loadSources = async () => {
    try {
      setSources(await window.api.teams.sources())
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  if (!t || !status) return null
  const mock = t.authorityUrl.startsWith('http://localhost')
  const followed = new Set(t.sources.map((s) => `${s.kind}:${s.id}`))
  const toggle = (s: TeamsSource) => {
    const key = `${s.kind}:${s.id}`
    const next = followed.has(key) ? t.sources.filter((x) => `${x.kind}:${x.id}` !== key) : [...t.sources, s]
    void update({ work: { teams: { sources: next } } })
  }

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold">Teams sync</h2>
        {status.account && <span className="rounded bg-ok/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-ok uppercase">Connected</span>}
        {mock && <span className="rounded bg-warn/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-warn uppercase">Local mock</span>}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        With a work or school Microsoft account, Cue reads the chats you choose every few minutes and suggests updates here. Personal and free Teams
        accounts can't be read this way (Microsoft doesn't allow it) — paste or screenshot them below instead.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {!status.account && !status.signIn && (
          <>
            <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3">
              <Field label="App (client) ID">
                <input
                  className={inputCls}
                  key={t.clientId}
                  defaultValue={t.clientId}
                  onBlur={(e) => e.target.value !== t.clientId && void update({ work: { teams: { clientId: e.target.value.trim() } } })}
                  placeholder="00000000-0000-0000-0000-000000000000"
                />
              </Field>
              <Field label="Directory (tenant) ID or domain">
                <input
                  className={inputCls}
                  key={t.tenant}
                  defaultValue={t.tenant}
                  onBlur={(e) => e.target.value !== t.tenant && void update({ work: { teams: { tenant: e.target.value.trim() || 'organizations' } } })}
                  placeholder="contoso.onmicrosoft.com"
                />
              </Field>
            </div>
            <details className="text-xs text-muted" open={!t.clientId}>
              <summary className="cursor-pointer select-none">Setting up an app registration (once, for your organisation)</summary>
              <ol className="mt-2 ml-4 list-decimal space-y-1 leading-relaxed">
                <li>Microsoft Entra admin center → App registrations → New registration. Supported accounts: this organisation only.</li>
                <li>Authentication → Advanced settings → Allow public client flows: Yes (Cue signs in with a code, no secret).</li>
                <li>API permissions → Microsoft Graph → Delegated: User.Read, Chat.Read, offline_access. For channels also ChannelMessage.Read.All, Channel.ReadBasic.All, Team.ReadBasic.All — these need an admin to grant consent.</li>
                <li>Copy the Application (client) ID and Directory (tenant) ID here.</li>
              </ol>
              <p className="mt-2">
                No tenant yet? Run <span className="font-mono">npm run mock-teams</span> and use the local mock — it behaves like Teams with a sample
                team chat, and lets you post messages as different people.
              </p>
            </details>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => void run(() => window.api.teams.signIn())}
                disabled={!t.clientId}
                className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg disabled:opacity-40"
              >
                Sign in to Teams
              </button>
              {!mock ? (
                <button
                  onClick={() =>
                    void update({ work: { teams: { clientId: t.clientId || 'mock-client', tenant: 'mock', authorityUrl: MOCK_URL, graphBaseUrl: MOCK_URL } } })
                  }
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
                >
                  Use the local mock
                </button>
              ) : (
                <button
                  onClick={() =>
                    void update({
                      work: { teams: { clientId: '', tenant: 'organizations', authorityUrl: 'https://login.microsoftonline.com', graphBaseUrl: 'https://graph.microsoft.com' } }
                    })
                  }
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
                >
                  Use real Microsoft 365
                </button>
              )}
              <button onClick={() => setAdvanced(!advanced)} className="text-xs text-muted hover:text-fg">
                {advanced ? 'Hide' : 'Advanced'}
              </button>
            </div>
            {advanced && (
              <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3">
                <Field label="Sign-in service">
                  <input
                    className={inputCls}
                    key={t.authorityUrl}
                  defaultValue={t.authorityUrl}
                    onBlur={(e) => e.target.value !== t.authorityUrl && void update({ work: { teams: { authorityUrl: e.target.value.trim() } } })}
                  />
                </Field>
                <Field label="Microsoft Graph">
                  <input
                    className={inputCls}
                    key={t.graphBaseUrl}
                  defaultValue={t.graphBaseUrl}
                    onBlur={(e) => e.target.value !== t.graphBaseUrl && void update({ work: { teams: { graphBaseUrl: e.target.value.trim() } } })}
                  />
                </Field>
                <label className="col-span-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-accent" checked={t.includeChannels} onChange={(e) => void update({ work: { teams: { includeChannels: e.target.checked } } })} />
                  Also read team channels (needs admin consent; sign in again after changing)
                </label>
              </div>
            )}
          </>
        )}

        {status.signIn && (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-accent/40 bg-accent/5 p-4">
            <p className="text-sm">Open the sign-in page and enter this code:</p>
            <p className="font-mono text-2xl font-semibold tracking-[0.2em] select-all">{status.signIn.userCode}</p>
            <p className="text-xs text-muted">
              {status.signIn.verificationUri} · expires at {time(status.signIn.expiresAt)}
            </p>
            <div className="flex gap-2">
              <button onClick={() => void run(() => window.api.teams.openSignIn())} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-bg">
                Open sign-in page
              </button>
              <button onClick={() => void navigator.clipboard.writeText(status.signIn!.userCode)} className="rounded-md border border-line px-3 py-1.5 text-sm">
                Copy code
              </button>
              <button onClick={() => void run(() => window.api.teams.cancelSignIn())} className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg">
                Cancel
              </button>
            </div>
          </div>
        )}

        {status.account && (
          <>
            <p className="text-sm">
              Signed in as <span className="font-medium">{status.account}</span>
            </p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Chats to follow</span>
              <button onClick={() => void loadSources()} className="text-xs text-muted hover:text-fg">
                Refresh list
              </button>
            </div>
            {sources === null ? (
              <p className="text-sm text-muted">Loading chats…</p>
            ) : sources.length === 0 ? (
              <p className="text-sm text-muted">No chats found.</p>
            ) : (
              <ul className="flex max-h-56 flex-col overflow-y-auto rounded-lg border border-line">
                {sources.map((s) => (
                  <li key={`${s.kind}:${s.id}`} className="border-b border-line last:border-0">
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-raised/60">
                      <input type="checkbox" className="size-4 accent-accent" checked={followed.has(`${s.kind}:${s.id}`)} onChange={() => toggle(s)} />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <span className="text-[10px] tracking-wide text-muted uppercase">{s.kind}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => void run(() => window.api.teams.syncNow())}
                disabled={status.syncing || t.sources.length === 0}
                className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-40"
              >
                {status.syncing ? 'Checking…' : 'Sync now'}
              </button>
              <label className="flex items-center gap-2 text-sm text-muted">
                Check every
                <select className="rounded-md border border-line bg-raised px-2 py-1 text-sm" value={t.pollMinutes} onChange={(e) => void update({ work: { teams: { pollMinutes: Number(e.target.value) } } })}>
                  {[1, 5, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" className="size-4 accent-accent" checked={t.enabled} onChange={(e) => void update({ work: { teams: { enabled: e.target.checked } } })} />
                Automatic
              </label>
              <button onClick={() => void run(() => window.api.teams.signOut())} className="ml-auto text-xs text-muted hover:text-bad">
                Sign out
              </button>
            </div>
            <p className="text-xs text-muted">
              {t.sources.length === 0
                ? 'Choose at least one chat.'
                : status.lastSync
                  ? `Last checked ${time(status.lastSync)} — ${status.lastFound} new suggestion${status.lastFound === 1 ? '' : 's'}.`
                  : 'Not checked yet.'}
            </p>
          </>
        )}
        {(error ?? status.error) && <p className="text-sm text-bad">{error ?? status.error}</p>}
      </div>
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
