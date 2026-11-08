#!/usr/bin/env node
// verify.mjs —— 公开仓自检：脱敏 + 包身份四件套 + 模板默认值
// 用法：node tools/verify.mjs        末行 "VERIFY: ALL PASS"，有 FAIL 时 exit 1
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rows = []
const rec = (id, ok, detail) => { rows.push({ id, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

function walk(d) {
  const out = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
const files = walk(ROOT)
const textFiles = files.filter((f) => /\.(mjs|js|json|md|yml|yaml|txt)$/i.test(f))
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/')

// ── A. 脱敏：不许出现真实本机痕迹 ─────────────────────────────────
{
  const bad = []
  for (const f of textFiles) {
    if (rel(f) === 'tools/verify.mjs') continue   // 本文件里有「凭据形状」的检测式样，自指不算泄漏
    const t = readFileSync(f, 'utf8')
    // 真实用户名（占位 <you> / <user> 不算）
    const isPlaceholder = (x) => /[<{]/.test(x)   // <you> / <user> / <profile> 这类占位符不算泄漏
    const user = (t.match(/[A-Za-z]:[\\/]+Users[\\/]+[^\s'"]+/g) || []).filter((x) => !isPlaceholder(x))
    // 盘符绝对路径（代码里的机器路径）；文档示例 / 占位符不算
    const drive = (t.match(/[A-Za-z]:\\\\[^\s'"]+/g) || []).filter((x) => !isPlaceholder(x))
    // 会话 id
    const sid = t.match(/session-[0-9a-f]{8}-/g) || []
    // 凭据形状
    const secret = t.match(/(sk-proj-|sk-ant-|ghp_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY)/g) || []
    if (user.length || drive.length || sid.length || secret.length) {
      bad.push({ file: rel(f), user: user.slice(0, 2), drive: drive.slice(0, 2), sid: sid.slice(0, 2), secret: secret.slice(0, 2) })
    }
  }
  rec('A-无本机痕迹', bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 3)) : textFiles.length + ' 个文本文件扫完，0 处')
}

// ── B. 包身份四件套 ──────────────────────────────────────────────
const PKGS = [
  { dir: 'dsh-plugin-superagent-lite', client: false },
  { dir: 'superagent-lite-panel', client: true },
  { dir: 'handoff-watch', client: false },
]
for (const p of PKGS) {
  const base = join(ROOT, 'packages', p.dir)
  let pkg = null
  try { pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')) } catch { rec('B-' + p.dir, false, 'package.json 缺失或不可解析'); continue }
  const idx = readFileSync(join(base, 'index.js'), 'utf8')
  const expName = (idx.match(/export const name = ['"]([^'"]+)['"]/) || [])[1] || ''
  let patch = ''
  try { patch = readFileSync(join(base, 'cordis.patch.yml'), 'utf8') } catch {}
  const unq = (x) => String(x || '').replace(/^['"]|['"]$/g, '')
  const pid = unq((patch.match(/^\s*-\s*id:\s*(\S+)/m) || [])[1])
  const pname = unq((patch.match(/^\s*name:\s*(\S+)/m) || [])[1])
  const fails = []
  const hasOwnPatch = Boolean(patch.trim())
  if (!expName) fails.push('index.js 缺 export const name')
  if (hasOwnPatch && !pid) fails.push('自带 patch 缺 id')
  if (hasOwnPatch && pname !== pkg.name) fails.push('自带 patch name(' + pname + ') ≠ package.json name(' + pkg.name + ')')
  if (p.client) {
    const cj = readFileSync(join(base, 'client.js'), 'utf8')
    const lid = (cj.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/) || [])[1] || ''
    if (lid !== pkg.name) fails.push('client.js loader id(' + lid + ') ≠ package name')
  }
  rec('B-' + p.dir + ' 身份四件套', fails.length === 0,
    fails.length ? fails.join(' / ')
      : pkg.name + '@' + pkg.version + (hasOwnPatch ? ' / id=' + pid : ' / 无自带 patch（由仓库模板统一挂载）'))
}

// ── C. 安装模板 ─────────────────────────────────────────────────
{
  const tpl = readFileSync(join(ROOT, 'cordis.patch.bundle.yml'), 'utf8')
  const fails = []
  if (!/^\s*autoJudge:\s*true/m.test(tpl)) fails.push('缺 autoJudge: true')
  if (!/^\s*judgeRotate:\s*true/m.test(tpl)) fails.push('缺 judgeRotate: true')
  if (!/watch[\s\S]{0,400}?sessionId:/.test(tpl)) fails.push('watcher 块缺 sessionId')
  const entries = (tpl.match(/^- insert:/gm) || []).length
  if (entries !== 3) fails.push('应有 3 条 insert，实得 ' + entries)
  for (const id of ['superagent-lite', 'superagent-panel', 'handoff-watch3']) if (!new RegExp('^- insert:[\\s\\S]*?- id: ' + id, 'm').test(tpl)) fails.push('缺 insert: ' + id)
  rec('C-安装模板', fails.length === 0, fails.length ? fails.join(' / ') : '3 条 insert / autoJudge+judgeRotate 默认开 / watcher 带 sessionId')
}

// ── D. 文档完整性 ───────────────────────────────────────────────
{
  const need = ['README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'install.mjs', 'uninstall.mjs', 'cordis.patch.bundle.yml']
  const missing = need.filter((f) => { try { statSync(join(ROOT, f)); return false } catch { return true } })
  const notice = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8')
  const ok = missing.length === 0 && /Super-Agent|superagent-prototype/.test(notice)
  rec('D-文档与致谢', ok, ok ? need.length + ' 个必需文件齐 + NOTICE 含上游致谢' : ('缺: ' + missing.join(',') + (ok ? '' : ' / NOTICE 缺致谢')))
}

const fails = rows.filter((r) => !r.ok)
console.log('')
console.log(fails.length ? ('VERIFY: ' + fails.length + ' FAIL') : 'VERIFY: ALL PASS')
process.exit(fails.length ? 1 : 0)
