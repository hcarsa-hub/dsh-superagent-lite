import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// 2026-11-07：不再写死版本号——取 --bundle 参数 / BUNDLE_DIR 环境变量，缺省用 dist 里最新的包
const DIST = 'E:/workplace_whole/plugincreate_test/handoff/dist'
const pickLatest = () => {
  const cands = fs.readdirSync(DIST)
    .filter((n) => /^dsh-superagent-lite-bundle-\d/.test(n) && fs.statSync(join(DIST, n)).isDirectory())
    .sort()
  return cands.length ? join(DIST, cands[cands.length - 1]) : ''
}
const B = process.argv[2] || process.env.BUNDLE_DIR || pickLatest()
if (!B || !fs.existsSync(B)) { console.error('找不到捆绑包目录：' + (B || '(dist 为空)')); process.exit(2) }
console.log('[simulate] bundle = ' + B)
const node = process.execPath
const results = []
const rec = (id, ok, detail) => { results.push({ id, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

// 造一个「隔离 profile」：node_modules 空 + patch 里有一条被注释掉的 id（复现判重 bug）
const P = fs.mkdtempSync(join(tmpdir(), 'sa-bundle-sim-'))
fs.mkdirSync(join(P, 'node_modules'), { recursive: true })
const patch = join(P, 'cordis.patch.yml')
fs.writeFileSync(patch, [
  '# 模拟别人的 profile；下面这条是被注释过的旧块（旧版安装器会误判「已安装」）',
  '# - insert:',
  '#     - id: superagent-lite',
  "#       name: 'dsh-plugin-superagent-lite'",
  '',
].join('\n'), 'utf8')
const sha = (f) => { try { return fs.readFileSync(f, 'utf8').length + ':' + fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => /^    - id: /.test(l)).length } catch { return 'none' } }
const before = sha(patch)
const commandFailures = []
const run = (script, args) => {
  try { return execFileSync(node, [join(B, script), ...args], { encoding: 'utf8', cwd: B }) }
  catch (e) {
    commandFailures.push(script + ': ' + (e.status ?? e.code ?? e.message))
    console.error(String(e.stdout || '') + String(e.stderr || ''))
    return ''
  }
}

// 第一次 --apply
let out1 = ''
out1 = run('install.mjs', ['--apply', '--profile', P])
const links = ['dsh-plugin-superagent-lite', 'dsh-superagent-lite-panel', 'dsh-plugin-handoff-watch', '@local/dsh-superagent-panel', '@local/dsh-handoff-watch3']
const targets = ['dsh-plugin-superagent-lite', 'superagent-lite-panel', 'handoff-watch', 'superagent-lite-panel', 'handoff-watch']
const linkOk = commandFailures.length === 0 && links.every((n, i) => {
  const link = join(P, 'node_modules', ...n.split('/'))
  return fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() &&
    fs.existsSync(join(link, 'package.json')) && fs.realpathSync(link) === fs.realpathSync(resolve(B, 'packages', targets[i]))
})
rec('1-五个 junction 都建好', linkOk, links.filter((n) => !fs.existsSync(join(P, 'node_modules', ...n.split('/'), 'package.json'))).join(',') || '5/5')

const txt = fs.readFileSync(patch, 'utf8')
const activeIds = txt.split(/\r?\n/).filter((l) => /^    - id: /.test(l)).map((l) => l.trim())
const expectedIds = ['- id: superagent-lite', '- id: superagent-panel', '- id: handoff-watch3'].sort()
rec('2-三条 insert 真的追加了（不被注释块误判）', JSON.stringify([...activeIds].sort()) === JSON.stringify(expectedIds), 'active=' + JSON.stringify(activeIds) + ' (before=' + before + ')')
const names = txt.split(/\r?\n/).filter((l) => /^      name: /.test(l) && !/^\s*#/.test(l)).map((l) => l.trim().replace('name: ', '').replace(/^['"]|['"]$/g, ''))
rec('3-patch name 与 junction 名一致', ['dsh-plugin-superagent-lite', 'dsh-superagent-lite-panel', 'dsh-plugin-handoff-watch'].every((n) => names.includes(n)), JSON.stringify(names))

// 第二次 --apply：必须幂等
run('install.mjs', ['--apply', '--profile', P])
const ids2 = fs.readFileSync(patch, 'utf8').split(/\r?\n/).filter((l) => /^    - id: /.test(l))
rec('4-再跑一次幂等（不重复追加）', commandFailures.length === 0 && fs.readFileSync(patch, 'utf8') === txt, 'active=' + ids2.length)

// uninstall：5 个都要删
run('uninstall.mjs', ['--profile', P])
const left = links.filter((n) => fs.lstatSync(join(P, 'node_modules', ...n.split('/')), { throwIfNoEntry: false }))
rec('5-uninstall 删掉全部 5 个（含别名）', commandFailures.length === 0 && left.length === 0, left.join(',') || '0 残留')

// 2026-11-07 P0 回归：模板必须带 watcher sessionId、README 验收必须要求 delivered
{
  const tpl = fs.readFileSync(join(B, 'cordis.patch.bundle.yml'), 'utf8')
  const blocks = tpl.split(/- insert:/).filter((b) => b.includes('- id: '))
  const watchBlock = blocks.find((b) => b.includes('id: handoff-watch3')) || ''
  const hasSid = /^\s+sessionId:\s*'<owner 会话 id>'/m.test(watchBlock)
  rec('6-模板 watcher 块有 sessionId（P0 回归）', hasSid,
    hasSid ? 'watcher 块含 sessionId' : (watchBlock ? 'watcher 块缺 sessionId' : '找不到 handoff-watch3 块'))
  const rd = fs.readFileSync(join(B, 'README.md'), 'utf8')
  const okReadme = rd.includes('不算通过') && rd.includes('delivered:')
  rec('7-README 验收要求 delivered（不再被 skipped 假通过）', okReadme,
    okReadme ? '含「只有 skipped 不算通过」+ delivered 口径' : 'README 验收口径仍可能被 skipped 假通过')
  // 2026-11-07 0.1.2 回归：包内 watcher 默认队列必须与内核口径（<stateDir>/../queue）一致
  const wi = fs.readFileSync(join(B, 'packages/handoff-watch/index.js'), 'utf8')
  const wOk = wi.includes("join(homedir(), '.dsh', 'queue')") && !wi.includes("'.dsh', 'subagent', 'queue'")
  rec('8-watcher 默认队列与内核口径一致（0.1.2 回归）', wOk,
    wOk ? "watcher 默认 = join(homedir(), '.dsh', 'queue')（内核默认 stateDir 下为 <home>/.dsh/queue）" : '包内 watcher 默认队列仍与内核解析不一致')
  const rq = fs.readFileSync(join(B, 'README.md'), 'utf8')
  rec('9-README 说明自定义 stateDir 必须显式写 queueDir', rq.includes('必须**逐字相同**') || rq.includes('逐字相同'), rq.includes('逐字相同') ? '含自定义 stateDir 警告' : '缺 queueDir 自定义警告')
  // 2026-11-07 0.1.4 回归：模板默认必须开自动送审 + judge 轮换（否则新装机器所有单堆一个 judge）
  const tplTxt = fs.readFileSync(join(B, 'cordis.patch.bundle.yml'), 'utf8')
  const hasAuto = /^\s+autoJudge:\s+true/m.test(tplTxt)
  const hasRot = /^\s+judgeRotate:\s+true/m.test(tplTxt)
  rec('10-模板默认 autoJudge+judgeRotate 都开（0.1.4 回归）', hasAuto && hasRot,
    hasAuto && hasRot ? '两项都为 true' : ('autoJudge=' + hasAuto + ' judgeRotate=' + hasRot))
  const rj = fs.readFileSync(join(B, 'README.md'), 'utf8')
  rec('11-README 有 judge 分流验收项', rj.includes('judge 分流') && rj.includes('judge-rotate'), rj.includes('judge 分流') ? '含 judge 分流验收' : '缺 judge 分流验收')
}
fs.rmSync(P, { recursive: true, force: true })
const fails = results.filter((r) => !r.ok)
if (results.length !== 11 || commandFailures.length) {
  console.error('SIMULATION: assertion count=' + results.length + ' (expected 11); command failures=' + JSON.stringify(commandFailures))
  process.exit(1)
}
console.log(fails.length ? ('SIMULATION: ' + fails.length + ' FAIL') : 'SIMULATION: ALL PASS')
process.exit(fails.length ? 1 : 0)
