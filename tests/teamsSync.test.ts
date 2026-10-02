import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@shared/settings'
import { startMockTeams, type MockTeams } from '../scripts/mock-teams.mjs'
import { TeamsError, TeamsGraph, htmlToText } from '../src/main/services/teams/TeamsGraph'
import { TeamsSync } from '../src/main/services/teams/TeamsSync'
import { ProjectStore } from '../src/main/services/work/ProjectStore'
import { TeamsImporter, type ImportSource } from '../src/main/services/work/teamsImport'
import { MockLlm } from './mockLlm'

const GROUP = '19:mobile-app-dev@thread.v2'

let mock: MockTeams
let cleanup: (() => void | Promise<void>)[] = []
beforeEach(async () => {
  mock = await startMockTeams({ port: 0, autoApprove: true })
})
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
  await mock.close()
})

function graph(opts: { includeChannels?: boolean; now?: () => number } = {}) {
  const secrets = new Map<string, string>()
  const config = { clientId: 'mock-client', tenant: 'mock', authorityUrl: mock.url, graphBaseUrl: mock.url, includeChannels: opts.includeChannels ?? false }
  const g = new TeamsGraph({
    getConfig: () => config,
    getRefreshToken: () => secrets.get('rt') ?? null,
    setRefreshToken: (t) => (t ? secrets.set('rt', t) : secrets.delete('rt')),
    sleep: async () => {},
    now: opts.now
  })
  return { g, secrets, config }
}

async function signedIn(opts?: Parameters<typeof graph>[0]) {
  const x = graph(opts)
  await x.g.finishSignIn(await x.g.startSignIn())
  return x
}

describe('TeamsGraph against the local mock (FR-T3, FR-T5)', () => {
  it('signs in with a device code and keeps only the refresh token', async () => {
    const { g, secrets } = graph()
    const code = await g.startSignIn()
    expect(code.userCode).toMatch(/^CUE\d{4}$/)
    expect(code.verificationUri).toBe(`${mock.url}/device`)
    expect(g.isSignedIn()).toBe(false)
    await g.finishSignIn(code)
    expect(g.isSignedIn()).toBe(true)
    expect(secrets.get('rt')).toMatch(/^mock-rt-/)
    expect(await g.me()).toEqual({ displayName: 'Omkar Kamale', userPrincipalName: 'omkar@contoso.dev' })
  })

  it('waits while the user hasn’t entered the code, and reports a decline', async () => {
    await mock.close()
    mock = await startMockTeams({ port: 0 })
    const { g } = graph()
    const code = await g.startSignIn()
    const pending = g.finishSignIn(code)
    await new Promise((r) => setTimeout(r, 30))
    mock.approveAll()
    await expect(pending).resolves.toBeUndefined()

    const declined = await g.startSignIn()
    await fetch(`${mock.url}/device`, { method: 'POST', body: new URLSearchParams({ code: declined.userCode, decline: '1' }) })
    await expect(g.finishSignIn(declined)).rejects.toThrow('Sign-in was declined.')
  })

  it('needs an app (client) ID', async () => {
    const { g, config } = graph()
    config.clientId = ''
    await expect(g.startSignIn()).rejects.toThrow('Set the app (client) ID first')
  })

  it('lists chats by topic or by the other person, and channels when allowed', async () => {
    const { g } = await signedIn()
    expect((await g.listSources()).map((s) => s.name)).toEqual(['Mobile app – dev', 'Ravi Kumar', 'Sneha Patil'])
    const withChannels = await signedIn({ includeChannels: true })
    expect((await withChannels.g.listSources()).at(-1)).toMatchObject({ kind: 'channel', teamId: 'team-engineering', name: 'Engineering › Mobile release' })
  })

  it('reads new messages as text, oldest first, skipping system messages', async () => {
    const { g } = await signedIn()
    const source = { kind: 'chat' as const, id: GROUP, teamId: null, name: 'Mobile app – dev' }
    const all = await g.messagesSince(source, Date.now() - 24 * 3600_000)
    expect(all).toHaveLength(7)
    expect(all[0]).toMatchObject({ author: 'Priya Shah', chat: 'Mobile app – dev', text: 'Morning all. Reminder: release readiness review on Monday.' })
    expect(all.find((m) => m.author === 'Arjun Mehta')?.text).toBe("New one: app freezes on the payment screen when switching tabs. Logged as BUG-171, I'll take it.")
    const recent = await g.messagesSince(source, Date.now() - 60 * 60_000)
    expect(recent.map((m) => m.author)).toEqual(['Sneha Patil'])
  })

  it('follows paging for a busy chat', async () => {
    const { g } = await signedIn()
    const since = Date.now() - 1000
    for (let i = 0; i < 120; i++) mock.post({ chatId: GROUP, author: 'Ravi Kumar', text: `update ${i}` })
    const msgs = await g.messagesSince({ kind: 'chat', id: GROUP, teamId: null, name: 'g' }, since)
    expect(msgs).toHaveLength(120)
    expect(msgs[0].text).toBe('update 0')
  })

  it('includes replies in channel threads', async () => {
    const { g } = await signedIn({ includeChannels: true })
    const msgs = await g.messagesSince({ kind: 'channel', id: '19:mobile-release@thread.tacv2', teamId: 'team-engineering', name: 'Mobile release' }, Date.now() - 24 * 3600_000)
    expect(msgs.map((m) => m.text)).toEqual(['TOM approvals status thread', 'Architecture and ops have signed the TOM. Security still pending.'])
  })

  it('refreshes an expired access token, and signs out when the refresh token is rejected', async () => {
    let now = Date.now()
    const { g, secrets } = await signedIn({ now: () => now })
    const first = secrets.get('rt')
    now += 2 * 3600_000
    await g.me()
    expect(secrets.get('rt')).not.toBe(first)
    secrets.set('rt', 'mock-rt-revoked')
    now += 2 * 3600_000
    await expect(g.me()).rejects.toThrow('Teams sign-in expired — sign in again.')
    expect(g.isSignedIn()).toBe(false)
  })

  it('explains permission and throttling errors', async () => {
    const { g } = await signedIn()
    mock.failNext(403)
    await expect(g.me()).rejects.toMatchObject({ kind: 'forbidden' })
    mock.failNext(429)
    const err = await g.me().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TeamsError)
    expect(err).toMatchObject({ kind: 'rate', retryAfterMs: 1000 })
  })

  it('turns Teams HTML into plain text', () => {
    expect(htmlToText('<p>Hi <at id="0">Ravi</at>,<br>fixed &amp; merged&nbsp;🎉</p><p>next</p>', 'html')).toBe('Hi @Ravi,\nfixed & merged 🎉\nnext')
    expect(htmlToText(' plain ', 'text')).toBe('plain')
  })
})

describe('TeamsSync (FR-T3)', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'cue-sync-'))
    const store = new ProjectStore({ dir })
    cleanup.push(() => {
      store.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    const app = store.save({ name: 'Mobile app' })
    store.saveTask({ projectId: app.id, kind: 'bug', title: 'Login crash on Android 14', ref: 'BUG-142' })
    let settings: Settings = mergeSettings(DEFAULT_SETTINGS, {
      work: { teams: { clientId: 'mock-client', tenant: 'mock', authorityUrl: mock.url, graphBaseUrl: mock.url } }
    })
    const x = graph()
    const llm = new MockLlm()
    const sent: ImportSource[] = []
    // One proposal per message line ("[time] Author (in chat): text").
    llm.completeText = (req) => {
      const text = String(req.messages[0].content)
      sent.push({ text })
      const lines = text.split('<messages>\n')[1].split('\n</messages>')[0].split('\n')
      const proposals = lines.map((line) => {
        const m = /^\[[^\]]+\] (.+?) \(in [^)]+\): (.*)$/.exec(line)!
        return { project: 'P1', item: 'P1.1', changes: {}, update: `${m[1]}: ${m[2]}`, author: m[1], quote: m[2] }
      })
      return JSON.stringify({ proposals, skipped: [] })
    }
    const importer = new TeamsImporter({ llm, store, getSettings: () => settings, getOwner: () => 'Omkar' })
    const sync = new TeamsSync({ graph: x.g, importer, store, getSettings: () => settings })
    cleanup.push(() => sync.dispose())
    const follow = () => {
      settings = mergeSettings(settings, { work: { teams: { sources: [{ kind: 'chat', id: GROUP, teamId: null, name: 'Mobile app – dev' }] } } })
      sync.refresh()
    }
    return { store, sync, llm, sent, follow, x }
  }

  it('signs in, reads followed chats into the review queue, and only new messages next time', async () => {
    const { store, sync, llm, follow } = setup()
    const states: string[] = []
    sync.on('status', (s) => states.push(s.account ? 'in' : s.signIn ? 'code' : 'out'))
    await sync.signIn()
    await new Promise((r) => setTimeout(r, 50))
    expect(sync.status().account).toBe('Omkar Kamale · omkar@contoso.dev')
    expect(states).toContain('code')

    follow()
    await sync.syncNow()
    expect(llm.completions).toHaveLength(1)
    expect(String(llm.completions[0].messages[0].content)).toContain('Ravi Kumar (in Mobile app – dev): Login crash fix is in code review: PR #482.')
    expect(store.proposals()).toHaveLength(7)
    expect(store.proposals()[0].source).toBe('teams')
    expect(sync.status()).toMatchObject({ lastFound: 7, error: null })

    await sync.syncNow()
    expect(llm.completions).toHaveLength(1)

    mock.post({ chatId: GROUP, author: 'Sneha Patil', text: 'Push notification fix merged to main' })
    await sync.syncNow()
    expect(llm.completions).toHaveLength(2)
    const second = String(llm.completions[1].messages[0].content)
    expect(second).toContain('Sneha Patil (in Mobile app – dev): Push notification fix merged to main')
    expect(second).not.toContain('PR #482')
    expect(store.proposals()).toHaveLength(8)
    expect(store.proposals().at(-1)).toMatchObject({ author: 'Sneha Patil', quote: 'Push notification fix merged to main' })
  })

  it('keeps messages unread when extraction fails, and reports it', async () => {
    const { sync, llm, follow, store } = setup()
    await sync.signIn()
    await new Promise((r) => setTimeout(r, 50))
    follow()
    const ok = llm.completeText
    llm.completeText = () => 'not json'
    await sync.syncNow()
    expect(sync.status().error).toBe("The model's reply couldn't be read — try again.")
    llm.completeText = ok
    await sync.syncNow()
    expect(store.proposals()).toHaveLength(7)
    expect(sync.status().error).toBeNull()
  })

  it('signs out', async () => {
    const { sync, x } = setup()
    await sync.signIn()
    await new Promise((r) => setTimeout(r, 50))
    sync.signOut()
    expect(x.g.isSignedIn()).toBe(false)
    expect(sync.status().account).toBeNull()
  })
})
