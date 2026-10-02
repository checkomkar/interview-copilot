import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuestionDetected, TranscriptUpdate } from '@shared/ipc'
import { EMPTY_PROFILE } from '@shared/profile'
import { DEFAULT_SETTINGS, SettingsSchema, applyLegacyMode, mergeSettings } from '@shared/settings'
import type { Project, Task } from '@shared/work'
import { AnswerService } from '../src/main/services/answer/AnswerService'
import { CopilotService, type StatusPickRequest } from '../src/main/services/answer/CopilotService'
import { HistoryService } from '../src/main/services/history/HistoryService'
import { messageText } from '../src/main/services/llm/LlmProvider'
import { ProjectCondenser } from '../src/main/services/work/ProjectCondenser'
import { ProjectStore } from '../src/main/services/work/ProjectStore'
import { WorkDetector } from '../src/main/services/work/WorkDetector'
import { confidentMatch, rankProjects } from '../src/main/services/work/projectMatch'
import {
  WORK_SCREEN_QUESTION,
  buildStatusClassifierMessages,
  buildStatusMessages,
  buildStatusSystem,
  contextHash,
  needsCondensing,
  parseStatusClassifier,
  projectBody,
  projectContext,
  relativeDays
} from '../src/main/services/work/workPrompts'
import { MockLlm } from './mockLlm'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-02T10:00:00')

function item(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: 'p1',
    kind: 'task',
    aliases: [],
    status: 'todo',
    owner: '',
    waitingOn: '',
    environment: '',
    due: '',
    followedUp: '',
    followUpNote: '',
    blockers: '',
    ref: '',
    note: '',
    updatedAt: NOW,
    ...over
  }
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Payments migration',
    aliases: ['PRISM'],
    status: 'at_risk',
    owner: 'Omkar',
    stakeholders: 'Priya (director)',
    deadline: '2026-11-12',
    notes: 'Moving card payments to the new processor.',
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * DAY,
    summary: '',
    summaryOf: null,
    context: 'short',
    tasks: [],
    updates: [],
    ...over
  }
}

describe('project matching (FR-W5)', () => {
  const projects = [
    project({ id: 'pay', name: 'Payments migration', aliases: ['PRISM'] }),
    project({ id: 'bench', name: 'Benchmarking tool', aliases: ['the perf harness'] }),
    project({ id: 'ob', name: 'Onboarding revamp', aliases: [] })
  ]

  it('matches a name or alias said as-is', () => {
    expect(confidentMatch("what's the status of PRISM?", projects)?.project.id).toBe('pay')
    expect(confidentMatch('How is the perf harness coming along', projects)?.project.id).toBe('bench')
    expect(confidentMatch('any update on the onboarding revamp', projects)?.project.id).toBe('ob')
  })

  it('matches part of a name, other word forms and one-letter transcription slips', () => {
    expect(confidentMatch("how's the migration going", projects)?.project.id).toBe('pay')
    expect(confidentMatch('where are we on benchmarks', projects)?.project.id).toBe('bench')
    expect(confidentMatch('update on prysm', projects)?.project.id).toBe('pay')
  })

  it('asks instead of guessing when two projects fit equally, or nothing fits', () => {
    const two = [...projects, project({ id: 'db', name: 'Database migration', aliases: [] })]
    expect(confidentMatch("how's the migration going", two)).toBeNull()
    expect(rankProjects("how's the migration going", two).map((m) => m.project.id).sort()).toEqual(['db', 'pay'])
    expect(confidentMatch('how was your weekend', projects)).toBeNull()
  })

  it('ignores generic words like "project" or "the"', () => {
    expect(rankProjects('the project team', [project({ id: 'x', name: 'The Project', aliases: [] })])).toHaveLength(1)
    expect(rankProjects('our team tool', projects)).toEqual([])
  })
})

describe('ProjectStore (FR-W1..W3)', () => {
  let dir: string
  let now: number
  let store: ProjectStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'projects-'))
    now = NOW
    store = new ProjectStore({ dir, now: () => now })
  })
  afterEach(() => {
    store.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates, edits and lists projects with tasks and updates', () => {
    const changed: string[] = []
    store.on('changed', (id) => changed.push(id))
    const p = store.save({ name: ' Payments migration ', aliases: ['PRISM', 'payments migration'], status: 'at_risk', deadline: '2026-11-12' })
    expect(p).toMatchObject({ name: 'Payments migration', aliases: ['PRISM'], status: 'at_risk', deadline: '2026-11-12', tasks: [], updates: [], context: 'short' })

    now += 1000
    const withTask = store.saveTask({ projectId: p.id, title: 'Get sandbox keys', status: 'blocked', blockers: 'Bank hasn’t replied' })
    expect(withTask.tasks).toMatchObject([{ title: 'Get sandbox keys', status: 'blocked', blockers: 'Bank hasn’t replied' }])
    expect(withTask.updatedAt).toBe(now)

    now += 1000
    store.addUpdate(p.id, 'Cut-over moved to Nov 12.')
    now += 1000
    const updated = store.addUpdate(p.id, 'Keys arrived.')
    expect(updated.updates.map((u) => u.text)).toEqual(['Keys arrived.', 'Cut-over moved to Nov 12.'])

    const edited = store.save({ id: p.id, name: 'Payments migration', status: 'on_track' })
    expect(edited.status).toBe('on_track')
    expect(edited.tasks).toHaveLength(1)
    expect(store.list().map((x) => x.id)).toEqual([p.id])
    expect(changed.every((id) => id === p.id)).toBe(true)
  })

  it('rejects invalid input', () => {
    expect(() => store.save({ name: '  ' })).toThrow()
    expect(() => store.save({ name: 'X', deadline: 'next week' })).toThrow()
    expect(() => store.addUpdate('missing', 'hi')).toThrow('no longer exists')
  })

  it('deletes tasks, updates and whole projects (cascading)', () => {
    const p = store.save({ name: 'A' })
    const t = store.saveTask({ projectId: p.id, title: 'T' }).tasks[0]
    const u = store.addUpdate(p.id, 'U').updates[0]
    expect(store.deleteTask(t.id)?.tasks).toEqual([])
    expect(store.deleteUpdate(u.id)?.updates).toEqual([])
    store.saveTask({ projectId: p.id, title: 'T2' })
    store.delete(p.id)
    expect(store.list()).toEqual([])
    expect(store.get(p.id)).toBeNull()
  })

  it('reports whether answers get the full text or a condensed summary (FR-W4)', () => {
    const p = store.save({ name: 'Long', notes: 'x '.repeat(400) })
    expect(p.context).toBe('pending')
    store.setSummary(p.id, 'Short summary.', contextHash(projectBody(store.get(p.id)!)))
    expect(store.get(p.id)!.context).toBe('condensed')
    store.addUpdate(p.id, 'new') // still in the five recent updates: the condensed part is unchanged
    expect(store.get(p.id)!.context).toBe('condensed')
    store.save({ id: p.id, name: 'Long', notes: 'y '.repeat(400) })
    expect(store.get(p.id)!.context).toBe('pending')
  })
})

describe('Work prompts (§6.5–6.9)', () => {
  it('describes dates relative to today', () => {
    expect(relativeDays('2026-10-02', NOW)).toBe('today')
    expect(relativeDays('2026-10-12', NOW)).toBe('in 10 days')
    expect(relativeDays(NOW - 3 * DAY, NOW)).toBe('3 days ago')
  })

  it('builds the status prompt from the project, its recent updates and the call', () => {
    const p = project({
      tasks: [item({ id: 't', title: 'Sandbox keys', status: 'blocked', due: '2026-10-05', blockers: 'bank' })],
      updates: [{ id: 1, projectId: 'p1', ts: NOW - DAY, text: 'Cut-over moved to Nov 12.', source: 'typed', taskId: null, author: '' }]
    })
    const [system] = buildStatusSystem({ ...EMPTY_PROFILE, name: 'Omkar', role: 'Engineering lead' }, p, NOW)
    expect(system.cache).toBe(true)
    expect(system.text).toContain('give a live, spoken status update on "Payments migration"')
    expect(system.text).toContain('during a work call with Priya (director)')
    expect(system.text).toContain('Status: At risk · Owner: Omkar · Deadline: 2026-11-12 (in 41 days)')
    expect(system.text).toContain('Last updated: 2026-09-30 (2 days ago)')
    expect(system.text).toContain('- [Task · Blocked] Sandbox keys — due 2026-10-05 (in 3 days); blocker: bank; updated 2026-10-02 (today)')
    expect(system.text).toContain('<recent_updates>\n- 2026-10-01: Cut-over moved to Nov 12.')
    expect(system.text).toContain('Never invent progress, dates, or numbers.')
    const [user] = buildStatusMessages({
      question: 'Where are we on PRISM?',
      transcript: [{ source: 'loopback', text: 'Where are we on PRISM?' }],
      style: 'auto'
    })
    expect(messageText(user)).toContain('Them: Where are we on PRISM?')
    expect(messageText(user)).toContain('They asked: "Where are we on PRISM?"')
  })

  it('uses the condensed summary only while it matches the notes', () => {
    const long = project({ notes: 'detail '.repeat(150) })
    expect(needsCondensing(long)).toBe(true)
    expect(projectContext(long, NOW)).toContain('detail detail')
    const condensed = { ...long, summary: '- Condensed.', summaryOf: contextHash(projectBody(long)) }
    expect(needsCondensing(condensed)).toBe(false)
    expect(projectContext(condensed, NOW)).toContain('- Condensed.')
    expect(projectContext(condensed, NOW)).not.toContain('detail detail')
    expect(projectContext({ ...condensed, notes: 'changed' }, NOW)).not.toContain('Condensed')
  })

  it('parses the status classifier defensively', () => {
    expect(parseStatusClassifier('```json\n{"is_status_question": true, "project_hint": "PRISM"}\n```')).toEqual({ isStatus: true, hint: 'PRISM' })
    expect(parseStatusClassifier('{"is_status_question": false, "project_hint": null}')).toEqual({ isStatus: false, hint: null })
    expect(parseStatusClassifier('{"is_status_question": true, "project_hint": "null"}')).toEqual({ isStatus: true, hint: null })
    expect(parseStatusClassifier('nope')).toBeNull()
    expect(messageText(buildStatusClassifierMessages('how is it going', ['hi'], [project()])[0])).toContain('Known projects: Payments migration (PRISM)')
  })
})

describe('WorkDetector (FR-W8/W9)', () => {
  const projects = [project({ id: 'pay' }), project({ id: 'bench', name: 'Benchmarking tool', aliases: [] })]
  const make = (reply: string | (() => Promise<string>), list = projects) => {
    const classify = vi.fn(typeof reply === 'string' ? async () => reply : reply)
    return { classify, detector: new WorkDetector({ getProjects: () => list, classify, minWords: () => 6 }) }
  }

  it('answers a clear status question about a known project without the LLM', async () => {
    const { detector, classify } = make('{}')
    const d = await detector.detect(["So Omkar, what's the status of PRISM?"], [])
    expect(d).toMatchObject({ isQuestion: true, type: 'status', projectId: 'pay', via: 'heuristic' })
    expect(classify).not.toHaveBeenCalled()
  })

  it('asks the fast model when the project is unclear, and uses its hint', async () => {
    const { detector, classify } = make('{"is_status_question": true, "project_hint": "benchmarking"}')
    const d = await detector.detect(['Where are we on that thing we discussed last week?'], ['earlier'])
    expect(classify).toHaveBeenCalledOnce()
    expect(d).toMatchObject({ isQuestion: true, projectId: 'bench', via: 'classifier' })
  })

  it('leaves the project to the user when the hint matches nothing', async () => {
    const { detector } = make('{"is_status_question": true, "project_hint": null}')
    const d = await detector.detect(['Any update on the thing with finance?'], [])
    expect(d).toMatchObject({ isQuestion: true, type: 'status' })
    expect(d.projectId).toBeUndefined()
  })

  it('ignores ordinary call talk without asking the LLM', async () => {
    const { detector, classify } = make('{}')
    expect((await detector.detect(['I think we should grab lunch after this meeting today.'], [])).isQuestion).toBe(false)
    expect(classify).not.toHaveBeenCalled()
  })

  it('trusts the classifier saying no', async () => {
    const { detector } = make('{"is_status_question": false, "project_hint": null}')
    expect((await detector.detect(['I will send a status email about it tomorrow morning.'], [])).isQuestion).toBe(false)
  })

  it('needs projects to report on', async () => {
    const { detector, classify } = make('{}', [])
    expect((await detector.detect(["What's the status of PRISM?"], [])).isQuestion).toBe(false)
    expect(classify).not.toHaveBeenCalled()
  })

  it('on classifier timeout, only a cue ending in a question counts', async () => {
    vi.useFakeTimers()
    try {
      const { detector } = make(() => new Promise<string>(() => {}))
      const pending = detector.detect(['Where are we on the finance thing?'], [])
      await vi.advanceTimersByTimeAsync(1600)
      expect(await pending).toMatchObject({ isQuestion: true, via: 'timeout' })
      const quiet = detector.detect(['There are a few blockers I can walk through later'], [])
      await vi.advanceTimersByTimeAsync(1600)
      expect((await quiet).isQuestion).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CopilotService in Work Mode', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  let seq = 0
  const heard = (text: string): TranscriptUpdate => ({ id: `u${++seq}`, source: 'loopback', text, isFinal: true, ts: Date.now() })

  function setup(list: Project[] = [project({ id: 'pay' })]) {
    const settings = mergeSettings(DEFAULT_SETTINGS, { mode: 'work' })
    const llm = new MockLlm()
    const store = { get: (id: string) => list.find((p) => p.id === id) ?? null, list: () => list }
    const classify = vi.fn(async () => '{"is_status_question": true, "project_hint": null}')
    const detector = new WorkDetector({ getProjects: () => list, classify, minWords: () => 6 })
    const answers = new AnswerService({
      provider: llm,
      getSettings: () => settings,
      getProfile: () => ({ ...EMPTY_PROFILE, name: 'Omkar' }),
      getMode: () => 'work',
      projects: store,
      sleep: async () => {}
    })
    const copilot = new CopilotService({
      detector,
      answers,
      getSettings: () => settings,
      getMode: () => 'work',
      projectName: (id) => store.get(id)?.name ?? null,
      captureScreen: async () => ({ data: 'AAAA', mediaType: 'image/jpeg', thumb: 'data:x', width: 1, height: 1 }) as never
    })
    const questions: QuestionDetected[] = []
    const picks: StatusPickRequest[] = []
    copilot.on('question', (q) => questions.push(q))
    copilot.on('pick', (p) => picks.push(p))
    copilot.startSession()
    return { copilot, llm, questions, picks, classify }
  }

  it('writes a spoken status update when someone asks about a known project', async () => {
    const { copilot, llm, questions } = setup()
    llm.push({ tokens: ["We're at risk on the payments migration."] })
    copilot.onUtteranceEnd(heard("Omkar, what's the status of PRISM?"))
    await vi.advanceTimersByTimeAsync(2500)
    expect(questions).toMatchObject([{ type: 'status', project: 'Payments migration' }])
    expect(copilot.list()[0]).toMatchObject({ status: 'done', projectId: 'pay', project: 'Payments migration' })
    expect(llm.requests[0].system[0].text).toContain('status update on "Payments migration"')
    expect(messageText(llm.requests[0].messages[0])).toContain('Them: Omkar, what\'s the status of PRISM?')
    // Work prompts depend on the project, so nothing is pre-warmed.
    expect(llm.prewarms).toHaveLength(0)
  })

  it('asks which project instead of guessing (FR-W9), then answers the pick', async () => {
    const { copilot, llm, questions, picks } = setup()
    copilot.onUtteranceEnd(heard('Where are we on the thing with finance?'))
    await vi.advanceTimersByTimeAsync(2500)
    expect(questions).toHaveLength(0)
    expect(picks).toEqual([{ question: 'Where are we on the thing with finance?', suggestedId: null }])
    expect(copilot.askStatus('pay', picks[0].question)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(questions).toMatchObject([{ type: 'status', question: 'Where are we on the thing with finance?', project: 'Payments migration' }])
    expect(llm.requests[0].system[0].text).toContain('Payments migration')
    expect(copilot.askStatus('gone')).toEqual({ ok: false, error: 'That project no longer exists.' })
  })

  it('answer-now opens the quick-pick with what was said last (FR-W6)', () => {
    const { copilot, picks, questions } = setup()
    copilot.onTranscript({ ...heard('so how is'), isFinal: false })
    expect(copilot.answerNow()).toEqual({ ok: true })
    expect(picks).toEqual([{ question: 'so how is', suggestedId: null }])
    expect(questions).toHaveLength(0)
  })

  it('answers typed questions from the projects they mention, and explains screenshots', async () => {
    const { copilot, llm, questions } = setup([project({ id: 'pay' }), project({ id: 'other', name: 'Hiring plan', aliases: [], notes: 'Two roles open.' })])
    copilot.ask('Who owns the payments migration?')
    await vi.advanceTimersByTimeAsync(10)
    expect(questions[0].type).toBe('work')
    const system = llm.requests[0].system[0].text
    expect(system).toContain('<project_context name="Payments migration">')
    expect(system).not.toContain('<project_context name="Hiring plan">')
    expect(system).toContain('- Hiring plan: At risk')

    await copilot.captureScreen()
    await vi.advanceTimersByTimeAsync(10)
    expect(questions[1]).toMatchObject({ question: WORK_SCREEN_QUESTION, type: 'work' })
    expect(llm.requests[1].system[0].text).toContain('If a screenshot is attached')
  })
})

describe('ProjectCondenser (FR-W4)', () => {
  let dir: string
  let store: ProjectStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'condense-'))
    store = new ProjectStore({ dir })
  })
  afterEach(() => {
    store.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('condenses long notes once, and skips short ones', async () => {
    const complete = vi.fn(async () => '- Condensed state.')
    const condenser = new ProjectCondenser({ store, complete })
    const short = store.save({ name: 'Short', notes: 'tiny' })
    await condenser.run(short.id)
    expect(complete).not.toHaveBeenCalled()

    const long = store.save({ name: 'Long', notes: 'detail '.repeat(150) })
    await condenser.run(long.id)
    expect(complete).toHaveBeenCalledOnce()
    expect(store.get(long.id)).toMatchObject({ summary: '- Condensed state.', context: 'condensed' })
    await condenser.run(long.id)
    expect(complete).toHaveBeenCalledOnce()
  })

  it('drops a summary of notes edited while it was being written', async () => {
    const long = store.save({ name: 'Long', notes: 'detail '.repeat(150) })
    const condenser = new ProjectCondenser({
      store,
      complete: async () => {
        store.save({ id: long.id, name: 'Long', notes: 'other '.repeat(150) })
        return '- Old.'
      }
    })
    await condenser.run(long.id)
    expect(store.get(long.id)).toMatchObject({ summary: '', context: 'pending' })
  })
})

describe('modes and history', () => {
  it('starts fresh installs in Work Mode and keeps existing users in Interview Mode', () => {
    expect(DEFAULT_SETTINGS.mode).toBe('work')
    expect(SettingsSchema.parse(applyLegacyMode({ stt: { model: 'nova-3' } })).mode).toBe('interview')
    expect(SettingsSchema.parse(applyLegacyMode({ mode: 'work' })).mode).toBe('work')
    expect(() => mergeSettings(DEFAULT_SETTINGS, { mode: 'sales' })).toThrow()
  })

  it('saves Work calls as their own kind, with the project of each status answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workhist-'))
    const history = new HistoryService({ dir })
    try {
      const id = history.ensure('work')
      history.saveQa({ id: 'qa-1', question: 'Status of PRISM?', type: 'status', style: 'auto', answer: 'On track.', status: 'done', projectId: 'pay', project: 'Payments migration' })
      history.close()
      expect(history.list()[0]).toMatchObject({ id, kind: 'work', title: 'Status of PRISM?', questionCount: 1 })
      expect(history.get(id)?.qas[0]).toMatchObject({ type: 'status', project: 'Payments migration' })
    } finally {
      history.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
