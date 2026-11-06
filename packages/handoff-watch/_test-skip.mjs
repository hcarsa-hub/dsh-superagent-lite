
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWatcher } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'w3-'))
const files = join(dir, 'files'); mkdirSync(files)
const saFile = join(files, 'sa-handoff.md')
const normalFile = join(files, 'normal-handoff.md')
writeFileSync(saFile, '# Handoff\n- sa-ticket: sa-901\n- backend: codex\n', 'utf8')
writeFileSync(normalFile, '# Handoff: normal task\n- 状态: done\n', 'utf8')
const events = join(dir, 'events.jsonl')
writeFileSync(events, JSON.stringify({ file: saFile, at: '2026-11-05T13:20:00Z' }) + '\n' + JSON.stringify({ file: normalFile, at: '2026-11-05T13:21:00Z' }) + '\n', 'utf8')

const delivered = []
const logs = []
const w = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: (m) => logs.push(m) })
await w.tick()
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); process.exitCode = 1 } else console.log('ok   ' + m) }
ok(delivered.length === 1, '只投递 1 条（普通 handoff），实投 ' + delivered.length)
ok(delivered[0] === normalFile, '投递的是普通 handoff')
ok(logs.some((l) => l.includes('skipped superagent handoff')), '日志记录 skipped superagent handoff')
ok(logs.some((l) => l.includes('delivered')), '普通 handoff 正常投递并记日志')
// 游标已推进：再 tick 不会重复投递
await w.tick()
ok(delivered.length === 1, '二次 tick 不重复投递')
// 新增一条带标记的：仍然跳过
writeFileSync(events, JSON.stringify({ file: saFile }) + '\n', 'utf8')
const w2 = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: (m) => logs.push(m) })
// 文件被原地重写（大小变化）→ 从 0 重读，但仍应跳过
await w2.tick()
ok(delivered.length === 1, '新实例重读同一条带标记事件仍不投递（实投 ' + delivered.length + '）')
rmSync(dir, { recursive: true, force: true })
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: ALL PASS')
