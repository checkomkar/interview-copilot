import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDataDir } from '../src/main/dataDir'

const appData = () => mkdtempSync(join(tmpdir(), 'cue-appdata-'))

describe('resolveDataDir', () => {
  it('uses the override as is', () => {
    expect(resolveDataDir(appData(), 'D:/x/Cue')).toEqual({ dir: 'D:/x/Cue', migration: 'none' })
  })

  it('uses %APPDATA%/Cue on a fresh install', () => {
    const root = appData()
    expect(resolveDataDir(root)).toEqual({ dir: join(root, 'Cue'), migration: 'none' })
  })

  it('moves the pre-rename InterviewCopilot folder once', () => {
    const root = appData()
    mkdirSync(join(root, 'InterviewCopilot'))
    writeFileSync(join(root, 'InterviewCopilot', 'profile.json'), '{"name":"A"}')
    expect(resolveDataDir(root)).toEqual({ dir: join(root, 'Cue'), migration: 'moved' })
    expect(existsSync(join(root, 'InterviewCopilot'))).toBe(false)
    expect(readFileSync(join(root, 'Cue', 'profile.json'), 'utf8')).toBe('{"name":"A"}')
    expect(resolveDataDir(root).migration).toBe('none')
  })

  it('leaves the old folder alone when Cue already exists', () => {
    const root = appData()
    mkdirSync(join(root, 'InterviewCopilot'))
    mkdirSync(join(root, 'Cue'))
    expect(resolveDataDir(root)).toEqual({ dir: join(root, 'Cue'), migration: 'none' })
    expect(existsSync(join(root, 'InterviewCopilot'))).toBe(true)
  })
})
