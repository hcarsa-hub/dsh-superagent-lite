// panel32：完成单「归档」按钮的后端 —— POST /superagent/archive-one 只写 commands 队列
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, writeArchiveCommand } from './index.js'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); fails++ } else console.log('ok   ' + m) }
const base = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(base, '_test-archone-'))
try {
  mkdirSync(join(dir, 'commands'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 2, seq: 3, tickets: [{ id: 'sa-003', state: 'done', title: 'x', artifacts: [], history: [] }], outbox: [] }))

  const r1 = writeArchiveCommand(dir, 'sa-003')
  ok(r1.ok === true, 'writeArchiveCommand 成功')
  const f1 = JSON.parse(readFileSync(r1.file, 'utf8'))
  ok(f1.action === 'archive' && f1.ticketId === 'sa-003', '命令内容 action=archive + ticketId')
  ok(f1.by === 'panel', 'by=panel（面板不直接写 state）')

  const r2 = writeArchiveCommand(dir, 'bad id')
  ok(r2.ok === false && r2.code === 400, '非法工单号被拒 400')

  // 路由集成
  let handler = null
  apply({ inject: (n, cb) => cb({ effect: (fn) => fn(), webServer: { register: (r) => { handler = r.handler; return () => {} } } }) }, { stateDir: dir })
  ok(typeof handler === 'function', '路由注册成功')
  const call = (url, method = 'GET', body = null) => new Promise((resolve) => {
    const L = {}
    // sa-187 第二轮：P01 fail-closed 后写方法必须带合法头，假 req 补 headers（judge 批准改脚手架）
    const req = { url, method, headers: { 'content-type': 'application/json' }, on: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return req }, destroy: () => {} }
    const res = { statusCode: 0, setHeader: () => {}, end: (txt) => { let j = null; try { j = JSON.parse(txt) } catch {} resolve({ status: res.statusCode, json: j }) } }
    handler(req, res)
    setTimeout(() => { if (body !== null) for (const fn of L.data || []) fn(Buffer.from(body)); for (const fn of L.end || []) fn() }, 0)
  })
  const before = readdirSync(join(dir, 'commands')).filter((n) => n.startsWith('archive-')).length
  const r3 = await call('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-003' }))
  ok(r3.status === 200 && r3.json.ok === true && r3.json.ticketId === 'sa-003', 'POST /archive-one 返回 200')
  const after = readdirSync(join(dir, 'commands')).filter((n) => n.startsWith('archive-')).length
  ok(after === before + 1, 'commands 里多了一条 archive 命令（' + before + ' -> ' + after + '）')
  const r4 = await call('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: '../x' }))
  ok(r4.status === 400, 'POST 非法工单号 400')
  const r5 = await call('/superagent/archive-one', 'GET')
  ok(r5.status === 404, 'GET 该路径 404（只收 POST）')
} catch (e) {
  console.error('EXCEPTION ' + (e && e.stack ? e.stack : e)); fails++
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
console.log(fails === 0 ? '归档按钮端点: ALL PASS' : '归档按钮端点: ' + fails + ' FAILED')
process.exit(fails === 0 ? 0 : 1)
