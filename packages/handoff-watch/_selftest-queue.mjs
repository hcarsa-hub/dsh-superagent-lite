
// 测试卫生（sa-188）：本自测一律在 mkdtempSync 临时目录里自建 queueDir + events.jsonl，
// 绝不往真实 handoff/queue 写任何事件（真实队列曾因此被污染、误投「handoff 就绪」提醒）。
// 跑完断言：真实 handoff/queue/events.jsonl 的字节数与 mtime 未变，断言结果输出到末行。
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PROD_QUEUE = join(homedir(), '.dsh', 'subagent', 'queue', 'events.jsonl')
// 记录真实队列基线（跑之前取，跑之后核对未被写脏）
const prodBefore = statSync(PROD_QUEUE)

// 所有写入都进临时目录
const q = mkdtempSync(join(tmpdir(), 'watch-selftest-'))
const d = join(q, 'selftest')
mkdirSync(d, { recursive: true })
const sa = join(d, 'sa-marker.md')
const normal = join(d, 'normal-handoff.md')
writeFileSync(sa, '# Handoff: superagent 工单 sa-999 — 自测\n\n- sa-ticket: sa-999\n- backend: codex\n', 'utf8')
writeFileSync(normal, '# Handoff: watcher3 自测普通 handoff\n\n- 状态: done\n- 期望：watcher3 投递一条「handoff 就绪」\n', 'utf8')
const now = new Date().toISOString()
appendFileSync(join(q, 'events.jsonl'), JSON.stringify({ file: sa, at: now, selftest: 'watch3-skip' }) + '\n' + JSON.stringify({ file: normal, at: now, selftest: 'watch3-deliver' }) + '\n', 'utf8')
console.log('appended 2 events at ' + now + ' (tmpdir=' + q + ')')

// 断言：真实队列未被写脏
const prodAfter = statSync(PROD_QUEUE)
const unchanged = prodAfter.size === prodBefore.size && prodAfter.mtimeMs === prodBefore.mtimeMs
console.log(unchanged
  ? `ASSERT PASS: 真实 handoff/queue/events.jsonl 未变（size=${prodAfter.size} mtimeMs=${prodAfter.mtimeMs}）`
  : `ASSERT FAIL: 真实队列被写脏！size ${prodBefore.size}->${prodAfter.size} mtimeMs ${prodBefore.mtimeMs}->${prodAfter.mtimeMs}`)
if (!unchanged) process.exitCode = 1
