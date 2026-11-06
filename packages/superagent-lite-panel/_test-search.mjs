// panel31：归档搜索认类型词（测试 / 代码 / 办公 / 文档…），也认编号与标题
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, readArchive } from './index.js'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); fails++ } else console.log('ok   ' + m) }
const base = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(base, '_test-search-'))
try {
  mkdirSync(join(dir, 'archive'), { recursive: true })
  writeFileSync(join(dir, 'archive', 'sa.json'), JSON.stringify({ prefix: 'sa', updatedAt: '2026-11-06T00:00:00.000Z', tickets: [
    { id: 'sa-041', title: '做一份 Word 文档示例', state: 'done', type: 'office', updatedAt: '2026-11-05T00:00:00.000Z' },
    { id: 'sa-042', title: '筛选用样张', state: 'done', type: 'test', updatedAt: '2026-11-04T00:00:00.000Z' },
    { id: 'sa-043', title: '改一段 Node 代码', state: 'done', type: 'code', updatedAt: '2026-11-03T00:00:00.000Z' },
    { id: 'sa-044', title: '导入数据核对', state: 'done', updatedAt: '2026-11-02T00:00:00.000Z' },
  ] }))

  ok(readArchive(dir, '').length === 4, '空关键词：全部 4 条')
  const off = readArchive(dir, '办公')
  ok(off.length === 1 && off[0].id === 'sa-041', '搜「办公」命中 office 1 条（实得 ' + off.length + '）')
  ok(readArchive(dir, '测试').length === 1 && readArchive(dir, '测试')[0].id === 'sa-042', '搜「测试」命中 test')
  ok(readArchive(dir, '代码').length === 1 && readArchive(dir, '代码')[0].id === 'sa-043', '搜「代码」命中 code')
  ok(readArchive(dir, 'office').length === 1, '英文 office 也命中')
  ok(readArchive(dir, 'TEST').length === 1, '英文大小写不敏感')
  ok(readArchive(dir, '文档').length === 1 && readArchive(dir, '文档')[0].id === 'sa-041', '办公同义词「文档」命中')
  ok(readArchive(dir, 'sa-043').length === 1, '编号仍可搜')
  ok(readArchive(dir, '导入').length === 1 && readArchive(dir, '导入')[0].id === 'sa-044', '标题关键词仍可搜')
  ok(readArchive(dir, 'zzz').length === 0, '不命中返回 0')

  // 路由集成：GET /superagent/archive?q=办公
  let handler = null
  apply({ inject: (n, cb) => cb({ effect: (fn) => fn(), webServer: { register: (r) => { handler = r.handler; return () => {} } } }) }, { stateDir: dir })
  ok(typeof handler === 'function', '路由注册成功')
  const call = (url) => new Promise((resolve) => {
    const req = { url, method: 'GET', on: () => req, destroy: () => {} }
    const res = { statusCode: 0, setHeader: () => {}, end: (t) => { let j = null; try { j = JSON.parse(t) } catch {} resolve({ status: res.statusCode, json: j }) } }
    handler(req, res)
  })
  const r1 = await call('/superagent/archive?q=' + encodeURIComponent('办公'))
  ok(r1.status === 200 && r1.json.total === 1 && r1.json.rows[0].id === 'sa-041', 'GET ?q=办公 返回 1 条')
  const r2 = await call('/superagent/archive?q=' + encodeURIComponent('代码'))
  ok(r2.json.total === 1 && r2.json.rows[0].type === 'code', 'GET ?q=代码 返回 code 单')
} catch (e) {
  console.error('EXCEPTION ' + (e && e.stack ? e.stack : e)); fails++
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
console.log(fails === 0 ? '归档类型搜索: ALL PASS' : '归档类型搜索: ' + fails + ' FAILED')
process.exit(fails === 0 ? 0 : 1)
