import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  API_KEY_PROVIDERS,
  DEFAULT_SETTINGS,
  SettingsSchema,
  mergeSettings,
  upgradeSettings,
  type ApiKeyProvider,
  type ApiKeyStatus,
  type Settings
} from '@shared/settings'
import { createLogger, registerSecret } from '../logger'

const log = createLogger('settings')

/**
 * Non-secret settings live in settings.json. API keys are encrypted with
 * Electron safeStorage (DPAPI on Windows) and stored base64 in secrets.json.
 * Plaintext keys only ever exist in main-process memory.
 */
export class SettingsStore extends EventEmitter {
  private settings: Settings
  private readonly settingsPath: string
  private readonly secretsPath: string
  private encryptedKeys: Partial<Record<ApiKeyProvider, string>> = {}

  constructor(dir: string) {
    super()
    this.settingsPath = join(dir, 'settings.json')
    this.secretsPath = join(dir, 'secrets.json')
    this.settings = this.loadSettings()
    const upgraded = upgradeSettings(this.settings)
    if (upgraded) {
      this.settings = upgraded
      atomicWrite(this.settingsPath, JSON.stringify(this.settings, null, 2))
      log.info('upgraded OpenRouter free models to the fallback-chain preset')
    }
    this.encryptedKeys = this.loadSecrets()
    for (const p of API_KEY_PROVIDERS) {
      const k = this.getApiKey(p)
      if (k) registerSecret(k)
    }
  }

  get(): Settings {
    return this.settings
  }

  /** Apply a deep-partial patch. Throws a ZodError if the result is invalid. */
  update(patch: unknown): Settings {
    this.settings = mergeSettings(this.settings, patch)
    atomicWrite(this.settingsPath, JSON.stringify(this.settings, null, 2))
    this.emit('changed', this.settings)
    return this.settings
  }

  getApiKey(provider: ApiKeyProvider): string | null {
    const enc = this.encryptedKeys[provider]
    if (!enc) return null
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch (err) {
      log.error(`failed to decrypt ${provider} key`, err)
      return null
    }
  }

  /** Empty string clears the key. */
  setApiKey(provider: ApiKeyProvider, key: string): void {
    const trimmed = key.trim()
    if (!trimmed) {
      delete this.encryptedKeys[provider]
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS encryption is unavailable; refusing to store API key')
      }
      registerSecret(trimmed)
      this.encryptedKeys[provider] = safeStorage.encryptString(trimmed).toString('base64')
    }
    atomicWrite(this.secretsPath, JSON.stringify(this.encryptedKeys, null, 2))
    log.info(`${provider} API key ${trimmed ? 'updated' : 'cleared'}`)
  }

  apiKeyStatus(): ApiKeyStatus {
    return Object.fromEntries(API_KEY_PROVIDERS.map((p) => [p, Boolean(this.encryptedKeys[p])])) as ApiKeyStatus
  }

  private loadSettings(): Settings {
    if (!existsSync(this.settingsPath)) return DEFAULT_SETTINGS
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      const parsed = SettingsSchema.safeParse(raw)
      if (parsed.success) return parsed.data
      log.warn('settings.json invalid, merging valid parts over defaults', parsed.error.issues)
      return mergeSettingsLenient(raw)
    } catch (err) {
      log.error('could not read settings.json, using defaults', err)
      return DEFAULT_SETTINGS
    }
  }

  private loadSecrets(): Partial<Record<ApiKeyProvider, string>> {
    if (!existsSync(this.secretsPath)) return {}
    try {
      const raw = JSON.parse(readFileSync(this.secretsPath, 'utf8')) as Record<string, unknown>
      const out: Partial<Record<ApiKeyProvider, string>> = {}
      for (const p of API_KEY_PROVIDERS) if (typeof raw[p] === 'string') out[p] = raw[p] as string
      return out
    } catch (err) {
      log.error('could not read secrets.json', err)
      return {}
    }
  }
}

/** Keep each top-level section that validates on its own; reset the rest to defaults. */
function mergeSettingsLenient(raw: unknown): Settings {
  let result = DEFAULT_SETTINGS
  if (typeof raw !== 'object' || raw === null) return result
  for (const [k, v] of Object.entries(raw)) {
    try {
      result = mergeSettings(result, { [k]: v })
    } catch {
      // drop invalid section
    }
  }
  return result
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, path)
}
