// _test-ctx-monitor.mjs — sa-191 验收测试（零依赖）
// 跑法：node handoff/tools/_test-ctx-monitor.mjs
// 假数据全在 mkdtempSync(os.tmpdir())，绝不写真实 handoff/superagent/ingress.jsonl

import assert from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMonitor, inScope, isOfficialDeepSeek, rotateAlertsLog, runDaemon, runLoop, sessionLine, thresholdFor } from './ctx-monitor.mjs'

// sa-198：测试用「临时测试根」，不再写死任何本机绝对路径。
// 结构：<TEST_WS_ROOT> 作为 subagent 根的替身，<TEST_WS_ROOT>/worker_1 之类当子目录。
const TEST_WS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '.ctxmon-ws')


const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'ctx-monitor.mjs')
const OWNER_SESSION = 'session-test-owner-0000-1111-2222-333333333333'  // 测试用假 id（脚本本身不硬编码 owner）

const failures = []
const roots = []
const ok = (name, cond, detail) => {
  if (cond) { console.log('  ok   ' + name); return }
  failures.push(name + (detail ? ' :: ' + detail : ''))
  console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
}
const eq = (name, actual, expected) => ok(name, Object.is(actual, expected), 'expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual))

// 临时根：TMP/TEMP 可能没设（本机某些启动器下 os.tmpdir() 会退化成相对路径），先探存在的，再退到当前目录
let usedFallbackTmp = false
const TMP_BASE = (() => {
  for (const c of [process.env.TMP, process.env.TEMP, (() => { try { return tmpdir() } catch { return '' } })()]) {
    if (!c) continue
    try { if (statSync(c).isDirectory()) return c } catch {}
  }
  usedFallbackTmp = true
  const fb = join(process.cwd(), '.ctxmon-tmp')
  mkdirSync(fb, { recursive: true })
  return fb
})()
const mkRoot = () => { const d = mkdtempSync(join(TMP_BASE, 'ctxmon-')); roots.push(d); return d }

let tick = 0
function buildSession({ provider = 'deepseek-account', model = 'deepseek-flash', pressure = 0, window = 1000, cwd = join(TEST_WS_ROOT), title = null, noPressure = false, pad = 0 } = {}) {
  const rows = {
    title: { ver: 1, seq: 1, val: title },
    contextPressure: noPressure ? undefined : { ver: 5, seq: 1, val: { surfaceTokens: 1, contextWindow: window, pressureTokens: pressure, sampledSurfaceTokens: 1 } },
    modelSelection: { ver: 2, seq: 1, val: { lastUsed: { provider, model } } },
  }
  const rec = { version: 1, record: { identity: { formatVersion: 4, cwd }, rows } }
  if (pad) rec.pad = 'x'.repeat(pad)
  return rec
}
// 每次写都推进 mtime（同一毫秒内连写同尺寸文件时，单看 mtimeMs 会看起来没变）
function writeSession(dir, id, opt = {}) {
  const file = join(dir, id.endsWith('.json') ? id : id + '.json')
  writeFileSync(file, JSON.stringify(buildSession(opt)), 'utf8')
  const t = new Date(1700000000000 + (++tick) * 60000)
  utimesSync(file, t, t)
  return file
}
function patchSession(file, opt = {}) {
  writeFileSync(file, JSON.stringify(buildSession(opt)), 'utf8')
  const t = new Date(1700000000000 + (++tick) * 60000)
  utimesSync(file, t, t)
}
function runCli(args, timeout = 120000) {
  // 可移植性（2026-11-06 修，judge 发现）：CLI 用例原来依赖「cwd=tools 时 TEST_WS_ROOT 才落进默认扫描根」，
  // 从任何中立目录跑就必挂 7 条。这里统一兜底：用例没显式给 --root 时补 --root=TEST_WS_ROOT。
  const hasRoot = args.some((a) => a === '--root' || a.startsWith('--root='))
  const full = hasRoot ? args : [...args, '--root=' + TEST_WS_ROOT]
  const r = spawnSync(process.execPath, [SCRIPT, ...full], { encoding: 'utf8', timeout })
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '' }
}
const readLines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()) : [])

// ── 1. 阈值只看 provider（2026-11-06 第二轮口径修正）──────────────────────
console.log('1. 阈值只看 provider')
eq('deepseek-account/deepseek-flash → 65', thresholdFor('deepseek-account', 'deepseek-flash'), 65)
eq('带空格/大写 DeepSeek-Account → 65', thresholdFor('  DeepSeek-Account  ', 'x'), 65)
eq('trae/glm-5.3 → 85', thresholdFor('trae', 'glm-5.3'), 85)
eq('trae/deepseek-v4.1-flash → 85（第三方渠道）', thresholdFor('trae', 'deepseek-v4.1-flash'), 85)
eq('trae/DeepSeek-V4-Flash → 85', thresholdFor('trae', 'DeepSeek-V4-Flash'), 85)
eq('raccoon/sn-deepseek-v4-1-flash-1017 → 85', thresholdFor('raccoon', 'sn-deepseek-v4-1-flash-1017'), 85)
ok('isOfficialDeepSeek 只认 provider', isOfficialDeepSeek('deepseek-account') && !isOfficialDeepSeek('trae') && !isOfficialDeepSeek(''))
{
  const d = mkRoot()
  writeSession(d, 'session-ds66', { pressure: 660 })
  writeSession(d, 'session-ds64', { pressure: 640 })
  writeSession(d, 'session-glm86', { provider: 'trae', model: 'glm-5.3', pressure: 860 })
  writeSession(d, 'session-glm84', { provider: 'trae', model: 'glm-5.3', pressure: 840 })
  writeSession(d, 'session-trae70', { provider: 'trae', model: 'deepseek-v4.1-flash', pressure: 700 })
  writeSession(d, 'session-official70', { provider: 'deepseek-account', model: 'deepseek-flash', pressure: 700 })
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  const fired = new Set(r.fired)
  ok('官方 DS 66% → 报', fired.has('session-ds66'))
  ok('官方 DS 64% → 不报', !fired.has('session-ds64'))
  ok('trae/glm 86% → 报', fired.has('session-glm86'))
  ok('trae/glm 84% → 不报', !fired.has('session-glm84'))
  // 用户点名的两条
  ok('① trae/deepseek-v4.1-flash 70% → 不报（阈值 85）', !fired.has('session-trae70'))
  ok('② deepseek-account/deepseek-flash 70% → 报（阈值 65）', fired.has('session-official70'))
  eq('③ 官方 DS 66 报（本轮已含）', fired.has('session-ds66'), true)
  eq('③ 官方 DS 64 不报', fired.has('session-ds64'), false)
  eq('alerts=3', r.alerts, 3)
  const rows = Object.fromEntries(r.rows.map((x) => [x.sessionId, x]))
  eq('DS 阈值 65', rows['session-ds66'].threshold, 65)
  eq('glm 阈值 85', rows['session-glm86'].threshold, 85)
  eq('trae+deepseek 阈值 85', rows['session-trae70'].threshold, 85)
}
{
  // provider 完全缺失：按 85%，且在 ctx-alerts.log 里标 provider-missing（用例 ④）
  const d = mkRoot()
  writeSession(d, 'session-noprov', { provider: '', model: 'deepseek-flash', pressure: 900 })
  const alertsLog = join(d, 'a.log')
  const m = createMonitor({ dir: d, alertsLog, ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  eq('provider 缺失 → 阈值 85', r.rows[0].threshold, 85)
  ok('90% > 85 → 报', r.fired.includes('session-noprov'))
  const line = readLines(alertsLog)[0]
  let row = null
  try { row = JSON.parse(line || '{}') } catch {}
  eq('日志标 provider-missing', row && row.note, 'provider-missing')
  eq('日志里的阈值也是 85', row && row.threshold, 85)
}
{
  // 商汤 256000 窗口：各自窗口算百分比（200000 → 78.1%，低于 85 不报；220000 → 85.9%，报）
  const d = mkRoot()
  writeSession(d, 'session-sense78', { provider: 'raccoon', model: 'sn-sensenova-6-8-flash', window: 256000, pressure: 200000 })
  writeSession(d, 'session-sense86', { provider: 'raccoon', model: 'sn-sensenova-6-8-flash', window: 256000, pressure: 220000 })
  writeSession(d, 'session-wide19', { provider: 'raccoon', model: 'sn-sensenova-6-8-flash', window: 1048576, pressure: 200000 })
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  const byId = Object.fromEntries(r.rows.map((x) => [x.sessionId, x]))
  eq('256000 窗口 200000 tokens → 78.1%', Math.round(byId['session-sense78'].pct * 10) / 10, 78.1)
  ok('78.1% < 85 → 不报', !r.fired.includes('session-sense78'))
  eq('256000 窗口 220000 tokens → 85.9%', Math.round(byId['session-sense86'].pct * 10) / 10, 85.9)
  ok('85.9% > 85 → 报', r.fired.includes('session-sense86'))
  eq('1048576 窗口 200000 tokens → 19.1%', Math.round(byId['session-wide19'].pct * 10) / 10, 19.1)
  ok('19.1% → 不报', !r.fired.includes('session-wide19'))
}

// ── 2. 冷却：30 分钟内同一 session 只报一次（迟滞复位后也不放行）─────────────
console.log('2. 冷却')
{
  const d = mkRoot()
  const alertsLog = join(d, 'ctx-alerts.log')
  const ingressFile = join(d, 'ingress.jsonl')
  const file = writeSession(d, 'session-hot', { pressure: 900 })
  const m = createMonitor({ dir: d, alertsLog, ingressFile, cooldownMs: 30 * 60 * 1000, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r1 = m.scanOnce() // 90% → 报
  const r2 = m.scanOnce() // 还是 90% → 不报
  eq('第 1 轮 alerts=1', r1.alerts, 1)
  eq('第 2 轮 alerts=0（没变化，已缴械）', r2.alerts, 0)
  patchSession(file, { pressure: 500 }) // 50% < 60% → 重新武装
  const r3 = m.scanOnce()
  patchSession(file, { pressure: 900 }) // 又越线，但冷却没到
  const r4 = m.scanOnce()
  eq('掉到 50% 不报', r3.alerts, 0)
  eq('冷却内再越线仍不报（alerts=0）', r4.alerts, 0)
  ok('第 4 轮该 session 标了 suppressed', r4.rows.find((x) => x.sessionId === 'session-hot').suppressed === true)
  // 2026-11-09：掉 ≥15 个点会额外写一行 level=compaction 的压缩事件（触发压缩后自检），越线告警仍按原口径数
  eq('ctx-alerts.log 只有 1 行越线告警（压缩事件另计）', readLines(alertsLog).filter((l) => !l.includes('"level":"compaction"')).length, 1)
  eq('ingress 只有 1 条越线告警（压缩事件另计）', readLines(ingressFile).filter((l) => !l.includes('ctx-compact:')).length, 1)
}
{
  // 同样的时序，冷却设 0 → 第二次越线应该报（证明是冷却在挡，不是别的）
  const d = mkRoot()
  const alertsLog = join(d, 'b.log')
  const file = writeSession(d, 'session-hot0', { pressure: 900 })
  const m = createMonitor({ dir: d, alertsLog, ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r1 = m.scanOnce()
  patchSession(file, { pressure: 500 })
  const r2 = m.scanOnce()
  patchSession(file, { pressure: 900 })
  const r3 = m.scanOnce()
  eq('冷却 0：首轮报', r1.alerts, 1)
  eq('冷却 0：中间掉下去不报', r2.alerts, 0)
  eq('冷却 0：再越线再报', r3.alerts, 1)
  eq('冷却 0：共 2 行越线告警（压缩事件另计）', readLines(alertsLog).filter((l) => !l.includes('"level":"compaction"')).length, 2)
}

// ── 3. 迟滞：掉到阈值-5 以下 → 重新武装；没掉够 → 不重新报 ─────────────────
console.log('3. 迟滞')
{
  const d = mkRoot()
  const file = writeSession(d, 'session-hyst', { pressure: 660 })
  const alertsLog = join(d, 'a.log')
  const m = createMonitor({ dir: d, alertsLog, ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, hysteresis: 5, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r1 = m.scanOnce() // 66 → 报
  const r2 = m.scanOnce() // 66 → 不报
  patchSession(file, { pressure: 590 }) // 59 < 60 → 重新武装
  const r3 = m.scanOnce()
  patchSession(file, { pressure: 660 }) // 66 → 再报
  const r4 = m.scanOnce()
  eq('66% 首报', r1.alerts, 1)
  eq('仍在 66% → 不重复', r2.alerts, 0)
  eq('掉到 59% → 不报（但重新武装）', r3.alerts, 0)
  eq('再涨回 66% → 再报一次', r4.alerts, 1)
  eq('共 2 行告警', readLines(alertsLog).length, 2)
}
{
  const d = mkRoot()
  const file = writeSession(d, 'session-hyst2', { pressure: 660 })
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, hysteresis: 5, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r1 = m.scanOnce() // 报
  patchSession(file, { pressure: 610 }) // 61 ≥ 65-5=60 → 不算掉够
  const r2 = m.scanOnce()
  patchSession(file, { pressure: 660 })
  const r3 = m.scanOnce()
  eq('61% 掉得不够 → 不重新武装', r2.alerts, 0)
  eq('回到 66% 也不再报（迟滞未复位）', r3.alerts, 0)
  eq('alerts 合计 1', r1.alerts + r2.alerts + r3.alerts, 1)
}

// ── 4. mtime 缓存：没变的文件不重解析 ──────────────────────────────────────
console.log('4. mtime 缓存')
{
  const d = mkRoot()
  const f1 = writeSession(d, 'session-c1', { pressure: 100 })
  writeSession(d, 'session-c2', { pressure: 200 })
  writeSession(d, 'session-c3', { pressure: 300 })
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r1 = m.scanOnce()
  const r2 = m.scanOnce()
  eq('首轮 reparsed=3', r1.reparsed, 3)
  eq('首轮 cached=0', r1.cached, 0)
  eq('次轮 reparsed=0（全命中缓存）', r2.reparsed, 0)
  eq('次轮 cached=3', r2.cached, 3)
  patchSession(f1, { pressure: 100, title: 'changed' })
  const r3 = m.scanOnce()
  eq('改 1 个文件后 reparsed=1', r3.reparsed, 1)
  eq('其余 2 个走缓存 cached=2', r3.cached, 2)
  eq('缓存条数=3', m.cacheSize(), 3)
  ok('改过的 title 生效', r3.rows.find((x) => x.sessionId === 'session-c1').title === 'changed')
  // CLI 输出里必须能看到本轮重解析数量
  const cli = runCli(['--once', '--dir=' + d, '--alerts-log=' + join(d, 'a2.log'), '--ingress=' + join(d, 'i2.jsonl'), '--dry-run'])
  ok('--once 文本输出含 reparsed=', /reparsed=\d+/.test(cli.stdout), cli.stdout.slice(0, 200))
  ok('--once 文本输出含 cached=', /cached=\d+/.test(cli.stdout))
  ok('--once 文本输出含 elapsed=', /elapsed=[\d.]+ms/.test(cli.stdout))
  ok('--once 退出码 0', cli.status === 0, 'status=' + cli.status + ' stderr=' + cli.stderr.slice(0, 300))
}
{
  // 每 N 轮无条件全量重解析（防 mtimeMs+size 同值漏检）
  const d = mkRoot()
  writeSession(d, 'session-f1', { pressure: 100 })
  writeSession(d, 'session-f2', { pressure: 200 })
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, fullReparseEvery: 2 , root: TEST_WS_ROOT })
  const r1 = m.scanOnce()
  const r2 = m.scanOnce()
  const r3 = m.scanOnce()
  eq('轮 1 全解析 reparsed=2', r1.reparsed, 2)
  eq('轮 2 到点全量兜底 reparsed=2', r2.reparsed, 2)
  ok('轮 2 标了 forceFull', r2.forceFull === true)
  eq('轮 3 回到缓存 reparsed=0', r3.reparsed, 0)
  ok('轮 3 没标 forceFull', r3.forceFull === false)
}

// ── 5. 坏文件：跳过不崩、下轮重试、修好后正常 ──────────────────────────────
console.log('5. 坏文件')
{
  const d = mkRoot()
  writeSession(d, 'session-good', { pressure: 100 })
  const bad = join(d, 'session-bad.json')
  writeFileSync(bad, '{bad json', 'utf8')
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  let r = null
  let threw = null
  try { r = m.scanOnce() } catch (e) { threw = e }
  ok('坏 JSON 不抛异常', threw === null, threw && threw.message)
  eq('正常会话仍被解析（rows=1）', r ? r.rows.length : -1, 1)
  eq('errors=1', r ? r.errors : -1, 1)
  const r2 = m.scanOnce()
  eq('坏文件下轮仍重试（errors=1）', r2.errors, 1)
  writeFileSync(bad, JSON.stringify(buildSession({ pressure: 700 })), 'utf8')
  const t = new Date(1700000000000 + (++tick) * 60000)
  utimesSync(bad, t, t)
  const r3 = m.scanOnce()
  eq('修好后 rows=2', r3.rows.length, 2)
  eq('修好后 errors=0', r3.errors, 0)
}
{
  // 结构不全（无 contextPressure）也要跳过而不是崩
  const d = mkRoot()
  writeSession(d, 'session-nocp', { noPressure: true, title: 'no pressure yet' })
  writeSession(d, 'session-ok2', { pressure: 100 })
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  eq('无压采的会话被跳过（rows=1）', r.rows.length, 1)
  eq('skipped=1', r.skipped, 1)
}

// ── 6. 报警落盘：ctx-alerts.log 一行 JSON + ingress 一条事件 ───────────────
console.log('6. 报警落盘')
{
  const d = mkRoot()
  const alertsLog = join(d, 'out', 'ctx-alerts.log')
  const ingressFile = join(d, 'out', 'ingress.jsonl')
  writeSession(d, 'session-ctxmon-test-a-1111', { pressure: 700, cwd: join(TEST_WS_ROOT), title: '报警用例' })
  const cli = runCli(['--once', '--dir=' + d, '--alerts-log=' + alertsLog, '--ingress=' + ingressFile, '--cooldown-min=0', '--owner-session=' + OWNER_SESSION, '--root=' + TEST_WS_ROOT])
  ok('退出码 0', cli.status === 0, 'status=' + cli.status + ' stderr=' + cli.stderr.slice(0, 300))
  const al = readLines(alertsLog)
  eq('ctx-alerts.log 写了 1 行', al.length, 1)
  let a = null
  try { a = JSON.parse(al[0] || '{}') } catch {}
  ok('告警行是合法 JSON', !!a)
  for (const k of ['at', 'sessionId', 'cwd', 'title', 'provider', 'model', 'pct', 'threshold', 'window', 'pressure']) {
    ok('告警行字段 ' + k, a && Object.prototype.hasOwnProperty.call(a, k), JSON.stringify(a))
  }
  eq('level=warn', a && a.level, 'warn')
  eq('pct=70', a && a.pct, 70)
  eq('threshold=65', a && a.threshold, 65)
  eq('window=1000', a && a.window, 1000)
  eq('pressure=700', a && a.pressure, 700)
  eq('cwd 透传', a && a.cwd, TEST_WS_ROOT)
  const ig = readLines(ingressFile)
  eq('ingress 写了 1 条', ig.length, 1)
  let i = null
  try { i = JSON.parse(ig[0] || '{}') } catch {}
  ok('ingress 是合法 JSON', !!i)
  eq('ingress source=ctx-monitor', i && i.source, 'ctx-monitor')
  eq('ingress type=test', i && i.type, 'test')
  eq('ingress 投给 owner 会话', i && i.sessionId, OWNER_SESSION)
  ok('ingress key 形如 ctx:<sid>:<分钟>', /^ctx:[^:]+:\d+$/.test(String(i && i.key)), String(i && i.key))
  const minute = Math.floor(Date.now() / 60000)
  const km = Number(String(i && i.key).split(':').pop())
  ok('key 分钟桶是当前分钟（±1）', Math.abs(km - minute) <= 1, 'key=' + (i && i.key) + ' now=' + minute)
  ok('title 含【上下文告警】', String(i && i.title).includes('【上下文告警】'))
  ok('title 含阈值 65%', String(i && i.title).includes('阈值 65%'))
  ok('body 含 pct=70%', String(i && i.body).includes('pct=70%'), String(i && i.body))
  ok('body 含 pressure=700/1000', String(i && i.body).includes('pressure=700/1000'))
  const bodyLine = String(i && i.body).split('\n')[0]
  ok('body 第一行就是固定格式摘要', /^\[ctx\] \S+ deepseek-account\/deepseek-flash 70\.0% \(阈值 65%, 已越线\)$/.test(bodyLine), bodyLine)
}
{
  // --no-ingress：只写 alerts log，不碰 ingress
  const d = mkRoot()
  const alertsLog = join(d, 'ctx-alerts.log')
  const ingressFile = join(d, 'ingress.jsonl')
  writeSession(d, 'session-noing', { pressure: 700 })
  const cli = runCli(['--once', '--dir=' + d, '--alerts-log=' + alertsLog, '--ingress=' + ingressFile, '--cooldown-min=0', '--no-ingress'])
  ok('--no-ingress 退出码 0', cli.status === 0, cli.stderr.slice(0, 200))
  eq('--no-ingress 仍写告警（1 行）', readLines(alertsLog).length, 1)
  ok('--no-ingress 没写 ingress', !existsSync(ingressFile))
}

// ── 6b. --dry-run 不写任何文件 ─────────────────────────────────────────────
console.log('6b. --dry-run')
{
  const d = mkRoot()
  const alertsLog = join(d, 'ctx-alerts.log')
  const ingressFile = join(d, 'ingress.jsonl')
  writeFileSync(alertsLog, 'SENTINEL-A\n', 'utf8')
  writeFileSync(ingressFile, 'SENTINEL-I\n', 'utf8')
  const before = { a: statSync(alertsLog).size, i: statSync(ingressFile).size }
  writeSession(d, 'session-dry', { pressure: 900 })
  const cli = runCli(['--once', '--dir=' + d, '--alerts-log=' + alertsLog, '--ingress=' + ingressFile, '--cooldown-min=0', '--dry-run'])
  ok('--dry-run 退出码 0', cli.status === 0, cli.stderr.slice(0, 200))
  eq('dry-run 后 alerts log 未变', statSync(alertsLog).size, before.a)
  eq('dry-run 后 ingress 未变', statSync(ingressFile).size, before.i)
  eq('dry-run 后 alerts 文件内容原样', readFileSync(alertsLog, 'utf8'), 'SENTINEL-A\n')
  ok('dry-run 仍然计入 alerts（内存里）', /alerts=1/.test(cli.stdout), cli.stdout.slice(-300))
}
{
  // 目录里已有告警文件、dry-run 用不存在的路径 → 不许创建
  const d = mkRoot()
  writeSession(d, 'session-dry2', { pressure: 900 })
  const p1 = join(d, 'nope-a.log')
  const p2 = join(d, 'nope-i.jsonl')
  const cli = runCli(['--once', '--dir=' + d, '--alerts-log=' + p1, '--ingress=' + p2, '--dry-run'])
  ok('--dry-run 不创建 alerts 文件', !existsSync(p1))
  ok('--dry-run 不创建 ingress 文件', !existsSync(p2))
}

// ── 7. 低内存 / 及时：300 个假 session ─────────────────────────────────────
console.log('7. 300 个 session 的耗时与内存')
{
  const d = mkRoot()
  for (let i = 0; i < 300; i++) {
    writeSession(d, 'session-perf-' + String(i).padStart(3, '0'), {
      provider: i % 2 ? 'trae' : 'deepseek-account',
      model: i % 2 ? 'glm-5.3' : 'deepseek-flash',
      pressure: (i * 7) % 1000,
      pad: 2000,
    })
  }
  const heapBefore = process.memoryUsage().heapUsed
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 30 * 60000 , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  const heapAfter = process.memoryUsage().heapUsed
  const heapMB = heapAfter / 1024 / 1024
  eq('scanned=300', r.scanned, 300)
  eq('rows=300', r.rows.length, 300)
  ok('首轮耗时被记录（' + r.elapsedMs.toFixed(1) + 'ms）', Number.isFinite(r.elapsedMs) && r.elapsedMs > 0)
  ok('单轮 300 文件 < 5s', r.elapsedMs < 5000, r.elapsedMs.toFixed(1) + 'ms')
  ok('heapUsed < 100MB（' + heapMB.toFixed(1) + 'MB）', heapMB < 100, heapMB.toFixed(1) + 'MB')
  const r2 = m.scanOnce()
  ok('次轮更快（缓存命中，' + r2.elapsedMs.toFixed(1) + 'ms < ' + r.elapsedMs.toFixed(1) + 'ms）', r2.elapsedMs <= r.elapsedMs, '')
  ok('次轮 0 重解析', r2.reparsed === 0)
  console.log('  info heapBefore=' + (heapBefore / 1024 / 1024).toFixed(1) + 'MB heapAfter=' + heapMB.toFixed(1) +
    'MB first=' + r.elapsedMs.toFixed(1) + 'ms second=' + r2.elapsedMs.toFixed(1) + 'ms cache=' + m.cacheSize())
  const cli = runCli(['--once', '--json', '--dir=' + d, '--alerts-log=' + join(d, 'a2.log'), '--ingress=' + join(d, 'i2.jsonl'), '--dry-run'])
  let parsed = null
  try { parsed = JSON.parse(cli.stdout) } catch {}
  ok('--once --json 输出可解析', !!parsed, cli.stdout.slice(0, 200))
  eq('JSON scanned=300', parsed && parsed.scanned, 300)
  eq('JSON rows=300', parsed && parsed.rows.length, 300)
  ok('JSON 里有 elapsedMs', parsed && typeof parsed.elapsedMs === 'number')
  ok('JSON 行字段含 pct/threshold/window', parsed && parsed.rows.every((x) => 'pct' in x && 'threshold' in x && 'window' in x))
}

// ── 8. 常驻循环可优雅停（SIGINT 走的是同一个 stop 开关）────────────────────
console.log('8. 循环 / 优雅退出')
{
  const d = mkRoot()
  writeSession(d, 'session-loop', { pressure: 100 })
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const seen = []
  const sigBefore = process.listenerCount('SIGINT')
  let sigDuring = -1
  const r = await runLoop(m, { intervalMs: 5, maxRounds: 3, quiet: true, onRound: (res) => { seen.push(res.round); if (sigDuring < 0) sigDuring = process.listenerCount('SIGINT') } })
  eq('循环期间挂了 1 个 SIGINT 处理器', sigDuring, sigBefore + 1)
  eq('循环结束摘掉 SIGINT 处理器', process.listenerCount('SIGINT'), sigBefore)
  const rNoSig = await runLoop(createMonitor({ dir: d, dryRun: true, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl') , root: TEST_WS_ROOT }), { intervalMs: 5, maxRounds: 1, quiet: true, noSignals: true })
  eq('noSignals 不挂处理器也能跑', rNoSig.rounds, 1)
  eq('跑满 3 轮', r.rounds, 3)
  eq('round 序号连续', seen.join(','), '1,2,3')
  const seen2 = []
  const r2 = await runLoop(m, { intervalMs: 5, maxRounds: 10, quiet: true, noSignals: true, onRound: (res) => { seen2.push(res.round); return false } })
  eq('onRound 返回 false 立即停（1 轮）', r2.rounds, 1)
  eq('第二轮只跑 1 次回调', seen2.length, 1)
  // 真的发一次 SIGINT 事件：handler → stop → 打断 sleep → 正常返回（Windows 下没法从外部真按 Ctrl+C，这里验证整条停止路径）
  const m3 = createMonitor({ dir: d, dryRun: true, alertsLog: join(d, 'c.log'), ingressFile: join(d, 'i3.jsonl') , root: TEST_WS_ROOT })
  const loopP = runLoop(m3, { intervalMs: 40, maxRounds: 100, quiet: true })
  setTimeout(() => { process.emit('SIGINT') }, 60)
  const rSig = await loopP
  ok('收到 SIGINT 后优雅退出（跑了 ' + rSig.rounds + ' 轮，< 100）', rSig.rounds < 100, 'rounds=' + rSig.rounds)
  eq('优雅退出标记 stopped=true', rSig.stopped, true)
  eq('退出后没残留 SIGINT 处理器', process.listenerCount('SIGINT'), sigBefore)
}

// ── 9. 扫描范围：只限 subagent 工区 ────────────────────────────────────────
console.log('9. 扫描范围（只限 subagent 工区）')
{
  const d = mkRoot()
  writeSession(d, 'session-in-worker', { pressure: 100, cwd: join(TEST_WS_ROOT) })
  writeSession(d, 'session-in-test', { pressure: 100, cwd: join(TEST_WS_ROOT, 'test') })
  writeSession(d, 'session-in-root', { pressure: 100, cwd: TEST_WS_ROOT })
  writeSession(d, 'session-in-upper', { pressure: 100, cwd: TEST_WS_ROOT.toUpperCase() + sep + 'JUDGE' })
  writeSession(d, 'session-fwd', { pressure: 100, cwd: join(TEST_WS_ROOT, 'worker_1') + '/' })
  writeSession(d, 'session-out-similar', { pressure: 100, cwd: join(TEST_WS_ROOT) + 'X' + sep + 'worker' })
  // 本意是「别的工区」：放在 root 的同级兄弟目录（不在 root 之下）
  writeSession(d, 'session-out-plugin', { pressure: 910, cwd: join(dirname(TEST_WS_ROOT), 'outside-ws') })
  writeSession(d, 'session-out-other', { pressure: 910, cwd: join(dirname(TEST_WS_ROOT), 'some-other-project') })
  writeSession(d, 'session-no-cwd', { pressure: 910, cwd: '' })
  const alertsLog = join(d, 'a.log')
  const m = createMonitor({ dir: d, alertsLog, ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  const ids = new Set(r.rows.map((x) => x.sessionId))
  ok('worker_1 在范围内', ids.has('session-in-worker'))
  ok('test 在范围内', ids.has('session-in-test'))
  ok('root 本身在范围内', ids.has('session-in-root'))
  ok('大小写不同也在范围内', ids.has('session-in-upper'))
  ok('正斜杠/尾斜杠也在范围内', ids.has('session-fwd'))
  ok('subagentX 前缀不算（要分隔符边界）', !ids.has('session-out-similar'))
  ok('另一个工区被跳过（范围外）', !ids.has('session-out-plugin'))
  ok('另一个目录被跳过', !ids.has('session-out-other'))
  ok('空 cwd 被跳过', !ids.has('session-no-cwd'))
  eq('outOfScope=4', r.outOfScope, 4)
  eq('范围外高占用不报警', r.alerts, 0)
  ok('范围外不写告警文件', !existsSync(alertsLog))
  eq('scanned 仍是全部 9 个文件', r.scanned, 9)
  eq('跳过数含范围外（4）', r.skipped, 4)
  eq('inScope 单元：worker_1', inScope(join(TEST_WS_ROOT, 'worker_1'), TEST_WS_ROOT), true)
  eq('inScope 单元：前缀陷阱', inScope(join(TEST_WS_ROOT) + 'X', TEST_WS_ROOT), false)
  eq('inScope 单元：尾斜杠', inScope(TEST_WS_ROOT.replace(/\\/g, '/') + '/', TEST_WS_ROOT), true)
}
{
  // --root 覆盖
  const d = mkRoot()
  writeSession(d, 'session-p', { pressure: 100, cwd: join(dirname(TEST_WS_ROOT), 'some-other-project', 'live') })
  writeSession(d, 'session-q', { pressure: 100, cwd: join(TEST_WS_ROOT) })
  const m = createMonitor({ dir: d, root: join(dirname(TEST_WS_ROOT), 'some-other-project'), alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0 })
  const r = m.scanOnce()
  eq('--root 覆盖后只留 1 个', r.rows.length, 1)
  eq('留下的是 other 会话', r.rows[0] ? r.rows[0].sessionId : '', 'session-p')
}

// ── 10. 静默轮询（只在越阈值时输出）/ --verbose ─────────────────────────────
console.log('10. 静默轮询 / --verbose')
{
  const d = mkRoot()
  writeSession(d, 'session-quiet', { pressure: 100 })
  writeSession(d, 'session-hotq', { pressure: 900 })
  const origWrite = process.stdout.write.bind(process.stdout)
  const capture = () => {
    let buf = ''
    process.stdout.write = (chunk) => { buf += String(chunk); return true }
    return {
      stop: () => { process.stdout.write = origWrite; return buf },
    }
  }
  // 只有 session-hotq 越线（90%），session-quiet 不越
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, ownerSession: OWNER_SESSION , root: TEST_WS_ROOT })
  let cap = capture()
  let rq
  try { rq = await runLoop(m, { intervalMs: 5, maxRounds: 2, noSignals: true }) } finally { }
  const outQuiet = cap.stop()
  eq('静默模式跑满 2 轮', rq.rounds, 2)
  ok('静默模式没有 round= 刷屏', !outQuiet.includes('round='), outQuiet.slice(0, 200))
  ok('静默模式只输出越线那条 ALERT', (outQuiet.match(/ALERT/g) || []).length === 1 && outQuiet.includes('[ctx]'), outQuiet)
  ok('ALERT 行格式是 [ctx] ...', /\[ctx-monitor\] ALERT \[ctx\] \S+ /.test(outQuiet), outQuiet)
  // 不越线时彻底静默
  const d2 = mkRoot()
  writeSession(d2, 'session-quiet2', { pressure: 100 })
  const m2 = createMonitor({ dir: d2, alertsLog: join(d2, 'a.log'), ingressFile: join(d2, 'i.jsonl'), cooldownMs: 0 , root: TEST_WS_ROOT })
  cap = capture()
  let rq2
  try { rq2 = await runLoop(m2, { intervalMs: 5, maxRounds: 3, noSignals: true }) } finally { }
  const outEmpty = cap.stop()
  eq('不越线跑 3 轮', rq2.rounds, 3)
  eq('不越线时标准输出为空', outEmpty, '')
  // --verbose 打每轮耗时 + stop 行
  const m3 = createMonitor({ dir: d2, alertsLog: join(d2, 'b.log'), ingressFile: join(d2, 'i2.jsonl'), cooldownMs: 0 , root: TEST_WS_ROOT })
  cap = capture()
  let rq3
  try { rq3 = await runLoop(m3, { intervalMs: 5, maxRounds: 2, noSignals: true, verbose: true }) } finally { }
  const outVerbose = cap.stop()
  ok('--verbose 打每轮耗时', /round=1 .*elapsed=[\d.]+ms/.test(outVerbose), outVerbose.slice(0, 300))
  ok('--verbose 打 stop 行', /stop rounds=2/.test(outVerbose))
}

// ── 11. --session-line 固定格式（只读）────────────────────────────────────
console.log('11. --session-line')
{
  const d = mkRoot()
  const sid = 'session-ctxmon-test-b-2222'
  const alertsLog = join(d, 'a.log')
  const ingressFile = join(d, 'i.jsonl')
  writeSession(d, sid, { pressure: 700, cwd: join(TEST_WS_ROOT) })
  writeSession(d, 'session-cool', { pressure: 300, cwd: join(TEST_WS_ROOT, 'test') })
  const cli = runCli(['--dir=' + d, '--alerts-log=' + alertsLog, '--ingress=' + ingressFile, '--session-line=' + sid])
  ok('exit=0', cli.status === 0, 'status=' + cli.status + ' stderr=' + cli.stderr.slice(0, 200))
  const line = cli.stdout.trim()
  ok('已越线行格式固定', /^\[ctx\] \S+ deepseek-account\/deepseek-flash 70\.0% \(阈值 65%, 已越线\)$/.test(line), line)
  const cli2 = runCli(['--dir=' + d, '--alerts-log=' + alertsLog, '--ingress=' + ingressFile, '--session-line=session-cool'])
  ok('未越线不带「已越线」', /^\[ctx\] \S+ deepseek-account\/deepseek-flash 30\.0% \(阈值 65%\)$/.test(cli2.stdout.trim()), cli2.stdout.trim())
  const cli3 = runCli(['--dir=' + d, '--alerts-log=' + alertsLog, '--ingress=' + ingressFile, '--session-line=cool'])
  ok('短号也能查到', cli3.status === 0 && cli3.stdout.includes('30.0%'), cli3.stdout.trim())
  const cli4 = runCli(['--dir=' + d, '--alerts-log=' + alertsLog, '--ingress=' + ingressFile, '--session-line=session-not-exist'])
  ok('查不到 → exit=1', cli4.status === 1, 'status=' + cli4.status)
  ok('--session-line 不写任何文件', !existsSync(alertsLog) && !existsSync(ingressFile))
  // 单元：sessionLine 与阈值
  const m = createMonitor({ dir: d, alertsLog, ingressFile, cooldownMs: 0, dryRun: true , root: TEST_WS_ROOT })
  const res = m.scanOnce()
  const rec = res.rows.find((x) => x.sessionId === sid)
  eq('sessionLine 单元输出', sessionLine(rec), '[ctx] ctxmon-t…2222 deepseek-account/deepseek-flash 70.0% (阈值 65%, 已越线)')
}

// ── 12. --daemon：pid 文件 + ctx-alerts.log 轮转 ───────────────────────────
console.log('12. --daemon / pid 文件 / 轮转')
{
  const d = mkRoot()
  writeSession(d, 'session-d', { pressure: 100 })
  const pidFile = join(d, 'run', 'ctx-monitor.pid')
  const m = createMonitor({ dir: d, alertsLog: join(d, 'a.log'), ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, pidFile , root: TEST_WS_ROOT })
  // 已有活着的实例 → 拒绝启动，pid 文件不被改坏（用一个真活着的子进程 pid，不用自己的 pid）
  mkdirSync(dirname(pidFile), { recursive: true })
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 500))
  writeFileSync(pidFile, String(sleeper.pid) + '\n', 'utf8')
  const bad = await runDaemon(m, { pidFile, maxRounds: 1, intervalMs: 5, quiet: true, noSignals: true })
  ok('已有实例 → pidConflict', bad.pidConflict === true, 'pidConflict=' + JSON.stringify(bad))
  eq('pid 文件没被改坏', readFileSync(pidFile, 'utf8').trim(), String(sleeper.pid))
  try { sleeper.kill() } catch {}
  rmSync(pidFile)
  const okRun = await runDaemon(m, { pidFile, maxRounds: 2, intervalMs: 5, quiet: true, noSignals: true })
  eq('清掉 pid 后跑满 2 轮', okRun.rounds, 2)
  ok('退出后 pid 文件已清理', !existsSync(pidFile))
  // 残留的旧 pid（进程已不在）→ 覆盖后能跑
  writeFileSync(pidFile, '999999\n', 'utf8')
  const okRun2 = await runDaemon(m, { pidFile, maxRounds: 1, intervalMs: 5, quiet: true, noSignals: true })
  eq('残留 pid 覆盖后能跑', okRun2.rounds, 1)
  ok('退出后仍清理 pid', !existsSync(pidFile))
}
{
  const d = mkRoot()
  const log = join(d, 'ctx-alerts.log')
  const big = 1024 * 1024 + 10
  writeFileSync(log, 'x'.repeat(big), 'utf8')
  const rot = rotateAlertsLog(log, 1024 * 1024)
  ok('超 1MB 触发轮转', rot.rotated === true)
  ok('.1 存在且大小等于原文件', existsSync(log + '.1') && statSync(log + '.1').size === big)
  ok('新日志文件此时不存在（等下一条报警）', !existsSync(log))
  writeSession(d, 'session-rot', { pressure: 700 })
  const m = createMonitor({ dir: d, alertsLog: log, ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, rotateBytes: 1024 * 1024 , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  ok('轮转后新报警写进新文件', r.alerts >= 1 && readLines(log).length === 1, 'alerts=' + r.alerts)
  eq('旧内容没丢', statSync(log + '.1').size, big)
}
{
  // 报警写入时自动轮转（log 已经超限、有会话越线）
  const d = mkRoot()
  const log = join(d, 'ctx-alerts.log')
  const big = 1024 * 1024 + 10
  writeFileSync(log, 'y'.repeat(big), 'utf8')
  writeSession(d, 'session-autorot', { pressure: 700 })
  const m = createMonitor({ dir: d, alertsLog: log, ingressFile: join(d, 'i.jsonl'), cooldownMs: 0, rotateBytes: 1024 * 1024 , root: TEST_WS_ROOT })
  const r = m.scanOnce()
  ok('报警时自动轮转：新文件 1 行 + .1 存在', r.alerts === 1 && readLines(log).length === 1 && existsSync(log + '.1'), 'alerts=' + r.alerts + ' lines=' + readLines(log).length)
  eq('自动轮转后 .1 保留原内容', statSync(log + '.1').size, big)
}

for (const d of roots) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
if (usedFallbackTmp) { try { rmSync(join(process.cwd(), '.ctxmon-tmp'), { recursive: true, force: true }) } catch {} }

console.log('')
if (failures.length) {
  console.log('ctx-monitor: FAIL ' + failures.length)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
} else {
  console.log('ctx-monitor: ALL PASS')
}
