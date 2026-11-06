// _test-batch-20261107.mjs —— 2026-11-07 批次修复的离线断言（B1/B2/B3/B9/B10/B11）
// 跑法：node test/_test-batch-20261107.mjs   末行 "BATCH: ALL PASS"
// 只用临时目录 + 最小 cordis ctx 假件，不连宿主、不碰真实数据。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from './index.js'

const tmpRoots = []
const failures = []
const mkTmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmpRoots.push(d); return d }
const ok = (n, c, d) => { if (c) { console.log('  ok   ' + n); return } failures.push(n + (d ? ' :: ' + d : '')); console.log('  FAIL ' + n + (d ? ' :: ' + d : '')) }

function makeCtx() {
  const registered = []
  const disposers = []
  const toolsSvc = { register(def) { registered.push(def); return { dispose() {} } } }
  // 假 schedule：tell() 依赖它；没有它 auto-judge 会走 catch 分支（"schedule service not ready"）
  const scheduleSvc = { async create(target, opts) { return { ok: true, target, at: opts && opts.at } } }
  const svcMap = { tools: toolsSvc, schedule: scheduleSvc }
  const ctx = {
    get: (n) => svcMap[n],
    inject(deps, cb) { const names = Array.isArray(deps) ? deps : Object.keys(deps || {}); const found = {}; let all = true; for (const n of names) { if (svcMap[n]) found[n] = svcMap[n]; else all = false } if (all) cb(found); return {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    on() {}, emit() {}, logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return { ctx, registered, disposeAll: () => disposers.forEach((d) => { try { d() } catch {} }) }
}
const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]))
const readLog = (stateDir) => { try { return readFileSync(join(stateDir, 'lite.log'), 'utf8') } catch { return '' } }

const OWNER = 'session-owner-0001'
const seedRoles = (stateDir, judges) => {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'owners.json'), JSON.stringify({
    owners: [OWNER], workers: [], judges, ops: [], children: [], models: {}, kinds: {},
    updatedAt: new Date().toISOString(),
  }, null, 1), 'utf8')
}

// ── B9：新 state 首单不得触发 epoch rotate ─────────────────────────────
console.log('B9. prefixFor(seq=0) / 首单不跨纪元')
{
  const stateDir = join(mkTmp('batch-b9-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a', 'judge-b'])
  apply(ctx, { stateDir })
  const tools = byName(registered)
  const exec = { agent: { id: OWNER } }
  const r = await tools.sa_submit.execute({ title: 'first', type: 'code' }, exec)
  ok('首单建出来了', r.ok === true, r.detail)
  ok('首单 id = sa-001', /sa-001/.test(String(r.detail)), r.detail)
  const log = readLog(stateDir)
  ok('日志里没有 epoch rotate', !/epoch rotate/.test(log), '出现了 epoch rotate：' + (log.match(/.*epoch rotate.*/) || [''])[0])
}

// ── B1：judgeRotate 真轮换（2 个 judge 交替） ─────────────────────────
console.log('B1. judgeRotate 轮换（autoJudge=true + judgeRotate=true）')
{
  const stateDir = join(mkTmp('batch-b1-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a', 'judge-b'])
  apply(ctx, { stateDir, autoJudge: true, judgeRotate: true })
  const tools = byName(registered)
  const exec = { agent: { id: OWNER } }
  const ids = []
  for (const n of [1, 2, 3]) {
    const r = await tools.sa_submit.execute({ title: 't' + n, type: 'code' }, exec)
    ids.push((String(r.detail).match(/sa-\d+/) || [''])[0])
  }
  for (const id of ids) {
    await tools.sa_advance.execute({ id, to: 'running' }, exec)
    await tools.sa_advance.execute({ id, to: 'ready' }, exec)
  }
  const log = readLog(stateDir)
  const picks = [...log.matchAll(/judge-rotate pick=(\S+)/g)].map((m) => m[1])
  ok('轮换日志出现 3 次', picks.length === 3, JSON.stringify(picks))
  ok('交替（a,b,a）不是固定一个人', picks.length === 3 && picks[0] !== picks[1] && picks[0] === picks[2], JSON.stringify(picks))
}

// ── B1b：autoJudge 显式给 id 时不轮换（显式优先） ─────────────────────
console.log('B1b. autoJudge 显式 id 优先，不轮换')
{
  const stateDir = join(mkTmp('batch-b1b-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a', 'judge-b'])
  apply(ctx, { stateDir, autoJudge: 'judge-explicit', judgeRotate: true })
  const tools = byName(registered)
  const exec = { agent: { id: OWNER } }
  const r1 = await tools.sa_submit.execute({ title: 'x', type: 'code' }, exec)
  const id = (String(r1.detail).match(/sa-\d+/) || [''])[0]
  await tools.sa_advance.execute({ id, to: 'running' }, exec)
  await tools.sa_advance.execute({ id, to: 'ready' }, exec)
  const log = readLog(stateDir)
  ok('没有 judge-rotate 日志', !/judge-rotate pick=/.test(log), '出现了 rotate')
  ok('送给显式 judge', /judge-explicit/.test(log), log.split('\n').filter((l) => /judge/.test(l)).slice(-3).join(' | '))
}

// ── B2：notifyReadyTo=owner → 不送审、只叫 owner ──────────────────────
console.log('B2. notifyReadyTo=owner')
{
  const stateDir = join(mkTmp('batch-b2o-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a'])
  apply(ctx, { stateDir, autoJudge: true, notifyReadyTo: 'owner' })
  const tools = byName(registered)
  const exec = { agent: { id: OWNER } }
  const r = await tools.sa_submit.execute({ title: 'o', type: 'code' }, exec)
  const id = (String(r.detail).match(/sa-\d+/) || [''])[0]
  await tools.sa_advance.execute({ id, to: 'running' }, exec)
  await tools.sa_advance.execute({ id, to: 'ready' }, exec)
  const log = readLog(stateDir)
  ok('不送审（有 notifyReadyTo-owner 标记）', /reason=notifyReadyTo-owner/.test(log), log.split('\n').filter((l) => /auto-judge/.test(l)).slice(-2).join(' | '))
  ok('owner 提醒进了 outbox（有 enqueue 行）', new RegExp('enqueue ' + id).test(log), log.split('\n').filter((l) => /enqueue/.test(l)).slice(-2).join(' | '))
}

// ── B2b：notifyReadyTo=both → 既送审又叫 owner ───────────────────────
console.log('B2b. notifyReadyTo=both')
{
  const stateDir = join(mkTmp('batch-b2b-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a'])
  apply(ctx, { stateDir, autoJudge: true, notifyReadyTo: 'both' })
  const tools = byName(registered)
  const exec = { agent: { id: OWNER } }
  const r = await tools.sa_submit.execute({ title: 'b', type: 'code' }, exec)
  const id = (String(r.detail).match(/sa-\d+/) || [''])[0]
  await tools.sa_advance.execute({ id, to: 'running' }, exec)
  await tools.sa_advance.execute({ id, to: 'ready' }, exec)
  const log = readLog(stateDir)
  ok('送审了（有 auto-judge 行）', new RegExp('auto-judge ' + id).test(log), log.split('\n').filter((l) => /auto-judge/.test(l)).slice(-2).join(' | '))
  ok('owner 也收到（有 enqueue 行）', new RegExp('enqueue ' + id).test(log), log.split('\n').filter((l) => /enqueue/.test(l)).slice(-2).join(' | '))
}

// ── B3：ingress 坏行留痕 ─────────────────────────────────────────────
console.log('B3. ingress 坏行必须留痕')
{
  const stateDir = join(mkTmp('batch-b3-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a'])
  const ingress = join(stateDir, 'ingress.jsonl')
  writeFileSync(ingress, JSON.stringify({ source: 'x', key: 'good-1', title: '好行' }) + '\n{oops 坏行\n', 'utf8')
  const svc = apply(ctx, { stateDir, ingressFile: ingress })
  ok('svc 有 tickIngress', typeof svc.tickIngress === 'function')
  svc.tickIngress()
  const log = readLog(stateDir)
  ok('坏行留了日志（ingress bad-line）', /ingress bad-line/.test(log), log.split('\n').filter((l) => /ingress/.test(l)).slice(-3).join(' | '))
  ok('好行仍然建了单', /ingress create sa-\d+/.test(log), log.split('\n').filter((l) => /ingress/.test(l)).slice(-4).join(' | '))
}

// ── B11：watchdog 对非法 updatedAt 不许静默 ──────────────────────────
console.log('B11. watchdog 遇非法 updatedAt 有痕迹')
{
  const stateDir = join(mkTmp('batch-b11-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a'])
  apply(ctx, { stateDir })
  const tools = byName(registered)
  const exec = { agent: { id: OWNER } }
  const r = await tools.sa_submit.execute({ title: 'bad-time', type: 'code' }, exec)
  const id = (String(r.detail).match(/sa-\d+/) || [''])[0]
  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
  const t = st.tickets.find((x) => x.id === id)
  t.state = 'running'
  t.updatedAt = 'not-a-date'
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(st, null, 1), 'utf8')
  // 重开服务读新 state，再跑一次 watchdog（定时器之外的确定性触发）
  const { ctx: ctx2, registered: reg2 } = makeCtx()
  const svc2 = apply(ctx2, { stateDir })
  if (typeof svc2.watchdogTick === 'function') svc2.watchdogTick()
  const log = readLog(stateDir)
  if (typeof svc2.watchdogTick === 'function') {
    ok('有 bad-updatedAt 痕迹', new RegExp('watchdog skip ' + id + ' reason=bad-updatedAt').test(log), log.split('\n').filter((l) => /watchdog/.test(l)).slice(-3).join(' | '))
  } else {
    ok('svc 暴露 watchdogTick（否则本断言无法确定性触发）', false, 'typeof svc.watchdogTick=' + typeof svc2.watchdogTick)
  }
}

// ── B10：同分钟内两次归档快照不得互相覆盖 ────────────────────────────
console.log('B10. 归档快照同分钟不覆盖')
{
  const stateDir = join(mkTmp('batch-b10-'), 'state')
  const { ctx, registered } = makeCtx()
  seedRoles(stateDir, ['judge-a'])
  apply(ctx, { stateDir })
  const tools = byName(registered)
  const exec = { agent: { id: OWNER } }
  const mkDone = async (title) => {
    const r = await tools.sa_submit.execute({ title, type: 'code' }, exec)
    const id = (String(r.detail).match(/sa-\d+/) || [''])[0]
    await tools.sa_advance.execute({ id, to: 'running' }, exec)
    await tools.sa_advance.execute({ id, to: 'ready' }, exec)
    await tools.sa_advance.execute({ id, to: 'done', reason: 'test' }, exec)
    return id
  }
  await mkDone('a1')
  const a1 = await tools.sa_archive.execute({ all: true }, exec)
  ok('第一次归档 ok', a1.ok === true, a1.detail)
  await mkDone('a2')
  const a2 = await tools.sa_archive.execute({ all: true }, exec)
  ok('第二次归档 ok', a2.ok === true, a2.detail)
  const dir = join(stateDir, 'archive', 'tickets')
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : []
  ok('两次快照都还在（同分钟内不覆盖）', files.length === 2, JSON.stringify(files))
  ok('文件名带秒，撞名时加 -2 后缀', files.every((n) => /-\d{8}-\d{6}(-\d+)?\.json$/.test(n)), JSON.stringify(files))
}

for (const d of tmpRoots) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
const fails = failures.length
if (fails) { console.log(''); for (const f of failures) console.log('  ✗ ' + f) }
console.log(fails ? ('BATCH: ' + fails + ' FAIL') : 'BATCH: ALL PASS')
process.exit(fails ? 1 : 0)
