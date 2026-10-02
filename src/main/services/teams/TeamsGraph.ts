import type { TeamsSource } from '@shared/work'
import { createLogger } from '../../logger'
import type { ChatMessage } from '../work/teamsImport'

const log = createLogger('teams')

/** Chats only need the user's consent; channels need an admin to approve ChannelMessage.Read.All. */
const CHAT_SCOPES = ['offline_access', 'User.Read', 'Chat.Read']
const CHANNEL_SCOPES = ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All']
/** Refresh a little before the access token runs out. */
const EXPIRY_MARGIN_MS = 120_000
/** Pages of 50 messages read per chat per sync, at most. */
const MAX_PAGES = 5

export interface TeamsConfig {
  clientId: string
  tenant: string
  authorityUrl: string
  graphBaseUrl: string
  includeChannels: boolean
}

export interface DeviceCode {
  userCode: string
  verificationUri: string
  deviceCode: string
  intervalMs: number
  expiresAt: number
}

export class TeamsError extends Error {
  constructor(
    message: string,
    /** `auth`: signed out or sign-in failed; `forbidden`: the organisation doesn't allow it; `rate`: throttled. */
    readonly kind: 'auth' | 'forbidden' | 'rate' | 'network' | 'other',
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'TeamsError'
  }
}

export interface TeamsGraphDeps {
  getConfig: () => TeamsConfig
  /** The refresh token, kept encrypted by the caller. */
  getRefreshToken: () => string | null
  setRefreshToken: (token: string | null) => void
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/**
 * Microsoft identity platform (device-code sign-in, refresh) and the few Microsoft Graph calls
 * Teams sync needs (FR-T3). Works the same against the real services and the local mock
 * (`npm run mock-teams`), which differ only in their base URLs.
 */
export class TeamsGraph {
  private access: { token: string; expiresAt: number } | null = null
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: TeamsGraphDeps) {
    this.fetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = deps.now ?? Date.now
  }

  scopes(): string {
    return [...CHAT_SCOPES, ...(this.deps.getConfig().includeChannels ? CHANNEL_SCOPES : [])].join(' ')
  }

  isSignedIn(): boolean {
    return Boolean(this.deps.getRefreshToken())
  }

  signOut(): void {
    this.access = null
    this.deps.setRefreshToken(null)
  }

  /** Step 1 of device-code sign-in: a code for the user to enter at the sign-in page. */
  async startSignIn(): Promise<DeviceCode> {
    const c = this.config()
    const res = await this.post(`${c.authorityUrl}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/devicecode`, { client_id: c.clientId, scope: this.scopes() })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || typeof body.device_code !== 'string') {
      throw new TeamsError(`Sign-in couldn't start: ${describe(body)}`, 'auth')
    }
    return {
      userCode: String(body.user_code),
      verificationUri: String(body.verification_uri ?? body.verification_url),
      deviceCode: body.device_code,
      intervalMs: Math.max(1, Number(body.interval ?? 5)) * 1000,
      expiresAt: this.now() + Number(body.expires_in ?? 900) * 1000
    }
  }

  /** Step 2: wait while the user signs in; resolves once they have, throws if they don't. */
  async finishSignIn(code: DeviceCode, signal?: AbortSignal): Promise<void> {
    const c = this.config()
    let interval = code.intervalMs
    const sleep = this.deps.sleep ?? abortableSleep
    while (this.now() < code.expiresAt) {
      await sleep(interval, signal)
      const res = await this.post(`${c.authorityUrl}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: c.clientId,
        device_code: code.deviceCode
      })
      const body = (await res.json().catch(() => ({}))) as TokenResponse
      if (res.ok && body.access_token) return this.keep(body)
      if (body.error === 'authorization_pending') continue
      if (body.error === 'slow_down') {
        interval += 5000
        continue
      }
      if (body.error === 'authorization_declined') throw new TeamsError('Sign-in was declined.', 'auth')
      if (body.error === 'expired_token') break
      throw new TeamsError(`Sign-in failed: ${describe(body)}`, 'auth')
    }
    throw new TeamsError('The sign-in code expired — start again.', 'auth')
  }

  async me(): Promise<{ displayName: string; userPrincipalName: string }> {
    const me = await this.get<{ displayName?: string; userPrincipalName?: string; mail?: string }>('/v1.0/me')
    return { displayName: me.displayName ?? '', userPrincipalName: me.userPrincipalName ?? me.mail ?? '' }
  }

  /** Chats (group, one-on-one, meeting) and, if allowed, team channels the user can follow. */
  async listSources(): Promise<TeamsSource[]> {
    const chats = await this.get<{ value: GraphChat[] }>('/v1.0/me/chats?$expand=members&$top=50')
    const me = await this.me().catch(() => null)
    const out: TeamsSource[] = chats.value.map((c) => ({ kind: 'chat', id: c.id, teamId: null, name: chatName(c, me?.displayName ?? '') }))
    if (this.deps.getConfig().includeChannels) {
      const teams = await this.get<{ value: { id: string; displayName: string }[] }>('/v1.0/me/joinedTeams')
      for (const t of teams.value) {
        const channels = await this.get<{ value: { id: string; displayName: string }[] }>(`/v1.0/teams/${enc(t.id)}/channels`)
        for (const ch of channels.value) out.push({ kind: 'channel', id: ch.id, teamId: t.id, name: `${t.displayName} › ${ch.displayName}` })
      }
    }
    return out
  }

  /** Messages posted in a chat or channel after `since` (ms), oldest first. Channel replies included. */
  async messagesSince(source: TeamsSource, since: number): Promise<ChatMessage[]> {
    const out: GraphMessage[] = []
    if (source.kind === 'chat') {
      let url: string | null = `/v1.0/chats/${enc(source.id)}/messages?$top=50&$orderby=createdDateTime desc`
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const res: GraphPage<GraphMessage> = await this.get<GraphPage<GraphMessage>>(url)
        out.push(...res.value)
        // Newest first: stop once a page reaches messages already read.
        if (res.value.some((m) => Date.parse(m.createdDateTime) <= since)) break
        url = res['@odata.nextLink'] ?? null
      }
    } else {
      if (!source.teamId) return []
      const base = `/v1.0/teams/${enc(source.teamId)}/channels/${enc(source.id)}/messages`
      const roots = await this.get<GraphPage<GraphMessage>>(`${base}?$top=50`)
      for (const root of roots.value) {
        out.push(root)
        const touched = Date.parse(root.lastModifiedDateTime ?? root.createdDateTime)
        if (touched > since) out.push(...(await this.get<GraphPage<GraphMessage>>(`${base}/${enc(root.id)}/replies?$top=50`)).value)
      }
    }
    return out
      .filter((m) => m.messageType === 'message' && !m.deletedDateTime && Date.parse(m.createdDateTime) > since)
      .map((m) => ({ author: m.from?.user?.displayName ?? m.from?.application?.displayName ?? 'Someone', ts: Date.parse(m.createdDateTime), text: htmlToText(m.body?.content ?? '', m.body?.contentType), chat: source.name }))
      .filter((m) => m.text)
      .sort((a, b) => a.ts - b.ts)
  }

  /** GET a Graph path (or a full nextLink URL), refreshing the token once on 401. */
  private async get<T>(path: string): Promise<T> {
    const c = this.config()
    const url = /^https?:/i.test(path) ? path : `${c.graphBaseUrl}${path}`
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken()
      let res: Response
      try {
        res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
      } catch (err) {
        throw new TeamsError(`Couldn't reach Microsoft Graph: ${err instanceof Error ? err.message : String(err)}`, 'network')
      }
      if (res.status === 401 && attempt === 0) {
        this.access = null
        continue
      }
      if (res.ok) return (await res.json()) as T
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
      const why = body.error?.message ?? res.statusText
      if (res.status === 401) throw new TeamsError('Teams sign-in expired — sign in again.', 'auth')
      if (res.status === 403) throw new TeamsError(`Your organisation hasn't allowed this (${why}). Chats need Chat.Read; channels need an admin to approve ChannelMessage.Read.All.`, 'forbidden')
      if (res.status === 429) throw new TeamsError('Microsoft Graph is throttling requests; trying again later.', 'rate', Number(res.headers.get('retry-after') ?? 60) * 1000)
      throw new TeamsError(`Microsoft Graph error ${res.status}: ${why}`, 'other')
    }
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.access.token
    const refresh = this.deps.getRefreshToken()
    if (!refresh) throw new TeamsError('Not signed in to Teams.', 'auth')
    const c = this.config()
    const res = await this.post(`${c.authorityUrl}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: refresh,
      scope: this.scopes()
    })
    const body = (await res.json().catch(() => ({}))) as TokenResponse
    if (!res.ok || !body.access_token) {
      log.warn(`token refresh failed: ${describe(body)}`)
      if (body.error === 'invalid_grant' || body.error === 'interaction_required') this.signOut()
      throw new TeamsError('Teams sign-in expired — sign in again.', 'auth')
    }
    this.keep(body)
    return body.access_token
  }

  private keep(body: TokenResponse): void {
    this.access = { token: body.access_token!, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 }
    if (body.refresh_token) this.deps.setRefreshToken(body.refresh_token)
  }

  private config(): TeamsConfig {
    const c = this.deps.getConfig()
    if (!c.clientId.trim()) throw new TeamsError('Set the app (client) ID first (see the Teams sync setup steps).', 'auth')
    return { ...c, authorityUrl: c.authorityUrl.replace(/\/+$/, ''), graphBaseUrl: c.graphBaseUrl.replace(/\/+$/, '') }
  }

  private async post(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
    } catch (err) {
      throw new TeamsError(`Couldn't reach the sign-in service: ${err instanceof Error ? err.message : String(err)}`, 'network')
    }
  }
}

interface GraphPage<T> {
  value: T[]
  '@odata.nextLink'?: string
}

interface GraphChat {
  id: string
  topic: string | null
  chatType: string
  members?: { displayName?: string | null }[]
}

interface GraphMessage {
  id: string
  messageType: string
  createdDateTime: string
  lastModifiedDateTime?: string
  deletedDateTime?: string | null
  from?: { user?: { displayName?: string } | null; application?: { displayName?: string } | null } | null
  body?: { contentType?: string; content?: string }
}

function enc(id: string): string {
  return encodeURIComponent(id)
}

/** A chat's topic, or the other people in it ("Ravi Kumar" for a one-on-one). */
function chatName(c: GraphChat, me: string): string {
  if (c.topic?.trim()) return c.topic.trim()
  const others = (c.members ?? []).map((m) => m.displayName ?? '').filter((n) => n && n !== me)
  return others.length ? others.join(', ') : c.chatType === 'oneOnOne' ? 'Private chat' : 'Group chat'
}

/** Teams message bodies are HTML: keep the text and line breaks. */
export function htmlToText(html: string, contentType?: string): string {
  if (contentType !== 'html') return html.trim()
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<at[^>]*>(.*?)<\/at>/gi, '@$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function describe(body: Record<string, unknown> | TokenResponse): string {
  const b = body as Record<string, unknown>
  return String(b.error_description ?? b.error ?? 'no details').split('\r\n')[0].slice(0, 300)
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TeamsError('Sign-in canceled.', 'auth'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new TeamsError('Sign-in canceled.', 'auth'))
    })
  })
}
