// End-to-end OIDC login flow test: browser-like simulation
// dsh gate -> dex (authorize) -> login form -> callback -> cookie -> gated API
const BASE = process.env.DSH_URL ?? 'https://dsh.svc.visecy.top'
const USER = process.env.TEST_USER ?? 'admin@test.local'
const PASS = process.env.TEST_PASS ?? 'test-password'

const cookieJar = new Map()
function storeCookies(headers) {
  const sc = headers.getSetCookie?.() ?? []
  for (const c of sc) {
    const [pair] = c.split(';')
    const [k, ...v] = pair.trim().split('=')
    cookieJar.set(k, v.join('='))
  }
}
function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => k + '=' + v).join('; ')
}

async function get(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { ...(opts.headers ?? {}), cookie: cookieHeader() },
  })
  storeCookies(res.headers)
  return res
}

let step = 0
const ok = (name, cond, extra = '') => {
  step++
  if (!cond) {
    console.error('FAIL', step, name, extra)
    process.exitCode = 1
  } else {
    console.log('PASS', step, name, extra)
  }
}

// 1. unauthenticated /
const r1 = await get(BASE + '/')
ok('unauthenticated / -> 302 to dex', r1.status === 302, '-> ' + (r1.headers.get('location') ?? '').slice(0, 100))
const authorizeUrl = r1.headers.get('location')

// 2. authorize -> login form
const r2 = await get(authorizeUrl)
ok('authorize -> 302 to login form', r2.status === 302, '-> ' + (r2.headers.get('location') ?? '').slice(0, 80))
const loginUrl = new URL(r2.headers.get('location') ?? '/', authorizeUrl).toString()

// 3. fetch login form (follow dex internal redirects)
let r3 = await get(loginUrl)
for (let i = 0; i < 3 && (r3.status === 302 || r3.status === 303) && r3.headers.get('location'); i++) {
  const loc = new URL(r3.headers.get('location'), loginUrl).toString()
  r3 = await get(loc)
}
const html = await r3.text()
ok('login form html', r3.status === 200 && html.includes('<form'), 'status ' + r3.status)
const actionMatch = html.match(/action="([^"]+)"/)
const actionHref = actionMatch ? actionMatch[1].replace(/&amp;/g, '&') : null
const loginField = html.match(/name="login"/)
ok('form action + login field', actionHref !== null && loginField !== null)

// 4. POST credentials
const postUrl = new URL(actionHref, loginUrl)
const r4 = await fetch(postUrl.toString(), {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
  body: new URLSearchParams({ login: USER, password: PASS }).toString(),
  signal: AbortSignal.timeout(10000),
})
storeCookies(r4.headers)
ok('login POST -> 302/303 back to app', r4.status === 302 || r4.status === 303, '-> ' + (r4.headers.get('location') ?? '').slice(0, 120))
const callbackUrl = r4.headers.get('location')

// 5. callback -> session cookie
const r5 = await get(callbackUrl)
ok('callback -> 302 + session cookie', r5.status === 302 && cookieJar.has('dsh_session'), 'status ' + r5.status)

// 6. gated API with cookie (expect non-401: proxied through to dsh web)
const r6 = await get(BASE + '/api/session')
ok('gated /api/session with cookie -> not 401', r6.status !== 401, 'status ' + r6.status)

// 7. unauthenticated /api still rejected
const r7 = await fetch(BASE + '/api/session', { redirect: 'manual', signal: AbortSignal.timeout(10000) })
ok('fresh client /api/session -> 401', r7.status === 401, 'status ' + r7.status)

console.log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: ALL PASSED')
