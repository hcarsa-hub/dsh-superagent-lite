// sa-187 批C：P01 Origin/content-type 纵深 + P02 归档双目录去重 + P03 verdict 路由
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, readArchive } from './index.js'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); fails++ } else console.log('ok   ' + m) }
const base = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(base, '_test-batchc-'))
try {
  mkdirSync(join(dir, 'commands'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 2, seq: 1, tickets: [{ id: 'sa-001', state: 'done', title: 'x', artifacts: [], history: [] }], outbox: [] }))

  let handler = null
  apply({ inject: (n, cb) => cb({ effect: (fn) => fn(), webServer: { register: (r) => { handler = r.handler; return () => {} } } }) }, { stateDir: dir })
  ok(typeof handler === 'function', '路由注册成功')

  const call = (url, method = 'GET', body = null, headers = null) => new Promise((resolve) => {
    const L = {}
    const req = { url, method, headers: headers || {}, on: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return req }, destroy: () => {} }
    const res = { statusCode: 0, setHeader: () => {}, end: (txt) => { let j = null; try { j = JSON.parse(txt) } catch {} resolve({ status: res.statusCode, json: j }) } }
    handler(req, res)
    setTimeout(() => { if (body !== null) for (const fn of L.data || []) fn(Buffer.from(body)); for (const fn of L.end || []) fn() }, 0)
  })
  const cmds = () => readdirSync(join(dir, 'commands')).filter((n) => n.startsWith('archive-')).length

  // ---- P01：Origin 白名单 ----
  const n0 = cmds()
  const r1 = await call('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), { origin: 'http://evil.example', 'content-type': 'application/json' })
  ok(r1.status === 403 && r1.json.error === 'bad origin', 'P01 恶意 Origin POST → 403 bad origin')
  ok(cmds() === n0, 'P01 403 路径没有写 commands')
  const r2 = await call('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), { origin: 'http://127.0.0.1:61401', 'content-type': 'application/json' })
  ok(r2.status === 200 && r2.json.ok === true, 'P01 本机 Origin http://127.0.0.1:61401 放行 200')
  const r3 = await call('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), { 'content-type': 'application/json' })
  ok(r3.status === 200, 'P01 无 Origin 放行 200')

  // ---- P01：content-type ----
  const n1 = cmds()
  const r4 = await call('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), { origin: 'http://localhost:1', 'content-type': 'text/plain' })
  ok(r4.status === 415 && r4.json.error === 'content-type must be application/json', 'P01 POST text/plain → 415')
  ok(cmds() === n1, 'P01 415 路径没有写 commands')
  const r5 = await call('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), { origin: 'http://localhost:1', 'content-type': 'application/json; charset=utf-8' })
  ok(r5.status === 200 && r5.json.ok === true, 'P01 application/json; charset=utf-8 放行')
  // settings 的 POST 同样受 P01 管（brief 点名）
  const r6 = await call('/superagent/settings', 'POST', '{}', { origin: 'http://evil.example', 'content-type': 'application/json' })
  ok(r6.status === 403, 'P01 settings POST 恶意 Origin → 403')

  // ---- P02：readArchive 双目录去重 ----
  mkdirSync(join(dir, 'archive', 'tickets'), { recursive: true })
  mkdirSync(join(dir, 'archive', 'verdicts'), { recursive: true })
  writeFileSync(join(dir, 'archive', 'sa.json'), JSON.stringify({ prefix: 'sa', updatedAt: '2026-11-06T10:00:00.000Z', tickets: [{ id: 'sa-001', title: '旧标题', state: 'done', type: 'test', updatedAt: '2026-11-06T10:00:00.000Z' }, { id: 'sa-002', title: '仅旧目录', state: 'done', type: 'code', updatedAt: '2026-11-06T09:00:00.000Z' }] }))
  writeFileSync(join(dir, 'archive', 'tickets', 'sa-20261106-1700.json'), JSON.stringify({ prefix: 'sa', updatedAt: '2026-11-06T17:00:00.000Z', tickets: [{ id: 'sa-001', title: '新标题', state: 'done', type: 'test', updatedAt: '2026-11-06T17:00:00.000Z' }] }))
  const arch = readArchive(dir)
  ok(arch.filter((r) => r.id === 'sa-001').length === 1, 'P02 同 id 双目录只出一条')
  ok((arch.find((r) => r.id === 'sa-001') || {}).title === '新标题', 'P02 同 id 取 updatedAt 更新的（新标题）')
  ok(arch.some((r) => r.id === 'sa-002'), 'P02 旧目录文件仍可见')
  ok(arch.length === 2, 'P02 总数去重正确（2 张）')
  // 只有旧文件时行为不变
  mkdirSync(join(dir + '2', 'archive'), { recursive: true })
  writeFileSync(join(dir + '2', 'archive', 'sa.json'), JSON.stringify({ prefix: 'sa', updatedAt: '2026-11-06T10:00:00.000Z', tickets: [{ id: 'sa-009', title: 'only-old', state: 'done', type: 'test', updatedAt: '2026-11-06T10:00:00.000Z' }] }))
  const old2 = readArchive(dir + '2')
  ok(old2.length === 1 && old2[0].id === 'sa-009' && old2[0].title === 'only-old', 'P02 只有旧文件时与旧行为一致')

  // ---- P03：verdict 路由 ----
  writeFileSync(join(dir, 'archive', 'verdicts', 'sa-001.md'), '# 判词\n通过：证据齐全。')
  const v1 = await call('/superagent/archive/verdict?ticketId=sa-001')
  ok(v1.status === 200 && v1.json.ok === true && v1.json.ticketId === 'sa-001' && v1.json.text.includes('证据齐全'), 'P03 verdict 200 出正文')
  const v2 = await call('/superagent/archive/verdict?ticketId=../evil')
  ok(v2.status === 400 || v2.status === 403, 'P03 ../evil 被拒（' + v2.status + '）')
  const v3 = await call('/superagent/archive/verdict?ticketId=sa-999')
  ok(v3.status === 404 && v3.json.error === 'no-verdict', 'P03 不存在 → 404 no-verdict')
  const v4 = await call('/superagent/archive/verdict?ticketId=xyz')
  ok(v4.status === 400 && v4.json.error === 'bad ticketId', 'P03 非法 id → 400')

  // ---- 第二轮（judge 判 fail 修正）：fail-closed + Headers-like 兼容 ----
  const call2 = (url, method, body, headers) => new Promise((resolve) => {
    const L = {}
    // headers 传 undefined 时构造无 headers 字段的 req（复刻旧脚手架形态）
    const req = headers === undefined ? { url, method, on: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return req }, destroy: () => {} }
      : { url, method, headers, on: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return req }, destroy: () => {} }
    const res = { statusCode: 0, setHeader: () => {}, end: (txt) => { let j = null; try { j = JSON.parse(txt) } catch {} resolve({ status: res.statusCode, json: j }) } }
    handler(req, res)
    setTimeout(() => { if (body !== null) for (const fn of L.data || []) fn(Buffer.from(body)); for (const fn of L.end || []) fn() }, 0)
  })
  const n2 = cmds()
  const f1 = await call2('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), undefined)
  ok(f1.status === 415 && f1.json.error === 'content-type must be application/json', 'R2 无 headers 的 POST → 415（fail-closed，不再跳过校验）')
  ok(cmds() === n2, 'R2 415 路径没有写 commands')
  const f2 = await call2('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), { origin: 'http://evil.example' })
  ok(f2.status === 403 && f2.json.error === 'bad origin', 'R2 普通对象头 evil Origin → 403')
  const HL = (getMap) => ({ get: (k) => (k in getMap ? getMap[k] : null) })
  const f3 = await call2('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), HL({ origin: 'http://127.0.0.1:61401', 'content-type': 'application/json' }))
  ok(f3.status === 200 && f3.json.ok === true, 'R2 Headers-like 回环 Origin + json → 200 放行')
  const f4 = await call2('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), HL({ origin: 'http://evil.example', 'content-type': 'application/json' }))
  ok(f4.status === 403 && f4.json.error === 'bad origin', 'R2 Headers-like evil Origin → 403（get(k) 取得到 Origin）')
  const f5 = await call2('/superagent/archive-one', 'POST', JSON.stringify({ ticketId: 'sa-001' }), HL({ origin: 'http://127.0.0.1:61401', 'content-type': 'text/plain' }))
  ok(f5.status === 415, 'R2 Headers-like text/plain → 415（get(k) 取得到 content-type）')
} catch (e) {
  console.error('EXCEPTION ' + (e && e.stack ? e.stack : e)); fails++
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  try { rmSync(dir + '2', { recursive: true, force: true }) } catch {}
}
console.log(fails === 0 ? 'batch C: ALL PASS' : 'batch C: ' + fails + ' FAILED')
process.exit(fails === 0 ? 0 : 1)
