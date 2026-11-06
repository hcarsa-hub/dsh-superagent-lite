// sa-186 批B 回归：P01 行首锚定跳过 + P02 同内容去重 + cursor.deliveredFiles
// 全部在 mkdtempSync 临时目录里跑，不碰真实 handoff/queue。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createWatcher } from './index.js'

let fails = 0
const ok = (cond, msg) => {
  if (cond) console.log('ok   ' + msg)
  else { console.error('FAIL ' + msg); fails++ }
}

const newDir = () => mkdtempSync(join(tmpdir(), 'w4-batchB-'))

// ---------- 1. 锚定：正文引用不算标记 ----------
{
  const dir = newDir()
  const files = join(dir, 'files'); mkdirSync(files)
  const quoted = join(files, 'quoted.md')
  const marked = join(files, 'marked.md')
  // 正文里引用这句话（不在行首），必须被投递
  writeFileSync(quoted, '# Handoff: 说明格式\n\n本文档参考 sa-ticket: sa-999 的格式，实际不是工单 handoff。\n结尾。\n', 'utf8')
  // 行首带列表符，必须跳过
  writeFileSync(marked, '# Handoff\n- sa-ticket: sa-901\n- backend: codex\n', 'utf8')
  const events = join(dir, 'events.jsonl')
  const lines = [JSON.stringify({ file: quoted }), JSON.stringify({ file: marked })].join('\n') + '\n'
  writeFileSync(events, lines, 'utf8')
  const delivered = []
  const logs = []
  const w = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: (m) => logs.push(m) })
  await w.tick()
  ok(delivered.length === 1 && delivered[0] === quoted, '正文引用 sa-ticket 的 handoff 仍被投递（实投 ' + delivered.length + '）')
  ok(logs.some((l) => l.startsWith('skipped superagent handoff')), '行首 - sa-ticket: sa-901 被跳过并记日志')
  rmSync(dir, { recursive: true, force: true })
}

// ---------- 2. 同内容去重 + 内容变更后再投 ----------
{
  const dir = newDir()
  const files = join(dir, 'files'); mkdirSync(files)
  const f = join(files, 'same.md')
  const content1 = '# Handoff: 同一份内容\n- 状态: done\n'
  writeFileSync(f, content1, 'utf8')
  const events = join(dir, 'events.jsonl')
  // 同一文件内容写两次事件
  writeFileSync(events, JSON.stringify({ file: f }) + '\n' + JSON.stringify({ file: f }) + '\n', 'utf8')
  const delivered = []
  const logs = []
  const w = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: (m) => logs.push(m) })
  await w.tick()
  ok(delivered.length === 1, '同一文件同内容的两条事件只投 1 次（实投 ' + delivered.length + '）')
  ok(logs.some((l) => l.includes('skipped duplicate handoff')), '日志含 skipped duplicate handoff')
  // 内容变了 → 再写事件 → 应再投 1 次
  writeFileSync(f, content1 + '\n- 补充: 新内容\n', 'utf8')
  writeFileSync(events, JSON.stringify({ file: f }) + '\n', 'utf8')
  const w2 = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: (m) => logs.push(m) })
  await w2.tick()
  ok(delivered.length === 2, '内容变更后再写事件会再投 1 次（累计 ' + delivered.length + '）')
  rmSync(dir, { recursive: true, force: true })
}

// ---------- 3. cursor.deliveredFiles 落盘 + 重建实例仍去重 + 旧格式 cursor 可跑 ----------
{
  const dir = newDir()
  const f = join(dir, 'persist.md')
  writeFileSync(f, '# Handoff: 落盘验证\n', 'utf8')
  const events = join(dir, 'events.jsonl')
  writeFileSync(events, JSON.stringify({ file: f }) + '\n', 'utf8')
  const delivered = []
  const w = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: () => {} })
  await w.tick()
  ok(delivered.length === 1, '首次投递成功')
  const cursorPath = join(dir, 'cursor.json')
  const cursor = JSON.parse(readFileSync(cursorPath, 'utf8'))
  ok(typeof cursor.deliveredFiles === 'object' && cursor.deliveredFiles !== null, 'cursor.json 写入 deliveredFiles 字段')
  const key = resolve(f)
  const hex = cursor.deliveredFiles[key] || cursor.deliveredFiles[f]
  ok(typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex), 'deliveredFiles 存的是 sha256 十六进制（' + String(hex).slice(0, 8) + '…）')
  ok(typeof cursor.offset === 'number' && typeof cursor.mtimeMs === 'number', 'offset/mtimeMs 语义未变（仍在 cursor 里）')

  // 重建实例（新进程视角）→ 同内容再写事件仍去重
  const w2 = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: () => {} })
  writeFileSync(events, JSON.stringify({ file: f }) + '\n', 'utf8')
  await w2.tick()
  ok(delivered.length === 1, '重建 watcher 后同内容仍去重（累计 ' + delivered.length + '）')

  // 旧格式 cursor（只有 offset/mtimeMs）
  const dir2 = newDir()
  const g = join(dir2, 'old.md')
  writeFileSync(g, '# Handoff: 旧 cursor\n', 'utf8')
  writeFileSync(join(dir2, 'cursor.json'), JSON.stringify({ offset: 0, mtimeMs: 0, updatedAt: '2026-01-01T00:00:00.000Z' }, null, 1), 'utf8')
  writeFileSync(join(dir2, 'events.jsonl'), JSON.stringify({ file: g }) + '\n', 'utf8')
  const d2 = []
  const w3 = createWatcher({ queueDir: dir2, sessionId: 'test-session', deliver: async (rec) => { d2.push(rec.file) }, log: () => {} })
  await w3.tick()
  ok(d2.length === 1, '旧格式 cursor.json（无 deliveredFiles）仍能正常投递')
  const c2 = JSON.parse(readFileSync(join(dir2, 'cursor.json'), 'utf8'))
  ok(c2.deliveredFiles && typeof c2.deliveredFiles === 'object', '旧 cursor 跑完后被补上 deliveredFiles 字段')
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
}

// ---------- 4. 投递失败不记哈希（下轮仍重试） ----------
{
  const dir = newDir()
  const f = join(dir, 'fail.md')
  writeFileSync(f, '# Handoff: 会失败\n', 'utf8')
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ file: f }) + '\n', 'utf8')
  const logs = []
  let attempt = 0
  const deliverFail = async () => { attempt++; throw new Error('deliver boom') }
  const w = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: deliverFail, log: (m) => logs.push(m) })
  await w.tick()
  ok(attempt === 1, '第一次投递抛错被调用 1 次（不吞错）')
  ok(logs.some((l) => l.includes('deliver failed (will retry)')), '日志记 deliver failed (will retry)')
  const cursorAfterFail = join(dir, 'cursor.json')
  const hasFile = existsSync(cursorAfterFail)
  const cf = hasFile ? JSON.parse(readFileSync(cursorAfterFail, 'utf8')) : { deliveredFiles: {} }
  ok(!cf.deliveredFiles || Object.keys(cf.deliveredFiles).length === 0, '失败后 deliveredFiles 为空（不记哈希）')
  ok(typeof w.offset === 'number' && w.offset === 0, '失败后 offset 未推进（仍为 0）')
  // 下一轮重试：这轮的 deliver 成功，应该真投出去
  const okDeliver = async () => { attempt++ }
  const w2 = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: okDeliver, log: (m) => logs.push(m) })
  await w2.tick()
  ok(attempt === 2, '下一轮重新尝试投递（共 ' + attempt + ' 次）')
  const c2 = JSON.parse(readFileSync(cursorAfterFail, 'utf8'))
  ok(Object.keys(c2.deliveredFiles || {}).length === 1, '成功后这次才记哈希')
  rmSync(dir, { recursive: true, force: true })
}

// ---------- 5. deliveredFiles 只留最近 50 条 ----------
{
  const dir = newDir()
  const events = join(dir, 'events.jsonl')
  const delivered = []
  let body = ''
  for (let i = 0; i < 60; i++) {
    const f = join(dir, 'f' + i + '.md')
    writeFileSync(f, '# Handoff ' + i + ' ' + randomUUID() + '\n', 'utf8')
    body += JSON.stringify({ file: f }) + '\n'
  }
  writeFileSync(events, body, 'utf8')
  const w = createWatcher({ queueDir: dir, sessionId: 'test-session', deliver: async (rec) => { delivered.push(rec.file) }, log: () => {} })
  await w.tick()
  ok(delivered.length === 60, '60 条全部投递（实投 ' + delivered.length + '）')
  const c = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8'))
  const n = Object.keys(c.deliveredFiles || {}).length
  ok(n === 50, 'deliveredFiles 只保留最近 50 条（实有 ' + n + '）')
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails === 0 ? 'batch B: ALL PASS' : 'batch B: ' + fails + ' FAIL')
process.exit(fails === 0 ? 0 : 1)
