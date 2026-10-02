import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuestionDetected, TranscriptUpdate } from '@shared/ipc'
import { EMPTY_PROFILE } from '@shared/profile'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings'
import type { Project } from '@shared/work'
import { AnswerService } from '../src/main/services/answer/AnswerService'
import { CopilotService, type StatusPickRequest } from '../src/main/services/answer/CopilotService'
import { ProjectStore } from '../src/main/services/work/ProjectStore'
import { WorkDetector, looksLikeQuestion } from '../src/main/services/work/WorkDetector'
import { confidentTarget } from '../src/main/services/work/projectMatch'
import { buildStatusClassifierMessages, buildStatusSystem, projectContext } from '../src/main/services/work/workPrompts'
import { isDifferentTopic, resolveWorkQuestion } from '../src/main/services/work/workQuestions'
import { MockLlm } from './mockLlm'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-02T10:00:00')

/** A "Mobile app" project with the items people ask about one by one, and a second project. */
function seed(now = () => NOW) {
  const dir = mkdtempSync(join(tmpdir(), 'cue-items-'))
  const store = new ProjectStore({ dir, now })
  const app = store.save({ name: 'Mobile app', aliases: ['the app'], status: 'at_risk', stakeholders: 'Priya (director)' })
  const add = (input: Record<string, unknown>) => store.saveTaskWithId({ projectId: app.id, ...input }).taskId
  const ids = {
    uat: add({
      kind: 'deployment',
      title: 'UAT deployment',
      status: 'waiting',
      waitingOn: 'MDM team',
      environment: 'UAT',
      followedUp: '2026-10-01',
      followUpNote: 'Priya emailed the MDM team'
    }),
    prod: add({ kind: 'deployment', title: 'Prod deployment', status: 'todo', environment: 'Prod', due: '2026-10-20' }),
    tom: add({ kind: 'approval', title: 'TOM approvals', status: 'waiting', owner: 'Omkar', note: '2 of 3 signed; security pending' }),
    crash: add({ kind: 'bug', title: 'Login crash on Android 14', ref: 'BUG-142', owner: 'Ravi', status: 'in_progress' }),
    push: add({ kind: 'bug', title: 'Push notifications not arriving', ref: 'BUG-150', owner: 'Sneha' }),
    old: add({ kind: 'bug', title: 'Splash screen flicker', ref: 'BUG-120', owner: 'Ravi', status: 'done' })
  }
  const pay = store.save({ name: 'Payments migration', aliases: ['the migration'], status: 'on_track' })
  return { dir, store, appId: app.id, payId: pay.id, ids, list: () => store.list() }
}

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})
function fixture(now?: () => number) {
  const f = seed(now)
  cleanup.push(() => {
    f.store.dispose()
    rmSync(f.dir, { recursive: true, force: true })
  })
  return f
}

describe('work items (FR-W2/W3)', () => {
  it('stores kind, owner, waiting on, environment, follow-up and ref', () => {
    const { store, appId, ids } = fixture()
    const app = store.get(appId)!
    expect(app.tasks).toHaveLength(6)
    expect(store.getTask(ids.uat)).toMatchObject({
      kind: 'deployment',
      status: 'waiting',
      waitingOn: 'MDM team',
      environment: 'UAT',
      followedUp: '2026-10-01',
      followUpNote: 'Priya emailed the MDM team'
    })
    expect(store.getTask(ids.crash)).toMatchObject({ kind: 'bug', ref: 'BUG-142', owner: 'Ravi' })
  })

  it('logs updates on an item with who said them; deleting the item keeps them on the project', () => {
    const { store, appId, payId, ids } = fixture()
    const app = store.addUpdate(appId, 'Fix is in review, should land tomorrow.', { taskId: ids.crash, author: 'Ravi', source: 'import' })
    expect(app.updates[0]).toMatchObject({ taskId: ids.crash, author: 'Ravi', source: 'import' })
    expect(() => store.addUpdate(payId, 'wrong project', { taskId: ids.crash })).toThrow('not part of this project')
    store.deleteTask(ids.crash)
    expect(store.get(appId)!.updates[0]).toMatchObject({ text: 'Fix is in review, should land tomorrow.', taskId: null, author: 'Ravi' })
  })

  it('keeps an imported message at the time it was said', () => {
    const { store, appId, ids } = fixture()
    const said = NOW - 3 * DAY
    expect(store.addUpdate(appId, 'Pinged MDM again', { taskId: ids.uat }, said).updates[0].ts).toBe(said)
  })
})

describe('matching items (FR-W5)', () => {
  it('finds the item a question is about', () => {
    const { list, ids, appId } = fixture()
    const target = (text: string) => {
      const t = confidentTarget(text, list())
      return t ? { project: t.project.id, task: t.task?.id } : null
    }
    expect(target('Did we follow up with the MDM team to get the app deployed on UAT?')).toEqual({ project: appId, task: ids.uat })
    expect(target("What's the status of Tom approvals?")).toEqual({ project: appId, task: ids.tom })
    expect(target('Is bug 142 fixed yet?')).toEqual({ project: appId, task: ids.crash })
    expect(target('Who is on the push notifications issue?')).toEqual({ project: appId, task: ids.push })
  })

  it('falls back to the project when two of its items fit, or only generic words are said', () => {
    const { list, appId, payId } = fixture()
    expect(confidentTarget("How's the deployment going on the mobile app?", list())).toMatchObject({ project: { id: appId } })
    expect(confidentTarget("How's the deployment going on the mobile app?", list())?.task).toBeUndefined()
    expect(confidentTarget('Which bugs are open on the mobile app?', list())?.task).toBeUndefined()
    expect(confidentTarget('Where are we on the migration?', list())).toMatchObject({ project: { id: payId } })
    expect(confidentTarget('Any approvals pending?', list())).toBeNull()
  })
})

describe('detecting item questions (FR-W8)', () => {
  const make = (list: Project[], reply = '{"is_status_question": false, "project_hint": null}') => {
    const classify = vi.fn(async () => reply)
    return { classify, detector: new WorkDetector({ getProjects: () => list, classify, minWords: () => 6 }) }
  }

  it('answers "did we follow up with…" about an item without the LLM', async () => {
    const { list, ids, appId } = fixture()
    const { detector, classify } = make(list())
    const d = await detector.detect(['Omkar, did we follow up with the MDM team to get the app deployed on UAT?'], [])
    expect(d).toMatchObject({ isQuestion: true, type: 'status', projectId: appId, taskId: ids.uat, via: 'heuristic' })
    expect(classify).not.toHaveBeenCalled()
  })

  it('asks the classifier about statements that only mention an item', async () => {
    const { list } = fixture()
    const { detector, classify } = make(list())
    const d = await detector.detect(['The TOM approvals came through from security yesterday.'], [])
    expect(classify).toHaveBeenCalledOnce()
    expect(d.isQuestion).toBe(false)
  })

  it('tells questions from statements', () => {
    expect(looksLikeQuestion('Okay. Thanks everyone. Omkar, what is pending on the TOM approvals')).toBe(true)
    expect(looksLikeQuestion('Which bugs are open?')).toBe(true)
    expect(looksLikeQuestion('The TOM approvals are pending with security.')).toBe(false)
  })

  it('lists open items for the classifier', () => {
    const { list } = fixture()
    const text = buildStatusClassifierMessages('x', [], list())[0].content as string
    expect(text).toContain('Mobile app (the app) — items: UAT deployment, Prod deployment, TOM approvals, Login crash on Android 14, Push notifications not arriving')
    expect(text).not.toContain('Splash screen flicker')
  })
})

describe('item and list answers (FR-W4, FR-W7)', () => {
  it('always sends open items as exact lines, and the asked-about item with its updates', () => {
    const { store, appId, ids } = fixture()
    store.addUpdate(appId, 'MDM said they need the signed build first.', { taskId: ids.uat, author: 'Priya' }, NOW - 4 * DAY)
    const app = store.get(appId)!
    const [system] = buildStatusSystem({ ...EMPTY_PROFILE, name: 'Omkar' }, app, NOW, ids.uat)
    expect(system.text).toContain(
      '- [Deployment · Waiting] UAT deployment — waiting on MDM team; env UAT; last follow-up 2026-10-01 (yesterday): Priya emailed the MDM team'
    )
    expect(system.text).toContain('- [Bug · In progress] Login crash on Android 14 [BUG-142] — owner Ravi')
    expect(system.text).toContain('Say the stored status as it is ("at risk"')
    expect(system.text).toContain('<asked_about_item>')
    expect(system.text).toContain('- 2026-09-28 (Priya, on UAT deployment): MDM said they need the signed build first.')
    expect(system.text).toContain('The latest update is 4 days old — say so.')
    // Finished items belong to the (condensable) background, not the open list.
    expect(system.text).not.toMatch(/Open items:[\s\S]*Splash screen flicker/)
  })

  it('keeps open items even when the background is condensed', () => {
    const { store, appId } = fixture()
    store.save({ id: appId, name: 'Mobile app', aliases: ['the app'], status: 'at_risk', notes: 'Long history. '.repeat(80) })
    const app = store.get(appId)!
    store.setSummary(appId, '- Condensed background.', null)
    const text = projectContext({ ...store.get(appId)!, summaryOf: app.summaryOf }, NOW)
    expect(text).toContain('Open items:')
    expect(text).toContain('TOM approvals')
  })
})

describe('typed and voice questions in Work Mode (FR-W6, FR-W10)', () => {
  it('status-checks typed questions', () => {
    const { list, ids, appId, payId } = fixture()
    expect(resolveWorkQuestion("How's the migration coming along?", list())).toEqual({ type: 'status', projectId: payId })
    expect(resolveWorkQuestion("What's pending on the TOM approvals?", list())).toEqual({ type: 'status', projectId: appId, taskId: ids.tom })
    expect(resolveWorkQuestion('Any update on the project?', list())).toMatchObject({ type: 'status' })
    expect(resolveWorkQuestion('Any update on the project?', list()).projectId).toBeUndefined()
    expect(resolveWorkQuestion('Draft a short note to the MDM team', list())).toEqual({ type: 'work' })
  })

  it('knows when speech moves to another project or item', () => {
    const { list, ids, appId, payId } = fixture()
    expect(isDifferentTopic({ projectId: appId }, 'And where are we on the payments migration?', list())).toBe(true)
    expect(isDifferentTopic({ projectId: appId, taskId: ids.uat }, 'And the TOM approvals?', list())).toBe(true)
    expect(isDifferentTopic({ projectId: appId, taskId: ids.uat }, 'and when will that be done?', list())).toBe(false)
    expect(isDifferentTopic({ projectId: payId }, 'the migration, I mean', list())).toBe(false)
    expect(isDifferentTopic({ projectId: appId, taskId: ids.tom }, 'Which bugs are open on the mobile app?', list())).toBe(true)
    expect(isDifferentTopic({ projectId: appId }, 'on the mobile app', list())).toBe(false)
  })
})

describe('CopilotService with work items', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }))
  afterEach(() => vi.useRealTimers())

  let seq = 0
  const partial = (text: string): TranscriptUpdate => ({ id: `w${++seq}`, source: 'loopback', text, isFinal: false, ts: Date.now() })
  const final = (u: TranscriptUpdate): TranscriptUpdate => ({ ...u, isFinal: true })

  function setup() {
    const f = fixture(() => Date.now())
    const settings = mergeSettings(DEFAULT_SETTINGS, { mode: 'work' })
    const llm = new MockLlm()
    const detector = new WorkDetector({ getProjects: f.list, classify: vi.fn(async () => '{}'), minWords: () => 6 })
    const answers = new AnswerService({
      provider: llm,
      getSettings: () => settings,
      getProfile: () => ({ ...EMPTY_PROFILE, name: 'Omkar' }),
      getMode: () => 'work',
      projects: f.store,
      sleep: async () => {}
    })
    const copilot = new CopilotService({
      detector,
      answers,
      getSettings: () => settings,
      getMode: () => 'work',
      projectName: (id, taskId) => {
        const p = f.store.get(id)
        const t = taskId ? p?.tasks.find((x) => x.id === taskId) : undefined
        return p ? (t ? `${p.name} · ${t.title}` : p.name) : null
      },
      resolveQuestion: (text) => resolveWorkQuestion(text, f.list()),
      differentTopic: (prev, text) => isDifferentTopic(prev, text, f.list())
    })
    const questions: QuestionDetected[] = []
    const picks: StatusPickRequest[] = []
    copilot.on('question', (q) => questions.push(q))
    copilot.on('pick', (p) => picks.push(p))
    copilot.startSession()
    return { ...f, copilot, llm, questions, picks }
  }

  /** Someone speaks `text`: speech starts, then the utterance ends. */
  async function say(copilot: CopilotService, text: string) {
    const u = partial(text)
    copilot.onTranscript(u)
    await vi.advanceTimersByTimeAsync(200)
    copilot.onUtteranceEnd(final(u))
  }

  it('answers a quick second question about another project on its own (bug from live testing)', async () => {
    const { copilot, questions, payId, appId } = setup()
    await say(copilot, "Omkar, what's the status of the mobile app?")
    await vi.advanceTimersByTimeAsync(300)
    // The next speaker starts well inside the 3 s "carrying on" window.
    await say(copilot, 'Got it. And where are we on the payments migration?')
    await vi.advanceTimersByTimeAsync(2500)
    expect(questions.map((q) => q.project)).toEqual(['Mobile app', 'Payments migration'])
    expect(copilot.list().map((q) => q.projectId)).toEqual([appId, payId])
  })

  it('answers an item question about that item, with its own updates', async () => {
    const { copilot, questions, llm, ids } = setup()
    await say(copilot, 'Did we follow up with the MDM team to get the app deployed on UAT?')
    await vi.advanceTimersByTimeAsync(2500)
    expect(questions[0]).toMatchObject({ type: 'status', project: 'Mobile app · UAT deployment' })
    expect(copilot.list()[0].taskId).toBe(ids.uat)
    expect(llm.requests[0].system[0].text).toContain('<asked_about_item>\n[Deployment · Waiting] UAT deployment')
  })

  it('gives typed status questions the spoken status answer, and asks which project when unclear', async () => {
    const { copilot, questions, picks } = setup()
    copilot.ask("How's the migration coming along?")
    await vi.advanceTimersByTimeAsync(10)
    expect(questions[0]).toMatchObject({ type: 'status', project: 'Payments migration' })
    copilot.ask('Any update on the project?')
    await vi.advanceTimersByTimeAsync(10)
    expect(questions).toHaveLength(1)
    expect(picks).toMatchObject([{ question: 'Any update on the project?' }])
  })
})
