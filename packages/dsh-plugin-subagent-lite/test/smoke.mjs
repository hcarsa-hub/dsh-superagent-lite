// dsh-plugin-subagent-lite 离线冒烟测试（零依赖、零网络、只用临时目录）
//
// 跑法：node test/smoke.mjs
// 结果：末行打印 "SMOKE: ALL PASS"；任何断言失败 → exit 1
//
// 说明：这里用一个最小 cordis ctx 假件驱动 apply()，不会连宿主、不会碰真实数据目录。

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoots = []
const failures = []

function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(d)
  return d
}
function ok(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); return }
  failures.push(name + (detail ? ' :: ' + detail : ''))
  console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual))
}

// ---- 最小 cordis ctx 假件 -------------------------------------------------
function makeCtx(services = {}) {
  const registered = []
  const disposers = []
  const toolsSvc = { register(def) { registered.push(def); return { dispose() {} } } }
  const svcMap = { tools: toolsSvc, ...services }
  const ctx = {
    get(name) { return svcMap[name] },
    inject(deps, cb) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps || {})
      const found = {}
      let all = true
      for (const n of names) {
        if (svcMap[n]) found[n] = svcMap[n]
        else all = false
      }
      if (all) cb(found)
      return {}
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    on() {},
    emit() {},
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return {
    ctx,
    registered,
    disposeAll() { for (const d of disposers) { try { d() } catch {} } },
  }
}

const EXPECTED_TOOLS = [
  'sa_status', 'sa_submit', 'sa_advance', 'sa_run', 'sa_delegate_codex', 'sa_watchdog', 'sa_list', 'sa_ingress',
  'sa_next', 'sa_role', 'sa_agents', 'sa_fanout', 'sa_report', 'sa_judge', 'sa_escalate', 'sa_verdict',
  'sa_archive', 'sa_tell', 'sa_whoami', 'sa_owners', 'sa_owner_add', 'sa_owner_remove', 'sa_transfer',
  'sa_attach', 'sa_evidence', 'sa_stats',
  // sa-194：运行中追加需求
  'sa_requirements',
  // sa-195：可选回传 QQ
  'sa_sendback',
  // sa-201：程序化建会话
  'sa_new_session',
  'sa_progress',
  // sa-209：压缩指定会话上下文（= 在目标会话跑 /compact）
  'sa_compact',
]
const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]))

// ---- 1. 空 ownerSessions：只有只读工具可用，写工具要求先配置 ---------------
console.log('1. 默认配置（ownerSessions 为空）')
{
  const stateDir = join(mkTmp('subagent-lite-smoke-'), 'state')
  const { ctx, registered, disposeAll } = makeCtx()
  const svc = apply(ctx, { stateDir })
  try {
    eq('注册工具数 = 31', registered.length, 31)
    eq('工具名与预期一致', registered.map((t) => t.name).sort().join(','), [...EXPECTED_TOOLS].sort().join(','))
    ok('lite.log 已创建', existsSync(join(stateDir, 'lite.log')))
    ok('commands/ 已创建', existsSync(join(stateDir, 'commands')))
    ok('archive/ 已创建', existsSync(join(stateDir, 'archive')))
    ok('未创建 ingress.jsonl（默认关闭）', !existsSync(join(stateDir, 'ingress.jsonl')))
    ok('未创建 events.jsonl（内核只读）', !existsSync(join(stateDir, 'queue', 'events.jsonl')))
    ok('未创建默认 queue 目录（内核不写）', !existsSync(join(stateDir, 'queue')))
    ok('owners.json 已创建', existsSync(join(stateDir, 'owners.json')))
    const roles = JSON.parse(readFileSync(join(stateDir, 'owners.json'), 'utf8'))
    eq('owners 默认空', roles.owners.length, 0)
    ok('svc 有 status()', svc && typeof svc.status === 'function')

    const tools = byName(registered)
    const exec = { agent: { id: 'smoke-session-unknown' } }
    const rSubmit = await tools.sa_submit.execute({ title: 'smoke ticket' }, exec)
    eq('无 owner 时 sa_submit 被拒', rSubmit.ok, false)
    ok('拒绝原因给出授权路径（sa_role）', String(rSubmit.detail).includes('sa_role'), rSubmit.detail)
    ok('拒绝原因标明当前角色为 none', String(rSubmit.detail).includes('当前角色=none'), rSubmit.detail)
    const rStatus = await tools.sa_status.execute({}, exec)
    eq('只读工具 sa_status 仍可用', rStatus.ok, true)
    const rWho = await tools.sa_whoami.execute({}, exec)
    ok('sa_whoami 可用且带 sessionId', String(rWho.detail).includes('sessionId='), rWho.detail)
    const rNext = await tools.sa_next.execute({}, exec)
    eq('只读工具 sa_next 可用', rNext.ok, true)
  } finally {
    disposeAll()
  }
}

// ---- 2. 有 owner：主流程 + 可选能力缺失时的明确错误 ------------------------
console.log('2. 配好 owner 之后')
{
  const rootDir = mkTmp('subagent-lite-smoke-')
  const stateDir = join(rootDir, 'state')
  const ownerSid = 'smoke-owner-session'
  const { ctx, registered, disposeAll } = makeCtx() // 不提供 subagents / schedule
  apply(ctx, { stateDir, ownerSessions: [ownerSid] })
  try {
    const tools = byName(registered)
    const exec = { agent: { id: ownerSid } }

    const rWho = await tools.sa_whoami.execute({}, exec)
    ok('owner 身份识别为 owner', String(rWho.detail).includes('role=owner'), rWho.detail)

    const rSubmit = await tools.sa_submit.execute({ title: 'smoke ticket 1', type: 'test' }, exec)
    eq('sa_submit 成功', rSubmit.ok, true)
    ok('第一次写操作后 state.json 落盘', existsSync(join(stateDir, 'state.json')))
    const list1 = await tools.sa_list.execute({}, exec)
    ok('sa_list 能看到刚提交的单', String(list1.detail).includes('sa-001'), list1.detail)

    // 第二张单：专门用来测「可选能力缺失」的报错（第一张单要留给状态机全程）
    const rSubmit2 = await tools.sa_submit.execute({ title: 'smoke ticket 2' }, exec)
    eq('第二张单提交成功', rSubmit2.ok, true)

    // 没有 subagents 服务：sa_run 必须给明确错误，而不是静默失败，且不改工单状态
    const rRun = await tools.sa_run.execute({ id: 'sa-002' }, exec)
    eq('无 subagents 时 sa_run 返回失败', rRun.ok, false)
    ok('错误里写明 subagents service unavailable', String(rRun.detail).includes('subagents service unavailable'), rRun.detail)
    ok('错误里提到 subagent（不是静默失败）', String(rRun.detail).includes('subagent'), rRun.detail)
    const afterRun = await tools.sa_list.execute({}, exec)
    ok('sa_run 失败后工单仍是 queued', /sa-002\s+queued/.test(String(afterRun.detail)), afterRun.detail)

    // 多模型扇出同样需要 subagents
    const rFan = await tools.sa_fanout.execute({ id: 'sa-002', models: [{ provider: 'p', model: 'm' }] }, exec)
    ok('sa_fanout(models) 给明确错误', String(rFan.detail).includes('subagents service unavailable'), rFan.detail)
    ok('sa_fanout 提示需要 subagent 服务', String(rFan.detail).includes('subagent'), rFan.detail)

    // 外部通路：sa-194/195 起 ingressFile 默认 stateDir/ingress.jsonl、inboxFile 默认 stateDir/../inbox/latest.md
    // （不再是「未配置即拒绝」），所以这里断言「默认路径生效且真的落盘」，而不是「未配置就失败」
    const rIngress = await tools.sa_ingress.execute({ source: 'smoke', key: 'k1', title: 't' }, exec)
    eq('默认配置下 sa_ingress 可用（落默认 ingress.jsonl）', rIngress.ok, true)
    ok('sa_ingress 返回 detail 含 queued/ingress', String(rIngress.detail).includes('ingress'), rIngress.detail)
    ok('默认 ingress.jsonl 真的落盘', existsSync(join(stateDir, 'ingress.jsonl')), join(stateDir, 'ingress.jsonl'))
    const rCodex = await tools.sa_delegate_codex.execute({ id: 'sa-002' }, exec)
    eq('默认配置下 sa_delegate_codex 可用（写默认 inbox）', rCodex.ok, true)
    ok('sa_delegate_codex 返回 detail 含 backend=codex', String(rCodex.detail).includes('codex'), rCodex.detail)

    // 证据链：attach 内容 → evidence 详情
    const rAttach = await tools.sa_attach.execute({ id: 'sa-001', name: 'note.md', content: 'hello' }, exec)
    eq('sa_attach 写入成功', rAttach.ok, true)
    ok('evidence 目录里有文件', existsSync(join(stateDir, 'evidence', 'sa-001', 'note.md')))
    const rEv = await tools.sa_evidence.execute({ id: 'sa-001' }, exec)
    eq('sa_evidence 可读', rEv.ok, true)

    // 状态机：queued → running → ready → done
    eq('sa_advance queued→running', (await tools.sa_advance.execute({ id: 'sa-001', to: 'running' }, exec)).ok, true)
    eq('sa_advance running→ready', (await tools.sa_advance.execute({ id: 'sa-001', to: 'ready' }, exec)).ok, true)
    const rDone = await tools.sa_advance.execute({ id: 'sa-001', to: 'done' }, exec)
    eq('sa_advance ready→done', rDone.ok, true)

    // 数据文件默认落在 stateDir 内（sa-195 起 inbox 默认落在 stateDir 同级 inbox/，属已知行为）
    ok('evidence 在 stateDir 内', existsSync(join(stateDir, 'evidence')))
    ok('archive 目录已建', existsSync(join(stateDir, 'archive')))
    ok('ingress.jsonl 落在 stateDir 内（默认路径）', existsSync(join(stateDir, 'ingress.jsonl')))
    ok('未创建 queue 目录', !existsSync(join(rootDir, 'queue')))
    // stateDir 之外只允许出现 inbox/（sa_delegate_codex 默认 inbox = stateDir/../inbox/latest.md）
    const siblings = readdirSync(rootDir).sort().join(',')
    eq('stateDir 之外只有 state + inbox（inbox 是 sa-195 起的默认落点）', siblings, 'inbox,state')
  } finally {
    disposeAll()
  }
}

// ---- 2b. 首次启动（空 stateDir）-------------------------------------------
console.log('2b. 首次启动（空 stateDir）')
{
  const rootDir = mkTmp('subagent-lite-smoke-first-')
  const stateDir = join(rootDir, 'fresh-state')
  const ownerSid = 'smoke-first-owner'
  const { ctx, registered, disposeAll } = makeCtx()
  apply(ctx, { stateDir, ownerSessions: [ownerSid] })
  try {
    const tools = byName(registered)
    const exec = { agent: { id: ownerSid } }
    const rWho = await tools.sa_whoami.execute({}, exec)
    eq('首启后 sa_whoami 可用', rWho.ok, true)
    const rSubmit = await tools.sa_submit.execute({ title: 'first-start ticket' }, exec)
    eq('首启后 sa_submit 能建单', rSubmit.ok, true)
    ok('首启后 state.json 存在', existsSync(join(stateDir, 'state.json')))
    ok('首启后 owners.json 存在', existsSync(join(stateDir, 'owners.json')))
    const dirs = readdirSync(stateDir).sort()
    ok('首启目录结构含 commands/archive/evidence 目录或按需建', dirs.includes('commands') && dirs.includes('archive'), dirs.join(','))
  } finally {
    disposeAll()
  }
}

// ---- 2c. 包元数据（DSH 惯例字段 + patch 只一条 active insert）----------------
console.log('2c. 包元数据')
{
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  eq('package.json 可解析且 name 正确', pkg.name, 'dsh-plugin-subagent-lite')
  eq('dsh.bundle.patch 指向 ./cordis.patch.yml', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, './cordis.patch.yml')
  ok('没有 dependencies', !pkg.dependencies)
  ok('没有 optionalDependencies', !pkg.optionalDependencies)
  ok('files 含 cordis.patch.yml', Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'))
  const patchPath = join(PKG_ROOT, String(pkg.dsh.bundle.patch).replace('./', ''))
  ok('patch 文件存在', existsSync(patchPath))
  const patch = readFileSync(patchPath, 'utf8')
  const active = patch.split('\n').filter((l) => /^-\s*insert:/.test(l.trim() === '' ? l : l.replace(/^\s+/, '')) && !/^\s*#/.test(l))
  eq('patch 里恰好 1 条 active insert', active.length, 1)
  ok('patch 的 id/name 正确', patch.includes('id: subagent-lite') && patch.includes('name: dsh-plugin-subagent-lite'))
  const watcherPkg = JSON.parse(readFileSync(join(PKG_ROOT, 'integrations', 'codex-bridge', 'watcher', 'package.json'), 'utf8'))
  eq('watcher 包名', watcherPkg.name, 'dsh-plugin-handoff-watch')
  ok('watcher files 含 cordis.patch.yml', watcherPkg.files.includes('cordis.patch.yml'))
  ok('watcher 自己的 patch 存在', existsSync(join(PKG_ROOT, 'integrations', 'codex-bridge', 'watcher', 'cordis.patch.yml')))
}

// ---- 3. 脱敏自检：包内任何文件都不许出现本机痕迹 -------------------------
console.log('3. 脱敏自检')
{
  const pats = [
    'workplace' + '_whole',
    'E' + ':' + String.fromCharCode(92, 92),
    'session-' + '[0-9a-f]{8}',
    'Nes' + 'tor',
    'open' + 'viking',
    'workstation' + '-notes',
  ].map((p) => new RegExp(p, 'i'))
  const skipDirs = new Set(['node_modules', '.git'])
    // 2026-11-06：包开始带 PNG（docs/diagrams），二进制按 utf8 读会随机命中「盘符加反斜杠」这类本机痕迹 —— 只扫文本文件
  const binExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.wasm'])
  const hits = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(ent.name)) continue
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && statSync(p).size < 4 * 1024 * 1024 && !binExt.has(extname(ent.name).toLowerCase())) {
        const text = readFileSync(p, 'utf8')
        if (text.includes('\u0000')) continue  // 兜底：含 NUL 的当二进制
        for (const re of pats) {
          const m = text.match(re)
          if (m) hits.push(ent.name + ' :: ' + JSON.stringify(text.slice(Math.max(0, m.index - 20), m.index + 20)))
        }
      }
    }
  }
  walk(PKG_ROOT)
  eq('禁止出现的本机痕迹命中数 = 0', hits.length, 0)
  if (hits.length) console.log(hits.join('\n'))
}

// ---- 4. 清理 ---------------------------------------------------------------
for (const d of tmpRoots) {
  try { rmSync(d, { recursive: true, force: true }) } catch {}
}

if (failures.length) {
  console.log('')
  console.log('SMOKE: FAIL ' + failures.length)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
} else {
  console.log('')
  console.log('SMOKE: ALL PASS')
}
