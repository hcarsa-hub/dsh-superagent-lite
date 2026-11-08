#!/usr/bin/env node
// install.mjs —— 把捆绑包里的插件挂到 DSH profile（默认 dry-run；--apply 才动文件）
// 用法：
//   node install.mjs                      # 只打印计划
//   node install.mjs --apply              # 备份 patch → 建 junction → 追加 patch 块
//   node install.mjs --apply --profile "%USERPROFILE%\\.dsh\\profiles\\desktop"
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, realpathSync, copyFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const pi = args.indexOf('--profile')
const HOME = process.env.USERPROFILE || process.env.HOME || ''
const PROFILE = pi >= 0 ? args[pi + 1] : join(HOME, '.dsh', 'profiles', 'desktop')
const patchFile = join(PROFILE, 'cordis.patch.yml')
const nm = join(PROFILE, 'node_modules')
// 2026-11-07 修：目录名必须与 packages/ 实际目录一致，name 必须与 cordis.patch.bundle.yml 的 name 一致
const PKGS = [
  { dir: 'dsh-plugin-superagent-lite', name: 'dsh-plugin-superagent-lite' },
  { dir: 'superagent-lite-panel', name: 'dsh-superagent-lite-panel' },
  { dir: 'handoff-watch', name: 'dsh-plugin-handoff-watch' },
]
const BUNDLE_PATCH = join(HERE, 'cordis.patch.bundle.yml')
// 兼容别名：旧 patch / 旧文档可能还用这些名字，一并指到同一份副本（避免「回滚 patch 后插件加载失败」）
const ALIASES = [
  { name: '@local/dsh-superagent-panel', dir: 'superagent-lite-panel' },
  { name: '@local/dsh-handoff-watch3', dir: 'handoff-watch' },
]

if (!existsSync(PROFILE)) { console.error('profile 不存在: ' + PROFILE); process.exit(2) }
// 2026-11-07 修：先校验三个包目录齐全（否则会出现「第 1 个建完、后面缺目录」的半装状态）
const missingDirs = PKGS.filter((p) => !existsSync(join(HERE, 'packages', p.dir)))
if (missingDirs.length) { console.error('[install] 缺目录: ' + missingDirs.map((m) => m.dir).join(', ')); process.exit(3) }
console.log('[install] profile = ' + PROFILE)
console.log('[install] mode    = ' + (apply ? 'APPLY（会改文件）' : 'dry-run（只打印）'))
const plan = []
for (const p of [...PKGS, ...ALIASES]) {
  const target = join(HERE, 'packages', p.dir)
  const link = join(nm, ...p.name.split('/'))
  plan.push({ p, target, link })
  console.log('  junction: ' + link + '  ->  ' + target)
}
if (!apply) {
  console.log('')
  console.log('[plan] 1) 备份 ' + patchFile + ' 为 .bak-bundle-<时间戳>')
  console.log('[plan] 2) 建上面 ' + plan.length + ' 个 junction（同名旧链接先改名备份）')
  console.log('[plan] 3) 把 cordis.patch.bundle.yml 的三条 insert 追加到 ' + patchFile)
  console.log('[plan] 4) 重启 DSH 生效（client 半部必须冷启动）')
  console.log('')
  console.log('确认无误后重跑：node install.mjs --apply')
  process.exit(0)
}
const alreadyLinked = (link, target) => {
  try { return lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(target) } catch { return false }
}
// Preflight every destination before changing anything. Existing backups are never overwritten.
for (const { link, target } of plan) {
  if (!alreadyLinked(link, target) && lstatSync(link, { throwIfNoEntry: false }) &&
      lstatSync(link + '.bak-bundle', { throwIfNoEntry: false })) {
    console.error('[install] 备份已存在，先手工处理: ' + link + '.bak-bundle')
    process.exit(3)
  }
}
// 1) 备份 patch
if (existsSync(patchFile)) {
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const bak = patchFile + '.bak-bundle-' + ts
  copyFileSync(patchFile, bak)
  console.log('[apply] patch 已备份 -> ' + bak)
} else {
  console.log('[apply] 目标没有 cordis.patch.yml，将新建')
}
// 2) junctions
for (const { target, link } of plan) {
  if (!existsSync(target)) { console.error('[apply] 缺目录: ' + target); process.exit(3) }
  mkdirSync(dirname(link), { recursive: true })
  if (alreadyLinked(link, target)) {
    console.log('[apply] junction 已指向目标，跳过: ' + link)
    continue
  }
  const st = lstatSync(link, { throwIfNoEntry: false })
  if (st) {
    const bak = link + '.bak-bundle'
    renameSync(link, bak)
    console.log('[apply] 旧链接已改名 -> ' + bak)
  }
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'inherit' })
  else symlinkSync(target, link, 'dir')
  console.log('[apply] junction 完成: ' + link)
}
// 3) 追加 patch（幂等：按 id 判断）
const cur = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
const add = readFileSync(BUNDLE_PATCH, 'utf8')
// 2026-11-07 修：只认「未注释的」 `    - id: X` 行；旧版用 includes('id: X') 会被注释块误命中，导致一条都不追加
const ids = ['superagent-lite', 'superagent-panel', 'handoff-watch3']
const hasActiveId = (text, id) => text.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && new RegExp('^    - id: ' + id + '\\s*$').test(l))
const missingIds = ids.filter((id) => !hasActiveId(cur, id))
if (missingIds.length === 0) {
  console.log('[apply] patch 里三条 insert 都已是未注释状态，跳过追加')
} else {
  const blocks = add.split(/\n(?=- insert:)/).filter((b) => b.trim())
  const keep = blocks.filter((b) => missingIds.some((id) => b.includes('- id: ' + id)))
  writeFileSync(patchFile, cur.replace(/\s*$/, '') + '\n\n' + keep.join('\n'), 'utf8')
  console.log('[apply] 已追加 ' + keep.length + ' 条 insert（缺: ' + missingIds.join(', ') + '）')
}
console.log('')
console.log('[apply] 完成。下一步：重启 DSH（client 半部必须冷启动），再按 README 的验收清单核对。')
