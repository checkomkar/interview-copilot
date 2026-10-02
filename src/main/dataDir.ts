import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const DATA_DIR_NAME = 'Cue'
/** The folder used before the app was renamed from Interview Copilot to Cue. */
export const LEGACY_DATA_DIR_NAME = 'InterviewCopilot'

export interface DataDir {
  dir: string
  /** What happened to a pre-rename data folder, for the log. */
  migration: 'none' | 'moved' | 'kept-legacy'
  error?: string
}

/**
 * Where the app keeps its data (FR-D1): `override` (CUE_DATA, for isolated test runs), else
 * %APPDATA%/Cue. A pre-rename %APPDATA%/InterviewCopilot folder is moved there once; if it can't
 * be moved (e.g. an old copy of the app still has it open), it keeps being used so nothing is lost.
 */
export function resolveDataDir(appData: string, override?: string): DataDir {
  if (override) return { dir: override, migration: 'none' }
  const dir = join(appData, DATA_DIR_NAME)
  const legacy = join(appData, LEGACY_DATA_DIR_NAME)
  if (existsSync(dir) || !existsSync(legacy)) return { dir, migration: 'none' }
  try {
    renameSync(legacy, dir)
    return { dir, migration: 'moved' }
  } catch (err) {
    return { dir: legacy, migration: 'kept-legacy', error: (err as Error).message }
  }
}
