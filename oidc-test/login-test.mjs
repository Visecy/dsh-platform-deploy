// End-to-end OIDC login flow test for the dsh-control-plane rig.
//
// Browser-less simulation of the full sidecar login chain. Two modes:
//   * root mode   (DSH_PREFIX empty) -- the pre-P2 behaviour, kept as regression
//   * subpath mode (DSH_PREFIX=/dsh)  -- the P2 release gate (risk B7/R1):
//     does oauth2-proxy lose the mount prefix after login, and does the full
//     redirect chain 302(IdP) -> login -> callback -> [B7 rd] -> 301(M1) ->
//     DSH 302(/<prefix>/?token=) -> 303(./ + dsh-auth cookie) -> 200 work under
//     https://<host>/<prefix>/ ?
//
// Everything runs with redirect:manual and an explicit cookie jar so every hop
// (status, Location, Set-Cookie) is recorded and printed as the redirect table
// that B7's verdict rests on. "It finally opens" is NOT evidence by itself.
//
// The script exits non-zero on any failed assertion (the pod then terminates
// Failed, and its log carries the PASS/FAIL matrix). It also drives the dex
// approval screen: current oauth2-proxy (v7.15.5) sends approval_prompt=force,
// so dex shows "Grant Access" even with skipApprovalScreen=true -- a real
// browser clicks it, and so does this script.
//
// Env:
//   DSH_URL      base origin, default https://dsh.svc.example.test
//   DSH_PREFIX   mount prefix without trailing slash (e.g. /dsh); empty = root
//   TEST_USER    dex static user (default admin@test.local)
//   TEST_PASS    dex static password (default test-password)
//   SIDECAR_URL  optional in-cluster sidecar base URL (no path) used for the
//                untrusted-Host fence control, e.g.
//                http://dsh-control-plane.dsh-platform.svc.cluster.local:4180
//   SKIP_APP     "1" stops after the sidecar login (no DSH handoff/assets)
import http from 'node:http'
import https from 'node:https'

const BASE = (process.env.DSH_URL ?? 'https://dsh.svc.example.test').replace(/\/+$/, '')
const PREFIX = (process.env.DSH_PREFIX ?? '').trim().replace(/\/+$/, '')
const USER = process.env.TEST_USER ?? 'admin@test.local'
const PASS = process.env.TEST_PASS ?? 'test-password'
const SIDECAR_URL = (process.env.SIDECAR_URL ?? '').replace(/\/+$/, '')
const SKIP_APP = process.env.SKIP_APP === '1'
const IS_PREFIX = PREFIX !== ''
const ROOT = BASE + PREFIX
const ENTRY = ROOT + '/'
// what the sidecar session cookie must be narrowed to: /<prefix>/ or /
const EXPECTED_COOKIE_PATH = IS_PREFIX ? PREFIX + '/' : '/'
// root/bare-prefix fallback target (M1): <root>/
const EXPECTED_LANDING_PATH = PREFIX + '/'

// ── evidence ────────────────────────────────────────────────────────────────
const chain = []
const results = []
let step = 0
function ok(name, cond, extra = '') {
  step++
  results.push({ step, name, pass: !!cond, extra: String(extra) })
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + step + ' ' + name + (extra ? '  [' + extra + ']' : ''))
}
function note(msg) { console.log('NOTE ' + msg) }
function pathOf(u, base) { try { return new URL(u, base ?? ENTRY).pathname } catch { return '<unparseable:' + u + '>' } }
function originOf(u, base) { try { return new URL(u, base ?? ENTRY).origin } catch { return '' } }

// ── cookie jar (path-aware, enough for this host-only flow) ─────────────────
const jar = [] // {name, value, path}
function cookiePathMatches(cookiePath, requestPath) {
  if (cookiePath === '/') return true
  if (requestPath === cookiePath) return true
  const p = cookiePath.endsWith('/') ? cookiePath : cookiePath + '/'
  return requestPath.startsWith(p)
}
function cookieHeaderFor(url) {
  const requestPath = new URL(url).pathname
  return jar.filter((c) => cookiePathMatches(c.path, requestPath)).map((c) => c.name + '=' + c.value).join('; ')
}
function storeCookies(setCookies) {
  for (const raw of setCookies) {
    const [pair, ...attrs] = raw.split(';').map((s) => s.trim())
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    let path = '/'
    let removed = false
    for (const a of attrs) {
      const [k, ...rest] = a.split('=')
      const v = rest.join('=')
      if (/^path$/i.test(k)) path = v || '/'
      if (/^max-age$/i.test(k) && v === '0') removed = true
      if (/^expires$/i.test(k) && Date.parse(v) < Date.now()) removed = true
    }
    const idx = jar.findIndex((c) => c.name === name && c.path === path)
    if (removed || value === '') { if (idx >= 0) jar.splice(idx, 1); continue }
    if (idx >= 0) jar[idx].value = value
    else jar.push({ name, value, path })
  }
}

// ── raw request + redirect-table recorder ───────────────────────────────────
async function request(method, url, { headers = {}, body = null, label = '' } = {}) {
  const h = { ...headers }
  const cookie = cookieHeaderFor(url)
  if (cookie && !('cookie' in h)) h.cookie = cookie
  if (body !== null) h['content-type'] = 'application/x-www-form-urlencoded'
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: h,
    body,
    signal: AbortSignal.timeout(30000),
  })
  const setCookies = res.headers.getSetCookie?.() ?? []
  storeCookies(setCookies)
  chain.push({
    n: chain.length + 1,
    request: method + ' ' + url,
    status: res.status,
    location: res.headers.get('location'),
    setCookie: setCookies,
    label,
  })
  const loc = res.headers.get('location')
  console.log(
    'HOP ' + chain.length + ' ' + method + ' ' + url + ' -> ' + res.status +
    (loc ? ' Location: ' + loc : '') +
    (setCookies.length ? ' Set-Cookie: ' + setCookies.map((c) => c.split(';')[0].split('=')[0] + '[' + (c.match(/;\s*Path=([^;]+)/i)?.[1] ?? '/') + ']').join(',') : '')
  )
  return res
}
async function text(res) { return await res.text() }

// ── step 1: canonical entry, unauthenticated ───────────────────────────────
console.log('=== mode: ' + (IS_PREFIX ? 'SUBPATH ' + PREFIX : 'ROOT') + ' base=' + BASE + ' entry=' + ENTRY + ' ===')
const r1 = await request('GET', ENTRY, { label: 'entry, unauthenticated' })
const loc1 = r1.headers.get('location')
const dexOrigin = loc1 ? originOf(loc1) : (process.env.TEST_IDP ?? '')
ok('1 unauthenticated GET ' + ENTRY + ' -> 302 to IdP', r1.status === 302 && !!loc1, 'status=' + r1.status + ' loc=' + (loc1 ?? '').slice(0, 90))
// the callback registered at the IdP must live under the mount prefix
let redirectUriParam = ''
try { redirectUriParam = new URL(loc1).searchParams.get('redirect_uri') ?? '' } catch {}
ok('2 IdP request carries redirect_uri under the mount', pathOf(redirectUriParam) === PREFIX + '/oauth2/callback', 'redirect_uri=' + redirectUriParam)

// ── step 2: M1 root/bare-prefix 301 (subpath only) ─────────────────────────
let b7M1 = { root: null, bare: null }
if (IS_PREFIX) {
  const rr = await request('GET', BASE + '/', { label: 'M1: host root' })
  b7M1.root = { status: rr.status, location: rr.headers.get('location'), path: pathOf(rr.headers.get('location') ?? '', BASE) }
  ok('3 M1 GET ' + BASE + '/ -> 301 ' + ENTRY, rr.status === 301 && b7M1.root.path === EXPECTED_LANDING_PATH, 'status=' + rr.status + ' path=' + b7M1.root.path)
  const rb = await request('GET', ROOT, { label: 'M1: bare prefix' })
  b7M1.bare = { status: rb.status, location: rb.headers.get('location'), path: pathOf(rb.headers.get('location') ?? '', BASE) }
  ok('4 M1 GET ' + ROOT + ' -> 301 ' + ENTRY, rb.status === 301 && b7M1.bare.path === EXPECTED_LANDING_PATH, 'status=' + rb.status + ' path=' + b7M1.bare.path)
} else {
  // Root mode: "/" is the canonical entry, already asserted above. Probe it once
  // more in a throwaway cookie context (the sidecar rotates its CSRF cookie on
  // every unauthenticated request; leaking that rotation into the live flow
  // would make the callback fail with "CSRF token mismatch" for test reasons).
  const savedJar = jar.map((c) => ({ ...c }))
  const rr = await request('GET', BASE + '/', { label: 'root canonical / (throwaway cookie context)' })
  jar.length = 0
  for (const c of savedJar) jar.push(c)
  ok('3 root mode GET / -> 302 to IdP (no prefix redirect)', rr.status === 302 && originOf(rr.headers.get('location') ?? '') === dexOrigin, 'status=' + rr.status)
}

// ── step 3: dex authorize -> login form ────────────────────────────────────
const r2 = await request('GET', loc1, { label: 'dex authorize' })
ok('5 dex authorize -> 302 login', r2.status === 302 && !!r2.headers.get('location'), 'status=' + r2.status)
const loginUrl = new URL(r2.headers.get('location') ?? '/', dexOrigin + '/').toString()
let r3 = await request('GET', loginUrl, { label: 'dex login form' })
for (let i = 0; i < 5 && [301, 302, 303].includes(r3.status) && r3.headers.get('location'); i++) {
  r3 = await request('GET', new URL(r3.headers.get('location'), loginUrl).toString(), { label: 'dex login redirect' })
}
const loginHtml = await text(r3)
const actionHref = loginHtml.match(/action="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&')
ok('6 dex login form', r3.status === 200 && loginHtml.includes('<form') && !!actionHref && loginHtml.includes('name="login"'), 'status=' + r3.status)

// ── step 4: POST credentials, then the dex approval screen if present ──────
let r4 = await request('POST', new URL(actionHref ?? '/', loginUrl).toString(), {
  body: new URLSearchParams({ login: USER, password: PASS }).toString(),
  label: 'dex login POST',
})
if (r4.status === 303 || r4.status === 302) {
  const approvalUrl = new URL(r4.headers.get('location') ?? '/', dexOrigin + '/').toString()
  if (approvalUrl.includes('/dex/approval')) {
    const rApproval = await request('GET', approvalUrl, { label: 'dex approval form' })
    const approvalHtml = await text(rApproval)
    const reqId = approvalHtml.match(/name="req" value="([^"]+)"/)?.[1]
    ok('7 dex approval screen offered', rApproval.status === 200 && !!reqId, 'status=' + rApproval.status)
    r4 = await request('POST', approvalUrl, {
      body: new URLSearchParams({ req: reqId ?? '', approval: 'approve' }).toString(),
      label: 'dex approval POST',
    })
  }
}
const callbackUrl = r4.headers.get('location')
ok('8 login completes -> 303 to prefixed callback', (r4.status === 302 || r4.status === 303) && !!callbackUrl && pathOf(callbackUrl) === PREFIX + '/oauth2/callback', 'status=' + r4.status + ' loc=' + (callbackUrl ?? '').slice(0, 110))

// ── step 5: callback -> sidecar session cookie (cookie Path assertion) ─────
const r5 = await request('GET', callbackUrl, { label: 'sidecar callback' })
const sessionCookieRaw = (r5.headers.getSetCookie?.() ?? []).find((c) => c.includes('oauth2_proxy') && !c.includes('csrf'))
const sessionCookieName = sessionCookieRaw?.split('=')[0]
const sessionCookiePath = sessionCookieRaw?.match(/;\s*Path=([^;]+)/i)?.[1] ?? '<none>'
ok('9 callback -> 302 + sidecar session cookie', r5.status === 302 && !!sessionCookieRaw, 'status=' + r5.status + ' cookie=' + (sessionCookieName ?? '(none)'))
ok('10 sidecar cookie Path is ' + EXPECTED_COOKIE_PATH, sessionCookiePath === EXPECTED_COOKIE_PATH, 'Path=' + sessionCookiePath)

// ── step 6: B7 -- where does the callback send the browser? ───────────────
const rdLocation = r5.headers.get('location') ?? ''
const rdPath = pathOf(rdLocation, callbackUrl)
const rdIsHostRoot = rdPath === '/' || rdPath === ''
const b7 = {
  callbackLocation: rdLocation,
  callbackLocationPath: rdPath,
  lostPrefix: IS_PREFIX ? !rdPath.startsWith(EXPECTED_LANDING_PATH) : false,
}
console.log('B7-EVIDENCE ' + JSON.stringify(b7))
let landingUrl = new URL(rdLocation, callbackUrl).toString()
if (IS_PREFIX && rdIsHostRoot) {
  // B7 manifested: oauth2-proxy lost the basepath and sent rd=/. M1 must catch it.
  const m1 = await request('GET', BASE + '/', { label: 'B7 fallback: host root after login' })
  ok('11 B7 fallback: GET ' + BASE + '/ after login -> 301 ' + ENTRY, m1.status === 301 && pathOf(m1.headers.get('location') ?? '', BASE) === EXPECTED_LANDING_PATH, 'status=' + m1.status + ' -> ' + (m1.headers.get('location') ?? ''))
  landingUrl = new URL(m1.headers.get('location') ?? ENTRY, BASE).toString()
} else if (rdIsHostRoot) {
  landingUrl = BASE + '/'
}
ok('12 post-login browser lands under ' + EXPECTED_LANDING_PATH, pathOf(landingUrl) === EXPECTED_LANDING_PATH, 'landing=' + landingUrl + ' (B7 lostPrefix=' + b7.lostPrefix + ', M1=' + (rdIsHostRoot && IS_PREFIX) + ')')

if (SKIP_APP) {
  printEvidence()
  finish()
}

// ── step 7: DSH launch-token handoff (302 with <prefix>/?token=) ───────────
const r6 = await request('GET', landingUrl, { label: 'authenticated entry (sidecar cookie)' })
const handoffLocation = r6.headers.get('location') ?? ''
let handoffToken = ''
try { handoffToken = new URL(handoffLocation, landingUrl).searchParams.get('token') ?? '' } catch {}
ok('13 authenticated GET ' + landingUrl + ' -> 302 launch-token handoff', r6.status === 302 && !!handoffLocation, 'status=' + r6.status)
ok('14 handoff Location is ' + ROOT + '/?token=… on the public host', originOf(handoffLocation, landingUrl) === BASE && pathOf(handoffLocation, landingUrl) === EXPECTED_LANDING_PATH && handoffToken.length > 0, 'loc=' + handoffLocation.replace(handoffToken, '<token>'))

// ── step 8: exchange token -> 303 ./ + dsh-auth cookie ────────────────────
let r7 = await request('GET', new URL(handoffLocation, landingUrl).toString(), { label: 'DSH token exchange' })
const exchangeSetCookies = r7.headers.getSetCookie?.() ?? []
const dshCookieRaw = exchangeSetCookies.find((c) => c.startsWith('dsh-auth-'))
const dshCookiePath = dshCookieRaw?.match(/;\s*Path=([^;]+)/i)?.[1] ?? '<none>'
const exchangeLocation = r7.headers.get('location') ?? ''
const exchangeTarget = new URL(exchangeLocation, new URL(handoffLocation, landingUrl)).toString()
ok('15 token exchange -> 303 ./ + dsh-auth cookie', r7.status === 303 && !!dshCookieRaw && pathOf(exchangeTarget) === EXPECTED_LANDING_PATH, 'status=' + r7.status + ' cookie=' + (dshCookieRaw ? dshCookieRaw.split('=')[0] : '(none)') + ' loc=' + exchangeLocation)
ok('16 DSH app cookie Path is / (authority-scoped by upstream)', dshCookiePath === '/', 'Path=' + dshCookiePath)

// ── step 9: authenticated entry 200 + __DSH_TRANSPORT__ ───────────────────
const r8 = await request('GET', exchangeTarget, { label: 'authenticated entry' })
const entryHtml = await text(r8)
ok('17 authenticated GET ' + ENTRY + ' -> 200', r8.status === 200, 'status=' + r8.status)
ok('18 entry HTML carries __DSH_TRANSPORT__', entryHtml.includes('__DSH_TRANSPORT__'))

// ── step 10: relative assets + boot plugin bundles under the prefix ────────
function refs(html, re, max) {
  const out = []
  for (const m of html.matchAll(re)) { const r = m[1]?.replace(/&amp;/g, '&'); if (r && !out.includes(r)) out.push(r); if (out.length >= max) break }
  return out
}
const assetRefs = refs(entryHtml, /(?:src|href)="(\.\/assets\/[^"]+)"/g, 3)
ok('19 entry HTML references ./assets/…', assetRefs.length > 0, assetRefs.join(', '))
let assetsOk = true
const assetEvidence = []
for (const ref of assetRefs) {
  const u = new URL(ref, ENTRY).toString()
  const ra = await request('GET', u, { label: 'asset ' + ref })
  const underPrefix = pathOf(u).startsWith(PREFIX + '/')
  assetEvidence.push(pathOf(u) + '=' + ra.status)
  if (ra.status !== 200 || !underPrefix) assetsOk = false
}
ok('20 assets load 200 under ' + PREFIX + '/', assetsOk, assetEvidence.join(' '))

const pluginRefs = refs(entryHtml, /(?:src|href)="(plugins\/[^"]+)"/g, 2)
ok('21 entry HTML references a boot plugin bundle (plugins/…)', pluginRefs.length > 0, pluginRefs.map((r) => r.slice(0, 60)).join(' … '))
let pluginOk = pluginRefs.length > 0
const pluginEvidence = []
for (const ref of pluginRefs) {
  const u = new URL(ref, ENTRY).toString()
  const rp = await request('GET', u, { label: 'boot plugin bundle' })
  pluginEvidence.push(pathOf(u).slice(0, 40) + '…=' + rp.status)
  if (rp.status !== 200 || !pathOf(u).startsWith(PREFIX + '/')) pluginOk = false
}
ok('22 boot plugin bundle loads 200 under ' + PREFIX + '/', pluginOk, pluginEvidence.join(' '))

// ── step 11: API gate (a real API route from the client bootstrap graph) ──
// /api/session.export is routed by the app itself (so its 400 about the missing
// sessionId query proves the request reached the app handler), while the
// unauthenticated request is answered by the sidecar with 401 for JSON clients.
const apiPath = PREFIX + '/api/session.export'
const freshJar = jar.splice(0, jar.length) // keep cookies for later controls
const rApi = await request('GET', BASE + apiPath, { headers: { accept: 'application/json' }, label: 'unauth api' })
ok('23 unauthenticated GET ' + apiPath + ' (Accept: json) -> 401', rApi.status === 401, 'status=' + rApi.status)
for (const c of freshJar) jar.push(c)
const rApiAuth = await request('GET', BASE + apiPath, { headers: { accept: 'application/json' }, label: 'auth api' })
const apiAuthBody = await text(rApiAuth)
ok('24 authenticated GET ' + apiPath + ' reaches the app handler (not 401/403)', rApiAuth.status !== 401 && rApiAuth.status !== 403, 'status=' + rApiAuth.status + ' body=' + apiAuthBody.slice(0, 80))

// ── step 10b: WebSocket upgrade under the prefix (identity headers intact) ──
// The browser RPC channel is a WebSocket; losing it under a prefix would be a
// silent release blocker. gap-auth is the identity-bridge header echoed by the
// connection layer, so its presence proves the identity path survived too.
function wsProbe(path, withCookies) {
  const u = new URL(BASE)
  const headers = {
    host: u.host,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  }
  if (withCookies) { const c = cookieHeaderFor(BASE + path); if (c) headers.cookie = c }
  return new Promise((resolve) => {
    const req = https.request(
      { host: u.hostname, port: u.port || 443, path, method: 'GET', headers, servername: u.hostname },
      (res) => { resolve({ status: res.statusCode, headers: res.headers }); req.destroy() },
    )
    req.on('upgrade', (res, socket) => { resolve({ status: res.statusCode, headers: res.headers }); socket.destroy() })
    req.on('error', (e) => resolve({ error: e.message }))
    req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'timeout' }) })
    req.end()
  })
}
const wsPath = PREFIX + '/api/remote.mux'
const wsAuth = await wsProbe(wsPath, true)
chain.push({ n: chain.length + 1, request: 'WS upgrade GET ' + BASE + wsPath, status: ('status' in wsAuth ? wsAuth.status : 'ERR'), location: null, setCookie: [], label: 'websocket authenticated' })
console.log('HOP ' + chain.length + ' WS GET ' + BASE + wsPath + ' -> ' + JSON.stringify(wsAuth).slice(0, 180))
ok('25 authenticated WebSocket ' + wsPath + ' -> 101 upgrade', ('status' in wsAuth) && wsAuth.status === 101, 'status=' + (('status' in wsAuth) ? wsAuth.status : wsAuth.error))
ok('26 WebSocket carries the identity header (gap-auth)', ('status' in wsAuth) && (wsAuth.headers['gap-auth'] ?? '').length > 0, 'gap-auth=' + (('headers' in wsAuth) ? (wsAuth.headers['gap-auth'] ?? '(none)') : ''))
const wsAnon = await wsProbe(wsPath, false)
chain.push({ n: chain.length + 1, request: 'WS upgrade GET ' + BASE + wsPath + ' (no session)', status: ('status' in wsAnon ? wsAnon.status : 'ERR'), location: wsAnon.headers?.location ?? null, setCookie: [], label: 'websocket unauthenticated' })
console.log('HOP ' + chain.length + ' WS GET (no session) -> ' + JSON.stringify(wsAnon).slice(0, 180))
let wsAnonRedirectUri = ''
try { wsAnonRedirectUri = new URL(String(wsAnon.headers?.location ?? '')).searchParams.get('redirect_uri') ?? '' } catch {}
ok('27 unauthenticated WebSocket -> 302 to the prefixed IdP login', ('status' in wsAnon) && wsAnon.status === 302 && pathOf(wsAnonRedirectUri) === PREFIX + '/oauth2/callback', 'status=' + (('status' in wsAnon) ? wsAnon.status : wsAnon.error) + ' redirect_uri=' + wsAnonRedirectUri)

// ── step 12: negative controls ────────────────────────────────────────────
const forgedUrl = ENTRY + '?token=forged-' + Date.now()
const rForged = await request('GET', forgedUrl, { label: 'forged token' })
ok('28 forged ?token= does not 500', rForged.status !== 500, 'status=' + rForged.status)

if (SIDECAR_URL) {
  // The DSH Host/Origin fence must reject an untrusted authority even when the
  // request has already passed the sidecar (defence against header spoofing /
  // misrouted traffic). Direct-to-sidecar keeps the Host header fully ours;
  // it needs raw node:http because fetch refuses to override Host.
  // The ingress/gateway strips the prefix before the sidecar, so the sidecar
  // (and dsh web) see the app-view path. Probe "/" and a real /api route: the
  // connection fence must reject the forged authority before the app routes it.
  const cookie = cookieHeaderFor(ENTRY)
  async function rawSidecarGet(requestPath, hostHeader, label) {
    const u = new URL(SIDECAR_URL)
    const mod = u.protocol === 'https:' ? https : http
    const res = await new Promise((resolve, reject) => {
      const req = mod.request(
        { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: requestPath, method: 'GET', headers: { host: hostHeader, cookie, accept: 'application/json' } },
        (r) => { let data = ''; r.on('data', (c) => (data += c)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: data })) },
      )
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('sidecar timeout')))
      req.end()
    })
    chain.push({ n: chain.length + 1, request: 'GET ' + requestPath + ' (Host: ' + hostHeader + ')', status: res.status, location: res.headers.location ?? null, setCookie: [], label })
    console.log('HOP ' + chain.length + ' GET ' + requestPath + ' Host: ' + hostHeader + ' -> ' + res.status + ' body=' + String(res.body).slice(0, 120).replace(/\n/g, ' '))
    return res
  }
  const rEvil = await rawSidecarGet('/', 'evil-tenant.svc.visecy.top', 'untrusted Host -> sidecar app path')
  ok('29 untrusted Host through sidecar -> 403 (connection fence)', rEvil.status === 403, 'status=' + rEvil.status)
  const rEvilApi = await rawSidecarGet('/api/session.export', 'evil-tenant.svc.visecy.top', 'untrusted Host -> sidecar api')
  ok('30 untrusted Host on ' + PREFIX + '/api path -> 403 (connection fence)', rEvilApi.status === 403, 'status=' + rEvilApi.status + ' body=' + String(rEvilApi.body).slice(0, 40))
  const rGood = await rawSidecarGet('/', new URL(BASE).host, 'trusted Host -> sidecar (control)')
  ok('31 trusted Host through sidecar -> not 403 (control)', rGood.status !== 403, 'status=' + rGood.status)
}

printEvidence()
finish()

// ── evidence rendering ────────────────────────────────────────────────────
function printEvidence() {
  console.log('\n=== PASS/FAIL MATRIX ===')
  for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + '\t' + r.step + '\t' + r.name + (r.extra ? '\t' + r.extra : ''))
  console.log('\n=== REDIRECT TABLE (status + Location + Set-Cookie) ===')
  for (const h of chain) {
    console.log(JSON.stringify({ n: h.n, label: h.label, request: h.request, status: h.status, location: h.location, setCookie: h.setCookie }))
  }
  if (IS_PREFIX) {
    console.log('\n=== B7 VERDICT EVIDENCE ===')
    console.log(JSON.stringify({
      b7,
      m1: b7M1,
      lostPrefixButRecovered: b7.lostPrefix === true && results.every((r) => r.pass),
      note: b7.lostPrefix
        ? 'oauth2-proxy dropped the basepath in rd; M1 root 301 is load-bearing'
        : 'oauth2-proxy kept the mount prefix in rd; M1 still verified',
    }, null, 2))
  }
  const failed = results.filter((r) => !r.pass)
  console.log('\nSUMMARY ' + (results.length - failed.length) + '/' + results.length + ' passed' + (failed.length ? ' — FAILED: ' + failed.map((f) => f.step).join(',') : ''))
}
function finish() {
  const failed = results.filter((r) => !r.pass)
  console.log(failed.length ? 'RESULT: FAILED' : 'RESULT: ALL PASSED')
  process.exitCode = failed.length ? 1 : 0
}
