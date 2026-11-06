// sa-183：优先测试同目录候选；尚无候选时只在系统临时目录应用补丁。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const baseline = resolve(here, '../superagent-panel37')
const patchFile = resolve(here, '../audit/codex-sa-183-patch.md')
const temps = []
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const baselineHashes = new Map(['index.js', 'client.js'].map((name) => [name, hash(join(baseline, name))]))
const temp = () => {
  const dir = fs.mkdtempSync(os.tmpdir() + '/panel38-')
  temps.push(dir)
  return dir
}
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value))
const ids = (n) => Array.from({ length: n }, (_, i) => 'sa-' + String(i + 1).padStart(3, '0'))
const ticket = (id, state = 'done', extra = {}) => ({ id, state, title: id, artifacts: [], ...extra })
const state = (dir, tickets) => writeJson(join(dir, 'state.json'), { version: 2, seq: tickets.length, tickets, outbox: [] })
const commandNames = (dir) => fs.existsSync(join(dir, 'commands')) ? fs.readdirSync(join(dir, 'commands')).sort() : []
const commandDocs = (dir) => commandNames(dir).map((name) => JSON.parse(fs.readFileSync(join(dir, 'commands', name), 'utf8')))
const archive = (dir, tickets) => {
  fs.mkdirSync(join(dir, 'archive'), { recursive: true })
  writeJson(join(dir, 'archive', 'sa.json'), { prefix: 'sa', updatedAt: '2026-11-06T00:00:00.000Z', tickets })
}

// 严格验证文档格式及 old 唯一匹配，同时生成内存候选用于临时验证。
function applyDocument() {
  const doc = fs.readFileSync(patchFile, 'utf8').replace(/\r\n/g, '\n')
  const sections = [...doc.matchAll(/^## (P\d{2}) · ([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
  assert.equal(sections.length, 17, '完整的 P01–P17，不允许漏节')
  const source = Object.fromEntries(['index.js', 'client.js'].map((name) => [name, fs.readFileSync(join(baseline, name), 'utf8').replace(/\r\n/g, '\n')]))
  for (const [i, section] of sections.entries()) {
    assert.equal(section[1], 'P' + String(i + 1).padStart(2, '0'))
    const target = section[2].match(/文件：`(index\.js|client\.js)`/)
    assert.ok(target, section[1] + ' 指定目标文件')
    const blocks = [...section[2].matchAll(/^```js\n([\s\S]*?)\n```$/gm)]
    assert.equal(blocks.length, 2, section[1] + ' 恰好两个 js 块')
    const [oldCode, newCode] = blocks.map((m) => m[1])
    const name = target[1]
    const original = fs.readFileSync(join(baseline, name), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(original.split(oldCode).length - 1, 1, section[1] + ' old 与 panel37 原文唯一匹配')
    assert.equal(source[name].split(oldCode).length - 1, 1, section[1] + ' 顺序应用唯一匹配')
    source[name] = source[name].replace(oldCode, () => newCode)
  }
  return source
}

function routes(apply, dir) {
  let handler
  apply({ inject: (_names, cb) => cb({ effect: (fn) => fn(), webServer: { register: (r) => { handler = r.handler; return () => {} } } }) }, { stateDir: dir })
  assert.equal(typeof handler, 'function')
  return (path, body, method = body === undefined ? 'GET' : 'POST') => new Promise((resolveCall, reject) => {
    const events = {}
    const timer = setTimeout(() => reject(new Error('handler 超时：' + path)), 2000)
    // sa-187 第二轮：P01 fail-closed 后写方法必须带合法头，假 req 补 headers（judge 批准改脚手架）
    const req = { url: '/superagent' + path, method, headers: { 'content-type': 'application/json' }, on: (event, fn) => { (events[event] ||= []).push(fn); return req }, destroy: () => {} }
    const res = { statusCode: 0, setHeader: () => {}, end: (text) => {
      clearTimeout(timer)
      try { resolveCall({ status: res.statusCode, json: JSON.parse(text) }) } catch (e) { reject(e) }
    } }
    Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e) })
    queueMicrotask(() => {
      if (body !== undefined) for (const fn of events.data || []) fn(Buffer.from(JSON.stringify(body)))
      for (const fn of events.end || []) fn()
    })
  })
}

// 替换内置 fs 后同步 ESM 具名导出；finally 必须恢复，避免计数污染。
async function withFs(name, replacement, fn) {
  const original = fs[name]
  fs[name] = replacement(original)
  syncBuiltinESMExports()
  try { return await fn() } finally { fs[name] = original; syncBuiltinESMExports() }
}

// 从实际 client 文件提取闭包，注入 fetch / flash / state setter 测其响应行为。
function clientFunction(source, name, context) {
  const start = source.indexOf('const ' + name + ' = ')
  assert.ok(start >= 0, name)
  const expressionStart = start + ('const ' + name + ' = ').length
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start)
  const end = source.indexOf('\n' + indent + '}', expressionStart)
  assert.ok(end >= 0, name + ' 结束标记')
  return vm.runInNewContext('(' + source.slice(expressionStart, end + indent.length + 2) + ')', context)
}

let failed = false
try {
  const patched = applyDocument()
  const localModule = join(here, 'index.js')
  let moduleFile = localModule
  let client
  if (fs.existsSync(localModule)) {
    client = fs.readFileSync(join(here, 'client.js'), 'utf8')
    console.log('测试来源：同目录 panel38 候选 index.js / client.js')
  } else {
    const candidate = temp()
    moduleFile = join(candidate, 'index.mjs')
    fs.writeFileSync(moduleFile, patched['index.js'])
    client = patched['client.js']
    console.log('测试来源：sa-183 补丁临时应用副本（未改 panel37）')
  }
  new vm.Script(client, { filename: 'panel38-client.js' })
  const { apply } = await import(pathToFileURL(moduleFile).href)

  // A16：固定 Date.now，所有命令与设置 tmp 的前缀、随机后缀、内容均验证。
  {
    const dir = temp()
    state(dir, [ticket('sa-001'), ticket('sa-002', 'blocked')])
    const call = routes(apply, dir)
    const originalNow = Date.now
    Date.now = () => 1793923200000
    try {
      for (const [path, id, prefix, action] of [
        ['/requeue', 'sa-002', 'requeue', 'requeue'],
        ['/archive-one', 'sa-001', 'archive', 'archive'],
        ['/rollback', 'sa-001', 'restore', 'restore'],
        ['/close', 'sa-001', 'close', 'close'],
      ]) {
        const before = new Set(commandNames(dir))
        const responses = await Promise.all([call(path, { ticketId: id }), call(path, { ticketId: id })])
        assert.ok(responses.every((r) => r.status === 200 && r.json.ok === true), path)
        const added = commandNames(dir).filter((n) => !before.has(n))
        assert.equal(added.length, 2, path + ' 同毫秒生成两个文件')
        assert.notEqual(added[0], added[1])
        for (const name of added) {
          assert.match(name, new RegExp('^' + prefix + '-' + id + '-1793923200000-[0-9a-f]{8}\\.json$'))
          const doc = JSON.parse(fs.readFileSync(join(dir, 'commands', name), 'utf8'))
          assert.equal(doc.action, action)
          assert.equal(doc.ticketId, id)
        }
      }
      const tmps = []
      await withFs('writeFileSync', (original) => (file, ...args) => {
        if (String(file).startsWith(join(dir, 'settings.json') + '.tmp-')) tmps.push(String(file))
        return original(file, ...args)
      }, async () => {
        const results = await Promise.all([call('/settings', { runningTimeoutMs: 600000 }), call('/settings', { runningTimeoutMs: 600000 })])
        assert.ok(results.every((r) => r.status === 200 && r.json.ok === true))
      })
      assert.equal(tmps.length, 2)
      assert.notEqual(tmps[0], tmps[1])
      tmps.forEach((file) => assert.match(file, /settings\.json\.tmp-1793923200000-[0-9a-f]{8}$/))
      assert.equal(JSON.parse(fs.readFileSync(join(dir, 'settings.json'), 'utf8')).runningTimeoutMs, 600000)
      assert.ok(tmps.every((file) => !fs.existsSync(file)), 'tmp 已 rename')
    } finally { Date.now = originalNow }
    console.log('A16 PASS：四种命令及 settings tmp 同毫秒不覆盖')
  }

  // A17：路由 HTTP 状态与零副作用；坏 state 明确 500。
  {
    const dir = temp()
    const call = routes(apply, dir)
    for (const s of ['ready', 'running', 'queued']) {
      state(dir, [ticket('sa-001', s)])
      const r = await call('/archive-one', { ticketId: 'sa-001' })
      assert.equal(r.status, 409)
      assert.equal(r.json.ok, false)
      assert.equal(r.json.error, 'bad-state')
      assert.equal(r.json.state, s)
      assert.ok(r.json.hint)
      assert.deepEqual(commandNames(dir), [])
    }
    const missing = await call('/archive-one', { ticketId: 'sa-999' })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error, 'no-such-ticket')
    assert.deepEqual(commandNames(dir), [])
    for (const invalid of ['../bad', 'sa-1/x', 'bad id']) {
      assert.equal((await call('/archive-one', { ticketId: invalid })).status, 400)
      assert.deepEqual(commandNames(dir), [])
    }
    for (const s of ['done', 'blocked']) {
      state(dir, [ticket('sa-001', s)])
      const before = commandNames(dir).length
      const r = await call('/archive-one', { ticketId: 'sa-001' })
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, true)
      assert.equal(r.json.queued, true)
      assert.equal(r.json.ticketId, 'sa-001')
      assert.equal(r.json.state, s)
      assert.equal(commandNames(dir).length, before + 1)
    }
    const before = commandNames(dir)
    fs.writeFileSync(join(dir, 'state.json'), '{bad json')
    const badState = await call('/archive-one', { ticketId: 'sa-001' })
    assert.equal(badState.status, 500)
    assert.equal(badState.json.ok, false)
    assert.ok(badState.json.error)
    assert.deepEqual(commandNames(dir), before)
    fs.unlinkSync(join(dir, 'state.json'))
    assert.equal((await call('/archive-one', { ticketId: 'sa-001' })).status, 500)
    assert.deepEqual(commandNames(dir), before)
    console.log('A17 PASS：状态校验、404/409/500 与拒绝时不写命令')
  }

  // A18：批量只写逐张 restore，200 上限在 all 与 ids 两条路径均强制。
  {
    const dir = temp()
    archive(dir, ['sa-003', 'sa-001', 'sa-002'].map((id) => ticket(id)))
    const call = routes(apply, dir)
    const r = await call('/rollback', { all: true })
    assert.equal(r.status, 200)
    assert.equal(r.json.action, 'restore')
    assert.equal(r.json.count, 3)
    assert.deepEqual(r.json.ids, ids(3))
    assert.equal(r.json.truncated, false)
    assert.equal(new Date(r.json.at).toISOString(), r.json.at)
    assert.equal(commandNames(dir).length, 3)
    for (const id of ids(3)) assert.equal(commandNames(dir).filter((n) => n.startsWith('restore-' + id + '-')).length, 1)
    assert.ok(commandNames(dir).every((n) => !n.startsWith('restore-all')))
    for (const doc of commandDocs(dir)) {
      assert.equal(doc.action, 'restore')
      assert.equal(doc.at, r.json.at)
    }
    const explicitDir = temp()
    const explicit = routes(apply, explicitDir)
    const e = await explicit('/rollback', { ids: ['s12-008', 'sa-002', 'sa-002'] })
    assert.equal(e.status, 200)
    assert.deepEqual(e.json.ids, ['s12-008', 'sa-002'])
    assert.equal(e.json.count, 2)
    assert.deepEqual(commandDocs(explicitDir).map((d) => d.ticketId).sort(), ['s12-008', 'sa-002'])
    const before = commandNames(explicitDir)
    for (const value of [['sa-001', '../bad'], ['sa-001', 42], 'sa-001', null, [...ids(201), 'bad']]) {
      const bad = await explicit('/rollback', { ids: value })
      assert.equal(bad.status, 400)
      assert.equal(bad.json.ok, false)
      assert.deepEqual(commandNames(explicitDir), before, '整批校验在写入前，包括上限之外')
    }
    for (const all of [true, false]) {
      const cappedDir = temp()
      archive(cappedDir, ids(205).reverse().map((id) => ticket(id)))
      const capped = await routes(apply, cappedDir)('/rollback', all ? { all: true } : { ids: ids(205) })
      assert.equal(capped.status, 200)
      assert.equal(capped.json.count, 200)
      assert.equal(capped.json.truncated, true)
      assert.deepEqual(capped.json.ids, ids(200))
      assert.equal(commandNames(cappedDir).length, 200)
      assert.deepEqual(commandDocs(cappedDir).map((d) => d.ticketId).sort(), ids(200))
      assert.ok(commandDocs(cappedDir).every((d) => d.action === 'restore' && d.at === capped.json.at))
    }
    const emptyDir = temp()
    const empty = await routes(apply, emptyDir)('/rollback', { all: true })
    assert.equal(empty.json.count, 0)
    assert.equal(empty.json.truncated, false)
    assert.deepEqual(commandNames(emptyDir), [])
    const single = await explicit('/rollback', { ticketId: 'sa-777' })
    assert.equal(single.status, 200)
    assert.equal(single.json.action, 'restore')
    assert.equal(single.json.ticketId, 'sa-777')
    assert.ok(fs.existsSync(single.json.file))
    console.log('A18 PASS：逐单命令、显式 ids、全批校验、两条路径的 200 上限与 trace')
  }

  // A19：真实 205 个不同 ID，搜索结果另核对无截断情形。
  {
    const dir = temp()
    archive(dir, ids(205).map((id) => ticket(id)))
    const call = routes(apply, dir)
    const r = await call('/archive')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.total, 205)
    assert.equal(r.json.returned, 200)
    assert.equal(r.json.hasMore, true)
    assert.equal(r.json.rows.length, 200)
    assert.equal(new Set(r.json.rows.map((t) => t.id)).size, 200)
    const found = await call('/archive?q=sa-205')
    assert.equal(found.json.total, 1)
    assert.equal(found.json.returned, 1)
    assert.equal(found.json.hasMore, false)
    assert.equal(found.json.rows[0].id, 'sa-205')
    console.log('A19 PASS：205 个实际 ID 的 total / returned / hasMore 与搜索')
  }

  // A20：无逐单目录的 240 张单，统计所有 evidence 子树扫描及 stateDir 扫描。
  {
    const dir = temp()
    fs.mkdirSync(join(dir, 'evidence'))
    state(dir, ids(240).map((id) => ticket(id)))
    const call = routes(apply, dir)
    let evidenceReads = 0
    let legacyReads = 0
    await withFs('readdirSync', (original) => (path, ...args) => {
      const p = resolve(String(path))
      const rel = relative(join(dir, 'evidence'), p)
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) evidenceReads++
      if (p === resolve(dir)) legacyReads++
      return original(path, ...args)
    }, async () => {
      const r = await call('/tickets')
      assert.equal(r.status, 200)
      assert.equal(r.json.total, 240)
      assert.ok(!r.json.error)
      assert.ok(r.json.tickets.every((t) => t.evidence === null && t.evidenceKind === null))
    })
    assert.ok(evidenceReads >= 1 && evidenceReads <= 2, 'evidence readdir 次数=' + evidenceReads)
    assert.ok(legacyReads <= 1, 'stateDir 扫描复用，次数=' + legacyReads)
    // 目录缺失也只索引一次；不能逐单尝试失败 IO。
    const missingDir = temp()
    state(missingDir, ids(100).map((id) => ticket(id)))
    let missingReads = 0
    await withFs('readdirSync', (original) => (path, ...args) => {
      if (resolve(String(path)).startsWith(join(missingDir, 'evidence'))) missingReads++
      return original(path, ...args)
    }, async () => {
      assert.equal((await routes(apply, missingDir)('/tickets')).json.total, 100)
    })
    assert.ok(missingReads <= 2)
    // 真实命中：清单优先、缺失清单回退目录、目录优先历史、直接 evidence、历史名字、无证据。
    const evDir = temp()
    for (const id of ['sa-001', 'sa-002', 'sa-003']) fs.mkdirSync(join(evDir, 'evidence', id), { recursive: true })
    fs.writeFileSync(join(evDir, 'evidence', 'sa-001', 'z-manifest.md'), 'manifest')
    fs.writeFileSync(join(evDir, 'evidence', 'sa-001', 'a-dir.md'), 'dir')
    fs.writeFileSync(join(evDir, 'evidence', 'sa-002', 'fallback.txt'), 'dir')
    fs.writeFileSync(join(evDir, 'evidence', 'sa-003', 'ignore.bin'), 'skip')
    fs.writeFileSync(join(evDir, 'codex-sa-002.md'), 'legacy')
    fs.writeFileSync(join(evDir, 'codex-sa-003.md'), 'legacy')
    fs.writeFileSync(join(evDir, 'custom.txt'), 'direct')
    fs.writeFileSync(join(evDir, 'other-sa-005.md'), 'legacy')
    state(evDir, [
      ticket('sa-001', 'done', { artifacts: [{ name: 'z-manifest.md' }], reports: [null] }),
      ticket('sa-002', 'done', { artifacts: [{ name: 'missing.md' }] }),
      ticket('sa-003'),
      ticket('sa-004', 'done', { evidence: join(evDir, 'custom.txt') }),
      ticket('sa-005'), ticket('sa-006'),
    ])
    const r = await routes(apply, evDir)('/tickets')
    const rows = Object.fromEntries(r.json.tickets.map((t) => [t.id, t]))
    for (const [id, file, kind] of [
      ['sa-001', join(evDir, 'evidence', 'sa-001', 'z-manifest.md'), 'manifest'],
      ['sa-002', join(evDir, 'evidence', 'sa-002', 'fallback.txt'), 'dir'],
      ['sa-003', join(evDir, 'codex-sa-003.md'), 'legacy'],
      ['sa-004', join(evDir, 'custom.txt'), 'legacy'],
      ['sa-005', join(evDir, 'other-sa-005.md'), 'legacy'],
    ]) {
      assert.equal(rows[id].evidence, file)
      assert.equal(rows[id].evidenceKind, kind)
    }
    assert.equal(rows['sa-001'].reports.last, null)
    assert.equal(rows['sa-002'].artifacts, 1)
    assert.equal(rows['sa-006'].evidence, null)
    assert.equal(rows['sa-006'].evidenceKind, null)
    console.log('A20 PASS：evidence 扫描=' + evidenceReads + '、stateDir 扫描=' + legacyReads + '，清单与回退语义保留')
  }

  // client 真实函数：错误提示、批量反馈及 hasMore 传递（不操作屏幕）。
  {
    const failResponse = { ok: true, status: 200, json: async () => ({ ok: false, error: 'bad-state', hint: '请等待完成' }) }
    const post = clientFunction(client, 'postArchiveOne', { fetch: async () => failResponse })
    const r = await post('sa-001')
    assert.equal(r.ok, false)
    assert.equal(r.error, '请等待完成')
    const httpFail = clientFunction(client, 'postArchiveOne', { fetch: async () => ({ ok: false, status: 409, json: failResponse.json }) })
    assert.equal((await httpFail('sa-001')).ok, false)
    const search = clientFunction(client, 'searchArchive', { fetch: async () => ({ ok: true, json: async () => ({ ok: true, total: 205, returned: 200, hasMore: true, rows: [] }) }) })
    const result = await search('')
    assert.equal(result.total, 205)
    assert.equal(result.returned, 200)
    assert.equal(result.hasMore, true)
    const messages = []
    const context = { aselIds: ids(205), postRollback: async (body) => {
      assert.equal(body.ids.length, 205)
      return { ok: true, doc: { count: 200, truncated: true } }
    }, flash: (m) => messages.push(m), setAselIds: () => {}, setArchDoc: () => {}, refreshNow: () => {}, setTimeout: () => {}, onArchive: () => {} }
    await clientFunction(client, 'onBatchRestore', context)()
    assert.match(messages.pop(), /已提交回滚 200 张.*上限/)
    await clientFunction(client, 'onRollbackAll', { ...context, rbArmed: true, setRbArmed: () => {}, postRollback: async (body) => {
      assert.equal(body.all, true)
      return { ok: true, doc: { count: 3, truncated: false } }
    } })()
    assert.match(messages.pop(), /已提交回滚 3 张/)
    await clientFunction(client, 'onBatchArchive', { closedOf: (a) => a, selIds: ['sa-001'], postArchiveOne: async () => ({ ok: false, error: 'bad-state' }), flash: (m) => messages.push(m), setSelIds: () => {}, refreshNow: () => {} })()
    assert.match(messages.pop(), /失败：sa-001：bad-state/)
    console.log('client PASS：归档非 ok 展示、批量 count / truncated、hasMore 与语法检查')
  }
} catch (e) {
  failed = true
  console.error(e.stack || e)
} finally {
  try {
    for (const [name, before] of baselineHashes) assert.equal(hash(join(baseline, name)), before, 'panel37 未变：' + name)
  } catch (e) { failed = true; console.error(e.stack || e) }
  for (const dir of temps.reverse()) {
    const rel = relative(resolve(os.tmpdir()), resolve(dir))
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/^panel38-[^\\/]+$/.test(rel)) {
      failed = true
      console.error('拒绝清理越界目录：' + dir)
      continue
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
if (failed) {
  console.error('panel38 P2 修复: FAILED')
  process.exitCode = 1
} else console.log('panel38 P2 修复: ALL PASS')
