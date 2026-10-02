// Local stand-in for the parts of the Microsoft identity platform and Microsoft Graph that Cue's
// Teams sync uses (PRD FR-T5), so the enterprise setup can be tried without a Microsoft 365 tenant.
//
//   npm run mock-teams            → http://localhost:4100 (MOCK_TEAMS_PORT to change)
//
// In Cue: Projects → Updates from Teams → Teams sync → "Use the local mock". Sign in, approve the
// code on http://localhost:4100/device, follow a chat, then post messages from http://localhost:4100
// as different people. Also imported by the tests (startMockTeams).
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ME = { id: 'u-omkar', displayName: 'Omkar Kamale', userPrincipalName: 'omkar@contoso.dev' }
const PEOPLE = ['Ravi Kumar', 'Sneha Patil', 'Priya Shah', 'Arjun Mehta', ME.displayName]
const MIN = 60_000

/** Sample chats and a channel, timed relative to `now`. */
function seed(now) {
  const msg = (author, minutesAgo, html, extra = {}) => ({
    id: `m-${randomBytes(6).toString('hex')}`,
    messageType: 'message',
    createdDateTime: new Date(now - minutesAgo * MIN).toISOString(),
    lastModifiedDateTime: new Date(now - minutesAgo * MIN).toISOString(),
    deletedDateTime: null,
    from: { user: { id: author.toLowerCase().replace(/\s+/g, '.'), displayName: author } },
    body: { contentType: 'html', content: html },
    ...extra
  })
  const chats = [
    {
      id: '19:mobile-app-dev@thread.v2',
      topic: 'Mobile app – dev',
      chatType: 'group',
      members: PEOPLE.map((displayName) => ({ displayName })),
      messages: [
        msg('Priya Shah', 600, '<p>Morning all. Reminder: release readiness review on Monday.</p>'),
        msg('Ravi Kumar', 540, '<p>Picked up the <b>Android 14 login crash</b> (BUG-142). Repro is consistent on Pixel 8.</p>'),
        msg('Sneha Patil', 420, '<p>Push notifications (BUG-150): it is the FCM token refresh. Will have a fix tomorrow.</p>'),
        msg('Priya Shah', 300, '<p>Pinged the MDM team again about the UAT device profile — they need the signed release build first.</p>'),
        msg('Arjun Mehta', 200, '<p>New one: app freezes on the payment screen when switching tabs. Logged as BUG-171, I&#39;ll take it.</p>'),
        msg('Ravi Kumar', 90, '<p>Login crash fix is in code review: PR #482.</p>'),
        msg('Sneha Patil', 30, '<p>👍</p>'),
        { ...msg('Priya Shah', 25, ''), messageType: 'systemEventMessage' }
      ]
    },
    {
      id: '19:omkar_ravi@unq.gbl.spaces',
      topic: null,
      chatType: 'oneOnOne',
      members: [{ displayName: ME.displayName }, { displayName: 'Ravi Kumar' }],
      messages: [msg('Ravi Kumar', 120, '<p>FYI the login crash fix needs one more reviewer, can you nudge Arjun?</p>')]
    },
    {
      id: '19:omkar_sneha@unq.gbl.spaces',
      topic: null,
      chatType: 'oneOnOne',
      members: [{ displayName: ME.displayName }, { displayName: 'Sneha Patil' }],
      messages: [msg('Sneha Patil', 400, '<p>Can we move our 1:1 to Thursday?</p>')]
    }
  ]
  const teams = [
    {
      id: 'team-engineering',
      displayName: 'Engineering',
      channels: [
        {
          id: '19:mobile-release@thread.tacv2',
          displayName: 'Mobile release',
          messages: [
            {
              ...msg('Priya Shah', 700, '<p>TOM approvals status thread</p>'),
              replies: [msg('Arjun Mehta', 650, '<p>Architecture and ops have signed the TOM. Security still pending.</p>')]
            }
          ]
        }
      ]
    }
  ]
  return { chats, teams }
}

function stripReplies(m) {
  const { replies: _replies, ...rest } = m
  return rest
}

/**
 * Start the mock. `autoApprove`: device codes are approved at once (tests). `now`: clock for the
 * seeded messages. Returns its URL, a way to post messages, and close().
 */
export async function startMockTeams({ port = 4100, autoApprove = false, now = Date.now } = {}) {
  const data = seed(now())
  const devices = new Map() // device_code -> { userCode, approved, expiresAt }
  const tokens = new Set()
  const refreshTokens = new Set()
  let failNext = null // { status, count }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const graphError = (res, status, code, message) => json(res, status, { error: { code, message } })
  const readBody = (req) =>
    new Promise((resolve) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => resolve(b))
    })
  const issue = () => {
    const access = `mock-at-${randomBytes(12).toString('hex')}`
    const refresh = `mock-rt-${randomBytes(12).toString('hex')}`
    tokens.add(access)
    refreshTokens.add(refresh)
    return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600, scope: 'Chat.Read User.Read' }
  }
  const page = (res, list, url, base) => {
    const top = Math.min(50, Number(url.searchParams.get('$top') ?? 50))
    const skip = Number(url.searchParams.get('$skiptoken') ?? 0)
    const slice = list.slice(skip, skip + top)
    const next = skip + top < list.length ? `${base}${url.pathname}?$top=${top}&$skiptoken=${skip + top}${url.searchParams.has('$orderby') ? `&$orderby=${encodeURIComponent(url.searchParams.get('$orderby'))}` : ''}` : undefined
    json(res, 200, { value: slice, ...(next ? { '@odata.nextLink': next } : {}) })
  }
  const newestFirst = (msgs) => [...msgs].sort((a, b) => Date.parse(b.createdDateTime) - Date.parse(a.createdDateTime))

  let base = ''
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    try {
      // --- identity platform ---
      let m = /^\/([^/]+)\/oauth2\/v2\.0\/devicecode$/.exec(path)
      if (m && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        if (!form.get('client_id')) return json(res, 400, { error: 'invalid_request', error_description: 'AADSTS900144: client_id is missing.' })
        const device = randomBytes(16).toString('hex')
        const userCode = `CUE${Math.floor(1000 + Math.random() * 9000)}`
        devices.set(device, { userCode, approved: autoApprove, expiresAt: Date.now() + 15 * MIN })
        return json(res, 200, {
          device_code: device,
          user_code: userCode,
          verification_uri: `${base}/device`,
          expires_in: 900,
          interval: 1,
          message: `To sign in, open ${base}/device and enter the code ${userCode}.`
        })
      }
      m = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path)
      if (m && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const grant = form.get('grant_type')
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          const d = devices.get(form.get('device_code') ?? '')
          if (!d) return json(res, 400, { error: 'bad_verification_code', error_description: 'Unknown device code.' })
          if (Date.now() > d.expiresAt) return json(res, 400, { error: 'expired_token', error_description: 'The code expired.' })
          if (d.declined) return json(res, 400, { error: 'authorization_declined', error_description: 'The user declined.' })
          if (!d.approved) return json(res, 400, { error: 'authorization_pending', error_description: 'Waiting for the user.' })
          devices.delete(form.get('device_code'))
          return json(res, 200, issue())
        }
        if (grant === 'refresh_token') {
          const rt = form.get('refresh_token') ?? ''
          if (!refreshTokens.has(rt)) return json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70000: refresh token is invalid.' })
          refreshTokens.delete(rt)
          return json(res, 200, issue())
        }
        return json(res, 400, { error: 'unsupported_grant_type' })
      }

      // --- the device sign-in page ---
      if (path === '/device') {
        if (req.method === 'POST') {
          const form = new URLSearchParams(await readBody(req))
          const code = (form.get('code') ?? '').trim().toUpperCase()
          const entry = [...devices.values()].find((d) => d.userCode === code)
          if (entry) entry[form.get('decline') ? 'declined' : 'approved'] = true
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          return res.end(devicePage(entry ? (form.get('decline') ? 'Declined. You can close this tab.' : `Signed in as ${ME.displayName}. You can close this tab and go back to Cue.`) : 'That code was not found — check it and try again.'))
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(devicePage())
      }

      // --- the chat page: post messages as anyone ---
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(chatPage())
      }
      if (path === '/__state') return json(res, 200, { me: ME, people: PEOPLE, chats: data.chats.map((c) => ({ id: c.id, name: c.topic ?? c.members.map((x) => x.displayName).filter((n) => n !== ME.displayName).join(', '), messages: c.messages.filter((x) => x.messageType === 'message').slice(-15) })), channels: data.teams.flatMap((t) => t.channels.map((ch) => ({ id: ch.id, teamId: t.id, name: `${t.displayName} › ${ch.displayName}`, messages: ch.messages.slice(-15) }))) })
      if (path === '/__post' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const posted = post(body)
        return posted ? json(res, 200, posted) : json(res, 400, { error: 'unknown chat or empty text' })
      }
      if (path === '/__fail' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        failNext = { status: Number(body.status ?? 429), count: Number(body.count ?? 1) }
        return json(res, 200, { ok: true })
      }

      // --- Microsoft Graph (v1.0) ---
      if (path.startsWith('/v1.0/')) {
        const auth = req.headers.authorization ?? ''
        if (!tokens.has(auth.replace(/^Bearer\s+/i, ''))) return graphError(res, 401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.')
        if (failNext && failNext.count > 0) {
          failNext.count--
          const { status } = failNext
          if (failNext.count === 0) failNext = null
          return status === 429
            ? json(res, 429, { error: { code: 'TooManyRequests', message: 'Too many requests.' } }, { 'Retry-After': '1' })
            : graphError(res, status, status === 403 ? 'Forbidden' : 'Error', status === 403 ? 'Missing role permissions on the request.' : 'Mock failure.')
        }
        if (path === '/v1.0/me') return json(res, 200, ME)
        if (path === '/v1.0/me/chats') {
          const expand = url.searchParams.get('$expand') === 'members'
          return page(res, data.chats.map(({ messages: _m, members, ...c }) => ({ ...c, lastUpdatedDateTime: new Date().toISOString(), ...(expand ? { members } : {}) })), url, base)
        }
        m = /^\/v1\.0\/chats\/([^/]+)\/messages$/.exec(path)
        if (m) {
          const chat = data.chats.find((c) => c.id === m[1])
          if (!chat) return graphError(res, 404, 'NotFound', 'Chat not found.')
          return page(res, newestFirst(chat.messages), url, base)
        }
        if (path === '/v1.0/me/joinedTeams') return json(res, 200, { value: data.teams.map((t) => ({ id: t.id, displayName: t.displayName })) })
        m = /^\/v1\.0\/teams\/([^/]+)\/channels$/.exec(path)
        if (m) {
          const team = data.teams.find((t) => t.id === m[1])
          return team ? json(res, 200, { value: team.channels.map((c) => ({ id: c.id, displayName: c.displayName })) }) : graphError(res, 404, 'NotFound', 'Team not found.')
        }
        m = /^\/v1\.0\/teams\/([^/]+)\/channels\/([^/]+)\/messages(?:\/([^/]+)\/replies)?$/.exec(path)
        if (m) {
          const channel = data.teams.find((t) => t.id === m[1])?.channels.find((c) => c.id === m[2])
          if (!channel) return graphError(res, 404, 'NotFound', 'Channel not found.')
          if (m[3]) {
            const root = channel.messages.find((x) => x.id === m[3])
            return root ? page(res, newestFirst(root.replies ?? []), url, base) : graphError(res, 404, 'NotFound', 'Message not found.')
          }
          return page(res, newestFirst(channel.messages).map(stripReplies), url, base)
        }
        return graphError(res, 404, 'NotFound', `Mock Graph doesn't implement ${path}.`)
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    } catch (err) {
      json(res, 500, { error: { code: 'InternalServerError', message: String(err) } })
    }
  })

  /** Add a message to a chat (or a reply in a channel thread, with `replyTo`). */
  function post({ chatId, author, text, replyTo }) {
    if (!text?.trim()) return null
    const at = new Date().toISOString()
    const message = {
      id: `m-${randomBytes(6).toString('hex')}`,
      messageType: 'message',
      createdDateTime: at,
      lastModifiedDateTime: at,
      deletedDateTime: null,
      from: { user: { displayName: author || PEOPLE[0] } },
      body: { contentType: 'html', content: `<p>${escapeHtml(text.trim()).replace(/\n/g, '<br>')}</p>` }
    }
    const chat = data.chats.find((c) => c.id === chatId)
    if (chat) {
      chat.messages.push(message)
      return message
    }
    for (const t of data.teams)
      for (const ch of t.channels) {
        if (ch.id !== chatId) continue
        const root = replyTo ? ch.messages.find((x) => x.id === replyTo) : null
        if (root) {
          root.replies = [...(root.replies ?? []), message]
          root.lastModifiedDateTime = at
        } else ch.messages.push({ ...message, replies: [] })
        return message
      }
    return null
  }

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  base = `http://localhost:${server.address().port}`
  return {
    url: base,
    post,
    data,
    /** Approve every pending device code (what the user does on /device). */
    approveAll: () => devices.forEach((d) => (d.approved = true)),
    failNext: (status, count = 1) => (failNext = { status, count }),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const STYLE = `<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#e8eaed;--muted:#9aa0aa;--accent:#7aa2ff}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--line:#dde1e7;--fg:#15181d;--muted:#5d6470;--accent:#3557d6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:18px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
label{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}select,input,textarea,button{font:inherit;color:inherit}
select,input,textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer;margin-top:12px}
.row{display:flex;gap:12px}.row>div{flex:1;min-width:0}ol{list-style:none;padding:0;margin:0}li{padding:8px 0;border-bottom:1px solid var(--line)}
li:last-child{border:0}.who{font-weight:600}.when{color:var(--muted);font-size:12px;margin-left:6px}.code{font:600 28px ui-monospace,monospace;letter-spacing:4px}
</style>`

function devicePage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock sign-in</title>${STYLE}</head>
<body><main><h1>Sign in (local mock)</h1><p class="sub">Stands in for microsoft.com/devicelogin. Enter the code Cue shows.</p>
<div class="card">${message ? `<p>${escapeHtml(message)}</p>` : `<form method="post"><label for="code">Code</label><input id="code" name="code" autofocus autocomplete="off" placeholder="CUE1234">
<button type="submit">Sign in as ${escapeHtml(ME.displayName)}</button> <button type="submit" name="decline" value="1" style="background:transparent;color:var(--muted)">Decline</button></form>`}</div></main></body></html>`
}

function chatPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Teams</title>${STYLE}</head>
<body><main><h1>Mock Teams</h1><p class="sub">Post messages as anyone; Cue's Teams sync reads them through the mock Microsoft Graph on its next check (or "Sync now").</p>
<div class="card"><div class="row"><div><label for="chat">Chat or channel</label><select id="chat"></select></div><div><label for="who">Posting as</label><select id="who"></select></div></div>
<label for="text">Message</label><textarea id="text" rows="3" placeholder="Fixed the push notification bug, merged to main"></textarea><button id="send">Send</button></div>
<div class="card"><ol id="log"></ol></div></main>
<script>
const $ = (id) => document.getElementById(id)
let state
async function load(keep) {
  state = await (await fetch('/__state')).json()
  if (!keep) {
    $('who').innerHTML = state.people.map((p) => '<option>' + p + '</option>').join('')
    $('chat').innerHTML = [...state.chats.map((c) => '<option value="' + c.id + '">' + c.name + '</option>'), ...state.channels.map((c) => '<option value="' + c.id + '">' + c.name + '</option>')].join('')
  }
  const all = [...state.chats, ...state.channels].find((c) => c.id === $('chat').value)
  $('log').innerHTML = (all ? all.messages : []).map((m) => '<li><span class="who">' + m.from.user.displayName + '</span><span class="when">' + new Date(m.createdDateTime).toLocaleString() + '</span><div>' + m.body.content + '</div></li>').join('') || '<li>No messages.</li>'
}
$('chat').onchange = () => load(true)
$('send').onclick = async () => {
  const text = $('text').value.trim()
  if (!text) return
  await fetch('/__post', { method: 'POST', body: JSON.stringify({ chatId: $('chat').value, author: $('who').value, text }) })
  $('text').value = ''
  load(true)
}
load(false)
</script></body></html>`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_TEAMS_PORT ?? 4100)
  const mock = await startMockTeams({ port })
  console.log(`Mock Teams running at ${mock.url}
  In Cue: Projects → Updates from Teams → Teams sync → "Use the local mock"
    (app ID: anything, e.g. mock-client; sign-in: ${mock.url}; Graph: ${mock.url})
  Sign-in page: ${mock.url}/device   ·   Post messages: ${mock.url}
Ctrl+C to stop.`)
}
