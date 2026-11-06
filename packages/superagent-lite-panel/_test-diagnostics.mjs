// sa-196：面板诊断端点（只读、12 项、异常降级、0 写操作）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { apply, buildDiagnostics } from './index.js'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); fails++ } else console.log('ok   ' + m) }
const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'sa-diag-'))
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1))

function routes(dir, config = {}) {
  let handler
  apply({ inject: (_n, cb) => cb({ effect: (fn) => fn(), webServer: { register: (r) => { handler = r.handler; return () => {} } } }) }, { stateDir: dir, ...config })
  assert.equal(typeof handler, 'function')
  return (path, body, method = body === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const events = {}
    const timer = setTimeout(() => reject(new Error('handler timeout: ' + path)), 3000)
    const req = { url: '/superagent' + path, method, headers: { 'content-type': 'application/json' }, on: (ev, fn) => { (events[ev] ||= []).push(fn); return req }, destroy: () => {} }
    const res = { statusCode: 0, setHeader: () => {}, end: (text) => { clearTimeout(timer); try { resolve({ status: res.statusCode, json: JSON.parse(text) }) } catch (e) { reject(e) } } }
    Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e) })
    if (method === 'POST') { const raw = JSON.stringify(body === undefined ? {} : body); for (const fn of events.data || []) fn(Buffer.from(raw)); for (const fn of events.end || []) fn() }
  })
}

// ---- 1. 正常 fixture：12 项齐全、summary 正确、HTTP 200 ----
const dir = tmp()
writeJson(join(dir, 'state.json'), { version: 2, tickets: [
  { id: 'sa-001', state: 'done', artifacts: [], history: [] },
  { id: 'sa-002', state: 'running', artifacts: [], history: [] },
  { id: 'sa-003', state: 'blocked', artifacts: [], history: [] },
], outbox: [{ key: 'k1', ticketId: 'sa-001', sentAt: null }] })
writeJson(join(dir, 'owners.json'), { owners: ['session-a'], workers: ['session-b'], judges: ['session-c'], models: { 'session-b': 'our-free-model/x' } })
fs.mkdirSync(join(dir, 'archive', 'tickets'), { recursive: true })
fs.mkdirSync(join(dir, 'archive', 'verdicts'), { recursive: true })
fs.mkdirSync(join(dir, 'archive', 'handoff'), { recursive: true })
const call = routes(dir, { port: 12345, napcatPort: 1, patchFile: join(dir, 'no-patch.yml'), codexHooks: join(dir, 'no-hooks.json'), queueDir: join(dir, 'no-queue'), stopHook: join(dir, 'no-stop.mjs'), watcherPkg: join(dir, 'no-watch', 'package.json'), monitorPid: join(dir, 'no.pid') })

let r = await call('/diagnostics')
ok(r.status === 200 && r.json.ok === true, 'GET /diagnostics 200 ok')
ok(Array.isArray(r.json.checks) && r.json.checks.length === 14, '返回 14 项检查（' + (r.json.checks && r.json.checks.length) + '）')
const keys = r.json.checks.map((c) => c.key)
for (const k of ['host', 'plugins', 'services', 'owners', 'statedir', 'state', 'archive', 'free-model', 'qq', 'codex', 'watcher', 'ctx-monitor']) ok(keys.includes(k), '检查项存在：' + k)
ok(r.json.checks.every((c) => ['ok', 'missing', 'bad', 'unverified'].includes(c.status)), '每项状态取值合法')
ok(r.json.checks.every((c) => (c.status === 'ok' ? true : !!c.fix)), 'bad/missing/unverified 都带 fix')
const sum = r.json.summary
ok(sum.ok + sum.missing + sum.bad + sum.unverified === 14, 'summary 合计 = 14')
const stateHit = r.json.checks.find((c) => c.key === 'state')
ok(stateHit.status === 'ok' && /total=3/.test(stateHit.detail), '工单计数正确：' + stateHit.detail)
ok(/pendingOutbox=1/.test(stateHit.detail), 'pendingOutbox 计数')
const ownersHit = r.json.checks.find((c) => c.key === 'owners')
ok(ownersHit.status === 'ok', 'owners 已配置 → ok')
const archiveHit = r.json.checks.find((c) => c.key === 'archive')
ok(archiveHit.status === 'ok', '归档三件目录齐 → ok')
const fm = r.json.checks.find((c) => c.key === 'free-model')
ok(fm.status === 'ok', 'owners.models 出现 our-free-model → ok')
const qq = r.json.checks.find((c) => c.key === 'qq')
ok(qq.status === 'missing' && !!qq.fix, '无 NapCat/bridge → missing 且有 fix')
const codex = r.json.checks.find((c) => c.key === 'codex')
ok(codex.status === 'missing' && !!codex.fix, '无 Codex 桥 → missing 且有 fix')
const mon = r.json.checks.find((c) => c.key === 'ctx-monitor')
ok(mon.status === 'missing' && !!mon.fix, '监测未启用 → missing 且有 fix')

// ---- 2. 只读：调用前后目录快照完全一致 ----
const snap = () => {
  const out = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p + '|' + fs.statSync(p).size + '|' + fs.statSync(p).mtimeMs) } }
  walk(dir); return out.sort().join('\n')
}
const before = snap()
await call('/diagnostics')
ok(snap() === before, '诊断不写任何文件（目录快照一致）')

// ---- 3. stateDir 不存在：不 500、降级 ----
const missingDir = join(tmp(), 'nope')
const call2 = routes(missingDir)
r = await call2('/diagnostics')
ok(r.status === 200, 'stateDir 不存在仍返回 200（不 500）')
ok(r.json.checks.length === 14, '仍给 14 项')
const sd = r.json.checks.find((c) => c.key === 'statedir')
ok(sd.status === 'bad' && !!sd.fix, 'stateDir 不存在 → bad + fix')
const st = r.json.checks.find((c) => c.key === 'state')
ok(st.status === 'bad' && !!st.fix, 'state.json 读不到 → bad + fix')

// ---- 4. 坏 state.json：bad 不抛 ----
const badDir = tmp()
fs.writeFileSync(join(badDir, 'state.json'), '{bad json', 'utf8')
writeJson(join(badDir, 'owners.json'), { owners: [] })
const call3 = routes(badDir)
r = await call3('/diagnostics')
ok(r.status === 200, '坏 state.json 仍 200')
ok(r.json.checks.find((c) => c.key === 'state').status === 'bad', '坏 state.json → bad')
ok(r.json.checks.find((c) => c.key === 'owners').status === 'bad', 'owners 空 → bad')

// ---- 5. buildDiagnostics 直接调用（无 ctx）也不抛 ----
let threw = null
try { await buildDiagnostics(dir, { patchFile: join(dir, 'x.yml') }, null) } catch (e) { threw = e }
ok(threw === null, 'buildDiagnostics 无 ctx 不抛')

// ---- 6. 监测端点：未启用时 stop 明确报错，不误杀 ----
r = await call('/monitor/stop', {})
ok(r.status === 400 && /没有 pid 文件/.test(String(r.json.error)), 'monitor/stop 无 pid → 400 明确报错')
r = await call('/monitor/start', {})
ok(r.status === 500 && /监测脚本不存在/.test(String(r.json.error)), 'monitor/start 脚本不存在 → 500 明确报错')

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(missingDir, { recursive: true, force: true })
fs.rmSync(badDir, { recursive: true, force: true })
console.log('')
console.log(fails === 0 ? 'diagnostics: ALL PASS' : 'diagnostics: FAIL ' + fails)
process.exit(fails ? 1 : 0)
