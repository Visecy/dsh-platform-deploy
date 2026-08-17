const DAEMON = process.env.DAEMON ?? 'http://dsh-ws-smoke-svc.dsh-platform.svc.cluster.local:4390'
const jpost = async (p, b) => fetch(DAEMON + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(15000) }).then(async r => ({ status: r.status, text: await r.text() }))
const jget = (p) => fetch(DAEMON + p, { signal: AbortSignal.timeout(5000) }).then(r => r.text())

const pty = await jpost('/ptys', { spec: { argv: ['bash'], cwd: '/workspace' }, cols: 80, rows: 24 })
const ptyId = JSON.parse(pty.text).data.ptyId
console.log('ptyId', ptyId)
// wait for bash prompt
await new Promise(r => setTimeout(r, 1200))
console.log('out1:', JSON.parse(await jget('/ptys/' + ptyId + '/output?from=0')).data.frames.slice(0, 80))
// now send echo with CR
await jpost('/ptys/' + ptyId + '/write', { data: Buffer.from('echo pty-ok\r').toString('base64') })
await new Promise(r => setTimeout(r, 1500))
const o2 = JSON.parse(await jget('/ptys/' + ptyId + '/output?from=0')).data.frames
console.log('out2:', JSON.stringify(o2.slice(0, 120)))
// exit
await jpost('/ptys/' + ptyId + '/write', { data: Buffer.from('exit\r').toString('base64') })
await new Promise(r => setTimeout(r, 800))
console.log('status:', await jget('/ptys/' + ptyId + '/status'))
