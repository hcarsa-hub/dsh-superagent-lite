// panel27(#68)：归档证据列表/正文 + 回滚命令（纯函数 + host 路由 handler 集成，不启服务）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, listArchiveEvidence, readArchiveEvidence, writeRollbackCommand, readArchive, buildTickets } from './index.js'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); fails++ } else console.log('ok   ' + m) }
const base = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(base, '_test-arch-ev-'))

try {
  // ---------- 造数据
  mkdirSync(join(dir, 'archive', 'evidence', 'sa-041'), { recursive: true })
  mkdirSync(join(dir, 'archive', 'evidence', 'sa-042'), { recursive: true })
  writeFileSync(join(dir, 'archive', 'evidence', 'sa-041', 'b.txt'), 'second file')
  writeFileSync(join(dir, 'archive', 'evidence', 'sa-041', 'a.md'), 'hello archive')
  writeFileSync(join(dir, 'archive', 'evidence', 'sa-041', 'c.bin'), 'binary-ish')
  writeFileSync(join(dir, 'archive', 'evidence', 'sa-042', 'secret.md'), 'OTHER TICKET')
  writeFileSync(join(dir, 'archive', 'sa.json'), JSON.stringify({ prefix: 'sa', updatedAt: '2026-11-06T01:00:00.000Z', count: 2, tickets: [
    { id: 'sa-041', title: '归档一', state: 'done', updatedAt: '2026-11-05T00:00:00.000Z', artifacts: [{ name: 'a.md', rel: 'sa-041/a.md', bytes: 13 }] },
    { id: 'sa-042', title: '归档二', state: 'done', updatedAt: '2026-11-04T00:00:00.000Z', artifacts: [] },
  ] }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 2, seq: 41, tickets: [{ id: 'sa-043', title: '在跑的', state: 'queued', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', artifacts: [], history: [] }], outbox: [] }))
  mkdirSync(join(dir, 'commands'), { recursive: true })

  // ---------- 纯函数：列表
  const files = listArchiveEvidence(dir, 'sa-041')
  ok(files.length === 2, '列表：只认 md/txt，忽略 c.bin（实得 ' + files.length + '）')
  ok(files[0].name === 'a.md' && files[1].name === 'b.txt', '列表：按文件名排序')
  ok(files[0].fact === 'Fact-sa-041-01' && files[1].fact === 'Fact-sa-041-02', '列表：按钮名 Fact-<工单号>-<两位序号>')
  ok(files[0].bytes === 13, '列表：带字节数（' + files[0].bytes + '）')
  ok(listArchiveEvidence(dir, 'sa-999').length === 0, '列表：不存在的工单返回空')
  ok(listArchiveEvidence(dir, '../sa-041').length === 0, '列表：非法工单号返回空')

  // ---------- 纯函数：正文
  const doc = readArchiveEvidence(dir, 'sa-041', 'a.md')
  ok(doc.ok === true && doc.text === 'hello archive', '正文：读得到内容')
  ok(doc.relative === 'archive/evidence/sa-041/a.md', '正文：relative 是 archive/evidence/<id>/<file>')
  ok(doc.truncated === false && doc.bytes === 13, '正文：截断标记与字节数')
  const trav = readArchiveEvidence(dir, 'sa-041', '../sa-042/secret.md')
  ok(trav.ok === false && trav.code === 400, '正文：../ 越权被拒（400）')
  const miss = readArchiveEvidence(dir, 'sa-041', 'nope.md')
  ok(miss.ok === false && miss.code === 404, '正文：文件不存在（404）')
  const badId = readArchiveEvidence(dir, 'xx', 'a.md')
  ok(badId.ok === false && badId.code === 400, '正文：非法工单号（400）')

  // ---------- 纯函数：回滚命令
  const rb1 = writeRollbackCommand(dir, { ticketId: 'sa-041' })
  ok(rb1.ok === true && rb1.action === 'restore', '回滚：单条 → action=restore')
  const cmd1 = JSON.parse(readFileSync(rb1.file, 'utf8'))
  ok(cmd1.action === 'restore' && cmd1.ticketId === 'sa-041', '回滚：命令文件内容可被 lite 消费（action/ticketId）')
  const rb2 = writeRollbackCommand(dir, { all: true })
  // panel38/A18：全部回滚改「逐单 restore + ids/count 追溯」，不再写 restore-all
  ok(rb2.ok === true && rb2.action === 'restore' && Array.isArray(rb2.ids) && rb2.ids.join() === 'sa-041,sa-042' && rb2.count === 2, '回滚：全部 → 逐单 restore（ids 升序 = ' + (rb2.ids || []).join(',') + '）')
  const rb3 = writeRollbackCommand(dir, { ticketId: 'bad id' })
  ok(rb3.ok === false && rb3.code === 400, '回滚：非法工单号被拒（400）')

  // ---------- 路由 handler 集成（假 ctx / 假 req / 假 res）
  let handler = null
  const ctx = { inject: (names, cb) => cb({ effect: (fn) => { fn() }, webServer: { register: (r) => { handler = r.handler; return () => {} } } }) }
  apply(ctx, { stateDir: dir })
  ok(typeof handler === 'function', '路由：apply() 之后 handler 已注册')

  const call = (url, method = 'GET', body = null) => new Promise((resolve) => {
    const listeners = {}
    const req = {
      url, method,
      // sa-187 第二轮：P01 fail-closed 后写方法必须带合法头，假 req 补 headers（judge 批准改脚手架）
      headers: { 'content-type': 'application/json' },
      on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return req },
      destroy: () => {},
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader: (k, v) => { res.headers[k] = v },
      end: (txt) => { let parsed = null; try { parsed = JSON.parse(txt) } catch {} resolve({ status: res.statusCode, json: parsed, raw: txt }) },
    }
    const p = handler(req, res)
    setTimeout(() => {
      if (body !== null) { for (const fn of listeners.data || []) fn(Buffer.from(body)); }
      for (const fn of listeners.end || []) fn()
    }, 0)
    return p
  })

  const r1 = await call('/superagent/archive/evidence?ticketId=sa-041')
  ok(r1.status === 200 && r1.json.ok === true && r1.json.count === 2, '路由 GET 列表：200 + count=2')
  ok(r1.json.files[0].fact === 'Fact-sa-041-01', '路由 GET 列表：返回 Fact 按钮名')
  const r2 = await call('/superagent/archive/evidence?ticketId=sa-041&file=a.md')
  ok(r2.status === 200 && r2.json.text === 'hello archive', '路由 GET 正文：200 + 内容')
  const r3 = await call('/superagent/archive/evidence?ticketId=sa-041&file=' + encodeURIComponent('../sa-042/secret.md'))
  ok(r3.status === 400 && r3.json.ok === false, '路由 GET 正文：越权 400')
  const r4 = await call('/superagent/rollback', 'POST', JSON.stringify({ ticketId: 'sa-042' }))
  ok(r4.status === 200 && r4.json.action === 'restore', '路由 POST 回滚：200 + action=restore')
  const onDisk = readdirSync(join(dir, 'commands')).filter((n) => n.startsWith('restore-'))
  ok(onDisk.length >= 1, '路由 POST 回滚：commands 队列里真有文件（' + onDisk.length + '）')
  const r5 = await call('/superagent/rollback', 'POST', JSON.stringify({ all: true }))
  ok(r5.status === 200 && r5.json.action === 'restore' && r5.json.count === 2, '路由 POST 回滚全部：逐单 restore（count=2）')
  ok(readdirSync(join(dir, 'commands')).filter((n) => n.startsWith('restore-all')).length === 0, '路由 POST 回滚全部：不再写 restore-all 单条命令')
  const r6 = await call('/superagent/rollback', 'POST', 'not-json')
  ok(r6.status === 400, '路由 POST 回滚：坏 JSON → 400')
  const r7 = await call('/superagent/archive?q=041')
  ok(r7.status === 200 && r7.json.total === 1, '回归：归档查询仍可用（命中 1 条）')
  const r8 = await call('/superagent/tickets')
  ok(r8.status === 200 && r8.json.total === 1, '回归：tickets 仍可用')
  const r9 = await call('/superagent/nope')
  ok(r9.status === 404, '回归：未知路由 404')
} catch (e) {
  console.error('EXCEPTION ' + (e && e.stack ? e.stack : e)); fails++
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
console.log(fails === 0 ? '归档证据/回滚: ALL PASS' : '归档证据/回滚: ' + fails + ' FAILED')
process.exit(fails === 0 ? 0 : 1)
