#!/usr/bin/env node
// 把本包 link 到 DSH profile 的 node_modules，并打印要贴的 cordis.patch.yml 片段。
// 只做两件事：建/检查 link、打印片段。**不会改宿主的任何文件**（patch 由你手动贴）。
//
// 用法：
//   node scripts/install.mjs --profile <profile 目录> [--name dsh-plugin-subagent-lite] [--dry-run]
//   node scripts/install.mjs --help

import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-plugin-subagent-lite'

const HELP = [
  'dsh-plugin-subagent-lite install',
  '',
  '  node scripts/install.mjs --profile <profile 目录> [--name <包名>] [--dry-run]',
  '',
  '  --profile <dir>   DSH profile 目录（含 node_modules 与 cordis.patch.yml），例如',
  '                    <home>/.dsh/profiles/desktop',
  '  --name <pkg>      在 node_modules 下使用的包名，默认 dsh-plugin-subagent-lite；',
  '                    宿主若只认带 scope 的本地包，可传 @local/dsh-plugin-subagent-lite',
  '  --dry-run         只打印将要做什么，不创建/删除任何东西',
  '  --help            显示本帮助',
  '',
  '本脚本只建 junction 并打印 patch 片段，不会改宿主的 cordis.patch.yml。',
].join('\n')

function parse(argv) {
  const o = { profile: '', name: PKG_NAME, dryRun: false, help: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--profile' || a.startsWith('--profile=')) {
      o.profile = a === '--profile' ? String(argv[++i] || '') : a.slice('--profile='.length)
    } else if (a === '--name' || a.startsWith('--name=')) {
      o.name = a === '--name' ? String(argv[++i] || '') : a.slice('--name='.length)
    } else o.unknown.push(a)
  }
  return o
}

const o = parse(process.argv.slice(2))
if (o.help) { console.log(HELP); process.exit(0) }
if (o.unknown.length) { console.error('unknown args: ' + o.unknown.join(' ')); console.log(HELP); process.exit(2) }
if (!o.name || /[\\/]$/.test(o.name)) { console.error('invalid --name: ' + o.name); process.exit(2) }

const profile = o.profile ? resolve(o.profile) : join(homedir(), '.dsh', 'profiles', 'desktop')
if (!existsSync(profile)) {
  console.error('profile 目录不存在：' + profile)
  console.error('先确认宿主 profile 路径，再用 --profile <dir> 指定。')
  process.exit(1)
}
const nmDir = join(profile, 'node_modules')
const linkPath = join(nmDir, o.name)
const target = realpathSync(PKG_ROOT)

const patchSnippet = [
  '# 贴到 ' + join(profile, 'cordis.patch.yml') + '（与其它 - insert: 平级）',
  '- insert:',
  '    - id: subagent-lite',
  '      name: ' + o.name,
  '      config:',
  "        ownerSessions: ['<owner 会话 id>']   # 必填：空数组时所有写工具会被拒",
  '        # stateDir: <你的数据目录>            # 可选，默认 <home>/.dsh/subagent',
].join('\n')

console.log('包目录 : ' + target)
console.log('profile: ' + profile)
console.log('link   : ' + linkPath)

let existing = null
try { existing = lstatSync(linkPath) } catch {}
if (existing) {
  let pointsTo = null
  try { pointsTo = realpathSync(linkPath) } catch {}
  if (pointsTo && pointsTo.toLowerCase() === target.toLowerCase()) {
    console.log('已 link 到本包，无需重复创建。')
  } else {
    console.error('目标位置已被占用：' + linkPath + (pointsTo ? ' → ' + pointsTo : ''))
    console.error('这可能是另一个版本的包。先确认后手动删除该 link（或换 --name）再重试。')
    process.exit(1)
  }
} else {
  if (o.dryRun) {
    console.log('[dry-run] 将创建 junction：' + linkPath + ' → ' + target)
  } else {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    console.log('已创建 junction：' + linkPath)
  }
}

if (!o.dryRun) {
  console.log('\n注意：宿主若只从 profile 的 dependencies 解析插件，还需要在 ' + join(profile, 'package.json') + ' 里加一条：')
  console.log('  "dependencies": { "' + o.name + '": "link:' + target.replace(/\\/g, '/') + '" }')
  console.log('  然后在该 profile 下跑一次包管理器（pnpm i / npm i）让它登记。')
}
console.log('\n下一步：\n' + patchSnippet)
console.log('\n然后重启宿主。验证：会话里调 sa_whoami 能返回 role 即挂载成功。')
