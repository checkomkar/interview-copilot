import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, activeModels } from '@shared/settings'
import { extractDocumentText, normalize } from '../src/main/services/profile/documentText'
import { ProfileService } from '../src/main/services/profile/ProfileService'
import { MockLlm } from './mockLlm'
import { messageText } from '../src/main/services/llm/LlmProvider'

function setup(dir: string | null = null) {
  const llm = new MockLlm()
  llm.completeText = (req) => (messageText(req.messages[0]).includes('<resume>') ? 'RESUME SUMMARY' : 'JD SUMMARY')
  const svc = new ProfileService({ dir, provider: llm, getSettings: () => DEFAULT_SETTINGS })
  return { svc, llm }
}

describe('ProfileService', () => {
  it('summarizes resume and JD with the fast model on save', async () => {
    const { svc, llm } = setup()
    const { profile, summaryError } = await svc.save({ name: 'Omkar', resumeText: 'Engineer at Acme', jdText: 'Needs React' })
    expect(summaryError).toBeUndefined()
    expect(profile).toMatchObject({ name: 'Omkar', resumeSummary: 'RESUME SUMMARY', jdSummary: 'JD SUMMARY' })
    const { fastModel } = activeModels(DEFAULT_SETTINGS)
    expect(llm.completions.map((r) => r.model)).toEqual([fastModel, fastModel])
  })

  it('does not re-summarize unchanged text', async () => {
    const { svc, llm } = setup()
    await svc.save({ resumeText: 'Engineer at Acme', jdText: 'Needs React' })
    await svc.save({ resumeText: 'Engineer at Acme', jdText: 'Needs React and Node', notes: 'x' })
    expect(llm.completions).toHaveLength(3)
    expect(llm.completions[2].messages[0].content).toContain('Needs React and Node')
  })

  it('clears a summary when its text is removed', async () => {
    const { svc } = setup()
    await svc.save({ resumeText: 'Engineer at Acme' })
    const { profile } = await svc.save({ resumeText: '' })
    expect(profile.resumeSummary).toBe('')
  })

  it('still saves when summarizing fails', async () => {
    const { svc, llm } = setup()
    llm.completeText = () => Promise.reject(new Error('no key'))
    const res = await svc.save({ resumeText: 'Engineer at Acme' })
    expect(res.profile.resumeText).toBe('Engineer at Acme')
    expect(res.profile.resumeSummary).toBe('')
    expect(res.summaryError).toContain('no key')
  })

  it('rejects invalid input', async () => {
    const { svc } = setup()
    await expect(svc.save({ name: 'x'.repeat(500) })).rejects.toThrow()
  })

  it('persists to profile.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profile-'))
    await setup(dir).svc.save({ name: 'Omkar', resumeText: 'Engineer' })
    expect(setup(dir).svc.get()).toMatchObject({ name: 'Omkar', resumeSummary: 'RESUME SUMMARY' })
  })
})

describe('extractDocumentText', () => {
  it('reads text files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'))
    const path = join(dir, 'resume.txt')
    writeFileSync(path, 'Jane Doe\r\n\r\n\r\n\r\nEngineer   \n')
    expect(await extractDocumentText(path)).toEqual({ fileName: 'resume.txt', text: 'Jane Doe\n\nEngineer' })
  })

  it('rejects unsupported and empty files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'))
    writeFileSync(join(dir, 'a.png'), 'x')
    writeFileSync(join(dir, 'b.txt'), '   ')
    await expect(extractDocumentText(join(dir, 'a.png'))).rejects.toThrow(/Unsupported/)
    await expect(extractDocumentText(join(dir, 'b.txt'))).rejects.toThrow(/No text/)
  })

  it('normalizes PDF page markers and blank runs', () => {
    expect(normalize('a\n\n-- 1 of 2 --\n\n\n\nb')).toBe('a\n\nb')
  })
})
