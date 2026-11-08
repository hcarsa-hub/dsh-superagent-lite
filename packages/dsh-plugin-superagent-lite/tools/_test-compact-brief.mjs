// _test-compact-brief.mjs —— 压缩后自检：简报文本 + 回落检出（2026-11-09 用户要求）
// 用法：node handoff/tools/_test-compact-brief.mjs   → 末行 ALL PASS / FAIL
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactBrief, createMonitor } from './ctx-monitor.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// ── 1 简报文本：judge 版必须写清三件事 ──
const j = compactBrief('judge')
ok('brief/judge 摘要不可信', j.includes('摘要一律不可信'))
ok('brief/judge done 单可置信', j.includes('已经 done 的工单不用重审') && j.includes('可置信'))
ok('brief/judge 核对证据即可', j.includes('核对那张单的证据本身'))
ok('brief/worker 不串 judge 段', !compactBrief('worker').includes('你是 judge'))
ok('brief/all 两段都在', compactBrief('all').includes('你是 judge') && compactBrief('all').includes('你是 worker'))

// ── 2 回落检出：两轮 pct 60% → 20% 必须写一条【压缩后自检】 ──
const tmp = mkdtempSync(join(tmpdir(), 'ctx-compact-'))
const dir = join(tmp, 'sessions')
mkdirSync(dir, { recursive: true })
const cwd = join(tmp, 'judge')
const mkCache = (tokens) => JSON.stringify({
  record: {
    identity: { cwd },
    rows: {
      contextPressure: { val: { contextWindow: 1000000, pressureTokens: tokens } },
      modelSelection: { val: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } } },
      title: { val: 'judge_1' },
    },
  },
})
const cacheFile = join(dir, 'session-testjudge.json')
const ingress = join(tmp, 'ingress.jsonl')
const alerts = join(tmp, 'ctx-alerts.log')
writeFileSync(cacheFile, mkCache(600000), 'utf8')

const monitor = createMonitor({
  dir, root: tmp,
  alertsLog: alerts, ingressFile: ingress,
  thresholdDs: 65, thresholdOther: 85, cooldownMs: 0, fullReparseEvery: 0,
  ownerSession: 'session-testowner000', // 分发包里 owner 由 --owner-session 提供；本机版忽略这项
})
const r1 = monitor.scanOnce()
ok('scan1 无压缩事件', (r1.compactions || 0) === 0)
ok('scan1 不越阈值（60% < 65%）', (r1.alerts || 0) === 0, 'alerts=' + r1.alerts)

writeFileSync(cacheFile, mkCache(200000), 'utf8') // 600k → 200k：pct 60% → 20%
const r2 = monitor.scanOnce()
ok('scan2 检出压缩', (r2.compacted || []).includes('session-testjudge'), JSON.stringify(r2.compacted))

const lines = readFileSync(ingress, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const ev = lines.find((e) => String(e.key || '').startsWith('ctx-compact:'))
ok('写了一条 ingress 事件', !!ev)
ok('标题是【压缩后自检】', !!ev && ev.title.includes('【压缩后自检】'), ev && ev.title)
ok('body 带 judge 简报', !!ev && ev.body.includes('已经 done 的工单不用重审') && ev.body.includes('摘要一律不可信'))
ok('事件投给 owner', !!ev && String(ev.sessionId || '').startsWith('session-'), ev && ev.sessionId)
ok('body 记了压缩前后 pct', !!ev && ev.body.includes('（压缩前 60.0%）'), ev && ev.body.split('\n').slice(0, 4).join(' | '))
ok('alerts 日志有 compaction 级', readFileSync(alerts, 'utf8').includes('"level":"compaction"'))

// ── 3 回落幅度不足不误报 ──
writeFileSync(cacheFile, mkCache(190000), 'utf8') // 20% → 19%，只掉 1 个点
const r3 = monitor.scanOnce()
ok('小波动不误报', (r3.compactions || 0) === 0, JSON.stringify(r3.compacted))

rmSync(tmp, { recursive: true, force: true })
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAIL') + ' (' + pass + ' pass / ' + fail + ' fail)')
process.exit(fail === 0 ? 0 : 1)
