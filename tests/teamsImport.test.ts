import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { messageText } from '../src/main/services/llm/LlmProvider'
import { LlmError } from '../src/main/services/llm/LlmProvider'
import { ProjectStore } from '../src/main/services/work/ProjectStore'
import { TeamsImporter, buildImportMessages, parseImport } from '../src/main/services/work/teamsImport'
import { MockLlm } from './mockLlm'

const NOW = Date.parse('2026-10-02T10:00:00')

const CHAT = `Ravi Kumar  9:12 AM
Picked up the Android 14 login crash, fix should be in review by EOD
Sneha  9:20 AM
Good morning all!
Priya  9:31 AM
Pinged the MDM team again about the UAT profile, they need the signed build first
Arjun  9:45 AM
New one: app freezes on the payment screen when switching tabs, logged as BUG-171, I'll take it`

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cue-import-'))
  const store = new ProjectStore({ dir, now: () => NOW })
  cleanup.push(() => {
    store.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const app = store.save({ name: 'Mobile app', aliases: ['the app'], status: 'at_risk' })
  const uat = store.saveTaskWithId({ projectId: app.id, kind: 'deployment', title: 'UAT deployment', status: 'waiting', waitingOn: 'MDM team' }).taskId
  const crash = store.saveTaskWithId({ projectId: app.id, kind: 'bug', title: 'Login crash on Android 14', ref: 'BUG-142', status: 'todo' }).taskId
  store.save({ name: 'Payments migration' })
  return { store, appId: app.id, uat, crash }
}

/** What a good model reply to CHAT looks like (item ids as listed in the prompt). */
const REPLY = JSON.stringify({
  proposals: [
    {
      project: 'P1',
      item: 'P1.2',
      changes: { status: 'in_progress', owner: 'Ravi Kumar', waiting_on: '' },
      update: 'Ravi picked up the login crash; fix in review by end of day',
      author: 'Ravi Kumar',
      time: '2026-10-02 09:12',
      quote: 'Picked up the Android 14 login crash, fix should be in review by EOD'
    },
    {
      project: 'P1',
      item: 'P1.1',
      changes: { followed_up: '2026-10-02', follow_up_note: 'Priya pinged the MDM team', blockers: 'MDM needs the signed build first', due: 'Friday' },
      update: 'Priya pinged MDM again; they need the signed build before the UAT profile',
      author: 'Priya',
      time: '2026-10-02 09:31',
      quote: 'Pinged the MDM team again about the UAT profile, they need the signed build first'
    },
    {
      project: 'P1',
      item: null,
      new_item: { kind: 'bug', title: 'App freezes on payment screen when switching tabs' },
      changes: { ref: 'BUG-171', owner: 'Arjun', status: 'in_progress' },
      update: 'Arjun logged BUG-171 (freeze on the payment screen) and is taking it',
      author: 'Arjun',
      time: '2026-10-02 09:45',
      quote: "New one: app freezes on the payment screen when switching tabs, logged as BUG-171, I'll take it"
    },
    { project: 'P9', item: null, changes: {}, update: 'something', author: 'X', quote: 'about nothing we track' }
  ],
  skipped: [{ author: 'Sneha', quote: 'Good morning all!', reason: 'small talk' }]
})

describe('Teams import prompt (§6.10)', () => {
  it('lists projects and items with short ids, and the messages', () => {
    const { store } = setup()
    const [msg] = buildImportMessages(store.list(), { text: CHAT }, NOW, 'Omkar')
    const text = messageText(msg)
    expect(text).toContain("into proposed updates to Omkar's project tracker. Today is 2026-10-02 (Friday).")
    expect(text).toMatch(/P\d Mobile app \(also called the app\) — At risk\n {2}P\d\.1 \[Deployment · Waiting\] UAT deployment — waiting on MDM team/)
    expect(text).toContain('<messages>\nRavi Kumar  9:12 AM')
  })

  it('sends screenshots as images with a note to read them in order', () => {
    const { store } = setup()
    const [msg] = buildImportMessages(store.list(), { images: [1, 2].map(() => ({ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' })) }, NOW, 'Omkar')
    expect(Array.isArray(msg.content) && msg.content.filter((p) => p.type === 'image')).toHaveLength(2)
    expect(messageText(msg)).toContain("The messages are in the 2 attached screenshots of one Teams chat, in order (they may overlap — don't repeat a message).")
  })
})

describe('parsing the import reply', () => {
  it('maps ids, keeps valid fields only, and drops what it cannot place', () => {
    const { store, appId, uat, crash } = setup()
    const list = store.list()
    // P1 is the most recently updated project.
    const reply = REPLY.replaceAll('"P1', `"${list[0].id === appId ? 'P1' : 'P2'}`)
    const parsed = parseImport(`\`\`\`json\n${reply}\n\`\`\``, list, 'import')!
    expect(parsed.proposals).toHaveLength(3)
    const [a, b, c] = parsed.proposals
    expect(a).toMatchObject({ projectId: appId, taskId: crash, changes: { status: 'in_progress', owner: 'Ravi Kumar' }, author: 'Ravi Kumar' })
    expect(a.changes).not.toHaveProperty('waitingOn')
    // The UAT item already waits on the MDM team: not proposed again.
    const same = parseImport(reply.replace('"follow_up_note"', '"waiting_on": "mdm team", "follow_up_note"'), list, 'import')!
    expect(same.proposals[1].changes).not.toHaveProperty('waitingOn')
    expect(a.ts).toBe(Date.parse('2026-10-02T09:12:00'))
    // "Friday" isn't a date: dropped, the rest kept.
    expect(b).toMatchObject({ taskId: uat, changes: { followedUp: '2026-10-02', followUpNote: 'Priya pinged the MDM team', blockers: 'MDM needs the signed build first' } })
    expect(b.changes).not.toHaveProperty('due')
    expect(c).toMatchObject({ taskId: null, newItem: { kind: 'bug', title: 'App freezes on payment screen when switching tabs' }, changes: { ref: 'BUG-171' } })
    expect(parsed.skipped.map((s) => s.reason)).toEqual(['small talk', 'not about a tracked project'])
  })

  it('returns null for a reply that is not JSON', () => {
    const { store } = setup()
    expect(parseImport('Sorry, I cannot help with that.', store.list(), 'import')).toBeNull()
  })
})

describe('TeamsImporter and the review queue (FR-T1, FR-T4)', () => {
  function importer(reply: string | LlmError) {
    const f = setup()
    const llm = new MockLlm()
    llm.completeText = () => {
      if (reply instanceof LlmError) throw reply
      const list = f.store.list()
      return reply.replaceAll('"P1', `"${list[0].id === f.appId ? 'P1' : 'P2'}`)
    }
    const teams = new TeamsImporter({ llm, store: f.store, getSettings: () => DEFAULT_SETTINGS, getOwner: () => 'Omkar', now: () => NOW })
    return { ...f, llm, teams }
  }

  it('turns pasted messages into proposals; pasting the same chat again adds nothing', async () => {
    const { teams, store, llm } = importer(REPLY)
    const res = await teams.run({ text: CHAT })
    expect(res).toMatchObject({ ok: true, proposals: { length: 3 }, skipped: { length: 2 } })
    expect(llm.completions[0]).toMatchObject({ role: 'answer', purpose: 'import' })
    expect(store.proposals()).toHaveLength(3)
    const again = await teams.run({ text: CHAT })
    expect(again.ok && again.proposals).toHaveLength(0)
    // Same messages with different punctuation (pasted vs synced) are recognised too.
    const [first] = store.proposals()
    expect(store.addProposals([{ ...first, quote: `${first.quote.replace(/,/g, '')}.` }])).toHaveLength(0)
    expect(store.proposals()).toHaveLength(3)
  })

  it('reads screenshots with the vision models', async () => {
    const { teams, llm } = importer(REPLY)
    await teams.run({ images: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }] })
    expect(llm.completions[0].role).toBe('vision')
  })

  it('changes nothing until accepted; accepting applies fields and logs the update with its author and time', async () => {
    const { teams, store, appId, crash } = importer(REPLY)
    await teams.run({ text: CHAT })
    expect(store.getTask(crash)).toMatchObject({ status: 'todo', owner: '' })
    const [first] = store.proposals()
    store.decideProposal({ id: first.id, action: 'accept' })
    expect(store.getTask(crash)).toMatchObject({ status: 'in_progress', owner: 'Ravi Kumar', ref: 'BUG-142' })
    expect(store.get(appId)!.updates[0]).toMatchObject({
      taskId: crash,
      author: 'Ravi Kumar',
      source: 'import',
      ts: Date.parse('2026-10-02T09:12:00'),
      text: 'Ravi picked up the login crash; fix in review by end of day'
    })
    expect(store.proposals()).toHaveLength(2)
    expect(() => store.decideProposal({ id: first.id, action: 'accept' })).toThrow('already handled')
  })

  it('creates a new item on accept, takes edits, and skips', async () => {
    const { teams, store, appId } = importer(REPLY)
    await teams.run({ text: CHAT })
    const [, follow, bug] = store.proposals()
    const accepted = store.decideProposal({ id: bug.id, action: 'accept', edits: { update: 'Arjun owns BUG-171 (payment screen freeze)' } })
    const created = store.get(appId)!.tasks.find((t) => t.ref === 'BUG-171')!
    expect(created).toMatchObject({ kind: 'bug', title: 'App freezes on payment screen when switching tabs', owner: 'Arjun', status: 'in_progress' })
    expect(accepted).toMatchObject({ state: 'accepted', taskId: created.id })
    expect(store.get(appId)!.updates[0]).toMatchObject({ text: 'Arjun owns BUG-171 (payment screen freeze)', taskId: created.id })
    // The same bug reported again (another chat, other wording): accepting updates the item made above.
    const [again] = store.addProposals([{ ...bug, quote: 'app freezes on payment screen when switching tabs — BUG-171', update: 'Arjun: BUG-171 repro on iOS too', changes: { ref: 'BUG-171', environment: 'iOS' } }])
    store.decideProposal({ id: again.id, action: 'accept' })
    expect(store.get(appId)!.tasks.filter((t) => t.ref === 'BUG-171')).toHaveLength(1)
    expect(store.getTask(created.id)!.environment).toBe('iOS')
    store.decideProposal({ id: follow.id, action: 'skip' })
    expect(store.proposals()).toHaveLength(1)
    expect(store.proposals('skipped')).toHaveLength(1)
  })

  it('reports failures without adding anything', async () => {
    const failing = importer(new LlmError('rate_limit', 'Groq: rate limited'))
    expect(await failing.teams.run({ text: CHAT })).toEqual({ ok: false, error: "Couldn't read the messages: Groq: rate limited" })
    const junk = importer('no json here')
    expect(await junk.teams.run({ text: CHAT })).toEqual({ ok: false, error: "The model's reply couldn't be read — try again." })
    expect(junk.store.proposals()).toHaveLength(0)
  })
})
