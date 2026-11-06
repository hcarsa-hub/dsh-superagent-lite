#!/usr/bin/env node
// 反向操作：删掉本包在 profile 里的 link，并打印要删掉的 patch 段落。
// **不删除任何数据目录，也不改宿主文件**。
//
// 用法：
//   node scripts/uninstall.mjs --profile <profile 目录> [--name dsh-plugin-subagent-lite] [--dry-run]
//   node scripts/uninstall.mjs --help

import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-plugin-subagent-lite'

const HELP = [
  'dsh-plugin-subagent-lite uninstall',
  '',
  '  node scripts/uninstall.mjs --profile <profile 目录> [--name <包名>] [--dry-run]',
  '',
  '  --profile <dir>   DSH profile 目录（含 node_modules 与 cordis.patch.yml）',
  '  --name <pkg>      node_modules 下要删除的包名，默认 dsh-plugin-subagent-lite',
  '  --dry-run         只打印将要做什么，不删除任何东西',
  '  --help            显示本帮助',
  '',
  '只删 link 并打印要删的 YAML 段落；数据目录需要你自己决定保留还是删除。',
].join('\n')

function parse(argv) {
  const o = { profile: '', name: PKG_NAME, dryRun: false, help: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--profile' || a.startsWith('--profile=')) o.profile = a === '--profile' ? String(argv[++i] || '') : a.slice('--profile='.length)
    else if (a === '--name' || a.startsWith('--name=')) o.name = a === '--name' ? String(argv[++i] || '') : a.slice('--name='.length)
    else o.unknown.push(a)
  }
  return o
}

const o = parse(process.argv.slice(2))
if (o.help) { console.log(HELP); process.exit(0) }
if (o.unknown.length) { console.error('unknown args: ' + o.unknown.join(' ')); console.log(HELP); process.exit(2) }

const profile = o.profile ? resolve(o.profile) : join(homedir(), '.dsh', 'profiles', 'desktop')
const linkPath = join(profile, 'node_modules', o.name)
const target = realpathSync(PKG_ROOT)

const patchBlock = [
  '# 从 ' + join(profile, 'cordis.patch.yml') + ' 里删掉下面这段（整段注释掉也行）：',
  '- insert:',
  '    - id: subagent-lite',
  '      name: ' + o.name,
].join('\n')

console.log('link   : ' + linkPath)
let st = null
try { st = lstatSync(linkPath) } catch {}
if (!st) {
  console.log('该位置没有东西（可能已卸载）。')
  console.log('\n' + patchBlock)
  process.exit(0)
}
let pointsTo = null
try { pointsTo = realpathSync(linkPath) } catch {}
const ours = pointsTo && pointsTo.toLowerCase() === target.toLowerCase()
if (!ours) {
  console.error('该位置存在但不是指向本包的 link（' + (pointsTo || '未知目标') + '），不改动。')
  console.error('确认后可手动删除：' + linkPath)
  process.exit(1)
}
if (o.dryRun) console.log('[dry-run] 将删除 link：' + linkPath)
else { rmSync(linkPath, { recursive: true, force: true }); console.log('已删除 link：' + linkPath) }
console.log('\n数据目录（state.json / evidence / archive）没有动；如需清理请手动处理。')
console.log('\n' + patchBlock)
