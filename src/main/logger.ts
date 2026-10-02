import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const secrets = new Set<string>()
let logDir: string | null = null

/** Register a secret value so it is redacted from every log line. */
export function registerSecret(value: string): void {
  if (value.length >= 8) secrets.add(value)
}

export function redact(text: string): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('[REDACTED]')
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(Token|Bearer)\s+[A-Za-z0-9._-]{8,}/gi, '$1 [REDACTED]')
}

export function initLogger(userDataDir: string): void {
  logDir = join(userDataDir, 'logs')
  mkdirSync(logDir, { recursive: true })
}

function format(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function write(level: Level, scope: string, args: unknown[]): void {
  const line = redact(`${new Date().toISOString()} [${level}] [${scope}] ${args.map(format).join(' ')}`)
  if (level === 'error') console.error(line)
  else console.log(line)
  if (!logDir) return
  try {
    appendFileSync(join(logDir, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n')
  } catch {
    // Logging must never crash the app.
  }
}

export function createLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => write('debug', scope, a),
    info: (...a: unknown[]) => write('info', scope, a),
    warn: (...a: unknown[]) => write('warn', scope, a),
    error: (...a: unknown[]) => write('error', scope, a)
  }
}
export type Logger = ReturnType<typeof createLogger>
