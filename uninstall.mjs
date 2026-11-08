#!/usr/bin/env node
// uninstall.mjs —— 只删 junction，不动 patch（patch 回滚手工做，见 README）
import { lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || ''
const pi = process.argv.indexOf('--profile')
const PROFILE = pi >= 0 ? process.argv[pi + 1] : join(HOME, '.dsh', 'profiles', 'desktop')
// 2026-11-07 修：主名 3 + 旧名别名 2 都要删（旧版只删 3 个主名）
const names = [
  'dsh-plugin-superagent-lite',
  'dsh-superagent-lite-panel',
  'dsh-plugin-handoff-watch',
  '@local/dsh-superagent-panel',
  '@local/dsh-handoff-watch3',
]
const links = names.map((n) => join(PROFILE, 'node_modules', ...n.split('/')))
// Refuse real directories/files before removing any junction; never recursively delete package data.
for (const l of links) {
  const st = lstatSync(l, { throwIfNoEntry: false })
  if (st && !st.isSymbolicLink()) {
    console.error('refuse (不是 junction/符号链接，未删除任何链接): ' + l)
    process.exit(3)
  }
}
for (const l of links) {
  if (lstatSync(l, { throwIfNoEntry: false })) {
    unlinkSync(l)
    console.log('removed ' + l)
  } else console.log('skip (不存在) ' + l)
}
console.log('')
console.log('patch 里的三条 insert 请手工注释掉（或恢复 .bak-bundle-* 备份），再重启 DSH。')
