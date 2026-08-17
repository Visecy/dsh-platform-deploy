// Workspace daemon smoke test (runs inside cluster with Node 24 fetch).
const DAEMON = process.env.DAEMON ?? 'http://dsh-ws-smoke-svc.dsh-platform.svc.cluster.local:4390'
let pass = 0, fail = 0
const ok = (n, c, x = '') => { if (c) { pass++; console.log('PASS:', n, x) } else { fail++; console.log('FAIL:', n, x) } }

async function jpost(path, body) {
  const res = await fetch(DAEMON + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  return { status: res.status, text }
}
const jget = (path) => fetch(DAEMON + path, { signal: AbortSignal.timeout(5000) }).then(r => r.text())

// 1. healthz
const hz = await fetch(DAEMON + '/healthz', { signal: AbortSignal.timeout(5000) })
ok('healthz 200', hz.status === 200, 'status ' + hz.status)

// 2. files/write (content base64) + read roundtrip
const w = await jpost('/files/write', { path: 'smoke.txt', content: Buffer.from('hello from smoke test').toString('base64'), version: null })
ok('files/write 200', w.status === 200, 'status ' + w.status)
const rd = await jpost('/files/read', { path: 'smoke.txt' })
let readText = ''
try { readText = Buffer.from(JSON.parse(rd.text).data.bytes ?? '', 'base64').toString('utf8') } catch {}
ok('files/read roundtrip', rd.status === 200 && readText.includes('hello from smoke test'), 'decoded: ' + readText.slice(0, 40))

// 3. info + list
const info = await jpost('/files/info', { path: 'smoke.txt' })
ok('files/info size', info.status === 200 && info.text.includes('"size"'), 'status ' + info.status)
const list = await jpost('/files/list', { path: '/' })
ok('files/list contains smoke.txt', list.status === 200 && list.text.includes('smoke.txt'), 'status ' + list.status)

// 4. commands/run: argv spec, poll output + exit code
const run = await jpost('/commands/run', { spec: { argv: ['bash', '-c', 'echo daemon-ok && exit 7'], cwd: '/workspace' } })
let runId = null
try { runId = JSON.parse(run.text).data.cmdId ?? null } catch {}
ok('commands/run cmdId', run.status === 200 && runId !== null, run.text.slice(0, 80))
let runOut = '', exitCode = null
if (runId !== null) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250))
    const out = await jget('/commands/' + runId + '/output?stream=stdout&from=0')
    try { runOut += Buffer.from(JSON.parse(out).data.frames ?? '', 'base64').toString('utf8') } catch {}
    const st = await jget('/commands/' + runId + '/status')
    try { const j = JSON.parse(st); if (j.data.status?.phase === 'exited') { exitCode = j.data.status.exitCode; break } } catch {}
  }
}
ok('commands/run output', runOut.includes('daemon-ok'), runOut.slice(0, 60))
ok('commands/run exitCode 7', exitCode === 7, 'exit=' + exitCode)

// 5. resolve-executable
const rex = await jpost('/commands/resolve-executable', { command: 'bash' })
ok('resolve-executable bash', rex.status === 200 && /\/bash$|\/bash"/.test(rex.text), rex.text.slice(0, 80))

// 6. pty spawn -> write -> read -> terminate
const pty = await jpost('/ptys', { spec: { argv: ['bash'], cwd: '/workspace' }, cols: 80, rows: 24 })
let ptyId = null
try { ptyId = JSON.parse(pty.text).data.ptyId ?? null } catch {}
ok('pty spawn ptyId=' + ptyId, pty.status === 200 && ptyId !== null, pty.text.slice(0, 120))
if (ptyId !== null) {
  await jpost('/ptys/' + ptyId + '/write', { data: Buffer.from('echo pty-ok\r').toString('base64') })
  await new Promise(r => setTimeout(r, 1500))
  const out = await jget('/ptys/' + ptyId + '/output?from=0')
  const ptyOut = (() => { try { return JSON.parse(out).data.frames.split('\n').filter(l => l && !l.startsWith('EOF')).map(l => Buffer.from(l, 'base64').toString('utf8')).join('') } catch { return '' } })()
  ok('pty output echo', ptyOut.includes('pty-ok'), ptyOut.slice(0, 60))
  const term = await jpost('/ptys/' + ptyId + '/terminate', { graceMs: 1000 })
  ok('pty terminate 200', term.status === 200, 'status ' + term.status)
}

// 7. process group cleaned up
await new Promise((r) => setTimeout(r, 2000))
const pids = await jget('/commands')
const running = (() => { try { return JSON.parse(pids).data.commands.filter(c => c.phase !== 'exited' && c.phase !== 'killed').length } catch { return -1 } })()
ok('no running processes remain', running === 0, 'running=' + running)

// 8. terminate-all
const ta = await jpost('/commands/terminate-all', { graceMs: 2000 })
ok('terminate-all 200', ta.status === 200, 'status ' + ta.status)

console.log('')
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
