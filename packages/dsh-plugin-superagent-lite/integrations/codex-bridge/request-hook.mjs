#!/usr/bin/env node
/**
 * Codex PermissionRequest hook —— 把 Codex 的权限请求转成「文件里的一个待办」，等 DSH 侧写回决策。
 *
 * 判定顺序（先命中先返回）：deny 规则 → apply_patch 全量路径 → 链式/变量 defer →
 * workspace-write 路径校验 → 只读 allow → 默认 defer（交回 Codex 自己的弹窗）。
 *
 * 只读写本地文件：不联网、不读 auth.json/token、不执行 DSH/Codex 命令；任何异常都走「弃权」（defer）。
 *
 * 环境变量：
 *  - APPROVALS_DIR       审批目录；默认 <cwd>/handoff/approvals
 *  - POLICY_FILE         策略文件；默认 <APPROVALS_DIR>/policy.json
 *  - APPROVAL_TIMEOUT_MS 等决策的最长时间；默认 60000（60 秒——再长 Codex 回合就卡住，短了人来不及看）
 *
 * 目录契约（详见 contract.md）：
 *  - 请求：<APPROVALS_DIR>/pending/<id>.json
 *  - 决策：<APPROVALS_DIR>/res/<id>.json   {"decision":"allow"} 或 {"decision":"deny","reason":"..."}
 *  - 审计：<APPROVALS_DIR>/log.jsonl（每次判定一行，写失败也吞）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { join, resolve, isAbsolute, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

// 默认目录跟着「当前工作目录」走：Codex 在哪个项目里跑，审批就落在那个项目的 handoff/approvals 下
const DIR = process.env.APPROVALS_DIR || join(process.cwd(), 'handoff', 'approvals')
const POLICY_FILE = process.env.POLICY_FILE || join(DIR, 'policy.json')
// 60 秒：人能在 Codex 回合被卡住之前看到并处理；超过就弃权（Codex 回落到自己的弹窗）
const TIMEOUT = Number(process.env.APPROVAL_TIMEOUT_MS || 60000)
// 250ms 轮询：决策文件通常 <1s 内落盘，250ms 是「及时」与「不刷盘」的折中
const POLL = 250

function log(o) { try { appendFileSync(join(DIR, 'log.jsonl'), JSON.stringify(o) + '\n', 'utf8') } catch {} }

const DIAG = /\s*\|\s*(Select-Object|Format-Table|Format-List|Format-Wide|Out-String|Measure-Object|Sort-Object|ConvertTo-Json|ConvertTo-Csv)\b[^|]*$/i
const PATH_ARG = /-(?:LiteralPath|Path|Destination|FilePath)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi
const WRITE_CMDS = /^\s*(New-Item|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item)\b/i

function stripDiag(cmd) {
  let c = cmd
  for (let i = 0; i < 4; i++) { const m = DIAG.exec(c); if (!m) break; c = c.slice(0, m.index) }
  return c
}

function extractPaths(cmd) {
  const out = []
  PATH_ARG.lastIndex = 0
  let m
  while ((m = PATH_ARG.exec(cmd))) { const v = m[1] || m[2] || m[3]; if (v) out.push(v) }
  return out
}

const hasVar = (s) => /[$%\u0060]/.test(s)

function inWorkspace(p, cwd, wsRoot) {
  if (!p || hasVar(p)) return false
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p)
  const a = abs.toLowerCase().replace(/[\\/]+$/, '')
  const w = wsRoot.toLowerCase().replace(/[\\/]+$/, '')
  return a === w || a.startsWith(w + sep) || a.startsWith(w + '/')
}

/** apply_patch：patch 文本在 tool_input.command；全量校验 Add/Update 路径，Delete/Move 直接拒。 */
function evaluatePatch(input, raw, cwd, ws, policy) {
  const rule = (policy.allow || []).find((r) => r.type === 'apply-patch')
  if (!rule) return { decision: 'defer', rule: 'no-apply-patch-rule' }
  const dirs = []
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm
  let m
  while ((m = re.exec(raw))) dirs.push({ kind: m[1], path: m[2].trim() })
  const moves = []
  const rm = /^\*\*\* Move to: (.+)$/gm
  while ((m = rm.exec(raw))) moves.push(m[1].trim())
  if (dirs.length === 0 && moves.length === 0) return { decision: 'defer', rule: 'patch-unparsed' }
  if (dirs.some((d) => d.kind === 'Delete') || moves.length > 0) return { decision: 'deny', rule: 'patch-delete-or-move', reason: 'patch 含删除/移动' }
  const paths = dirs.map((d) => d.path)
  const wsRoot = ws || cwd
  for (const path of paths) {
    if (!inWorkspace(path, cwd, wsRoot)) return { decision: 'defer', rule: 'patch-outside', reason: path }
  }
  const nonAscii = /[\u0080-\uffff]/.test(raw)
  if (nonAscii && paths.some((x) => /\.ps1$/i.test(x))) return { decision: 'defer', rule: 'patch-ps1-encoding', reason: '含中文的 .ps1 必须走 DSH 的 BOM 闸门' }
  return { decision: 'allow', rule: rule.id, reason: rule.reason }
}

/** 多工作区：取 cwd 的最长前缀命中；兼容旧 workspace 单值。 */
function resolveRoot(policy, cwd) {
  const list = Array.isArray(policy.workspaces) && policy.workspaces.length
    ? policy.workspaces.map((w) => ({ id: w.id || w.root, root: String(w.root || '') })).filter((w) => w.root)
    : (typeof policy.workspace === 'string' && policy.workspace ? [{ id: 'default', root: policy.workspace }] : [])
  const c = String(cwd || '').toLowerCase().replace(/[\\/]+$/, '')
  let best = null
  for (const w of list) {
    const r = w.root.toLowerCase().replace(/[\\/]+$/, '')
    if (c === r || c.startsWith(r + '\\') || c.startsWith(r + '/')) {
      if (!best || r.length > best.root.length) best = w
    }
  }
  return best
}

function evaluate(input) {
  let policy = null
  try { policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8')) } catch { return { decision: 'defer', rule: 'no-policy' } }
  const cwd = String(input.cwd || '')
  const match = resolveRoot(policy, cwd)
  if (!match) return { decision: 'defer', rule: 'out-of-workspace' }
  const ws = match.root
  // MCP：记忆写类一律拒绝，其余 defer（mcp 工具没有 command，必须放在 no-command 之前）
  const mcpTool = String(input.tool_name || '')
  if (/^mcp__/i.test(mcpTool)) {
    const mcpRule = (policy.deny || []).find((r) => r.type === 'mcp-memory-write')
    if (mcpRule && mcpRule.pattern && new RegExp(mcpRule.pattern, 'i').test(mcpTool)) {
      return { decision: 'deny', rule: mcpRule.id, reason: mcpRule.reason }
    }
    return { decision: 'defer', rule: 'mcp-unclassified' }
  }

  const ti = input.tool_input || {}
  const raw = typeof ti.command === 'string' ? ti.command : ''
  if (!raw) return { decision: 'defer', rule: 'no-command' }

  // 1) deny 永远先判：链式里出现破坏性片段也直接拒
  const testRaw = (r) => { try { return new RegExp(r.regex, 'i').test(raw) } catch { return false } }
  for (const r of policy.deny || []) { if (!r.regex) continue; if (testRaw(r)) return { decision: 'deny', rule: r.id, reason: r.reason } }

  // 2) apply_patch：按 patch 全量路径判（文本在 tool_input.command，2026-11-03 抓到真实样本）
  if (String(input.tool_name || '').toLowerCase() === 'apply_patch') {
    return evaluatePatch(input, raw, cwd, ws, policy)
  }

  // 3) 剥尾部只读诊断管道
  const cmd = stripDiag(raw)

  // 3) 链式/重定向/变量 → defer（必须早于 allow）
  if (/[;|&\u0060<>\n]/.test(cmd)) return { decision: 'defer', rule: 'chained-command' }
  if (hasVar(cmd)) return { decision: 'defer', rule: 'variable-expansion' }

  // 4) workspace-write：路径前缀校验（替代关键词放行）
  const wsRule = (policy.allow || []).find((r) => r.type === 'workspace-write')
  if (wsRule && WRITE_CMDS.test(cmd)) {
    const paths = extractPaths(cmd)
    if (paths.length === 0) return { decision: 'defer', rule: 'workspace-write-no-path' }
    const wsRoot = ws || cwd
    const bad = paths.find((p) => !inWorkspace(p, cwd, wsRoot))
    if (bad) return { decision: 'defer', rule: 'workspace-write-outside', reason: bad }
    return { decision: 'allow', rule: wsRule.id, reason: wsRule.reason }
  }

  // 5) 只读等普通 allow（单条命令）
  const test = (r) => { try { return new RegExp(r.regex, 'i').test(cmd) } catch { return false } }
  for (const r of policy.allow || []) { if (r.type) continue; if (test(r)) return { decision: 'allow', rule: r.id, reason: r.reason } }
  return { decision: policy.default === 'allow' ? 'allow' : 'defer', rule: 'default' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let input = null
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { log({ t: Date.now(), kind: 'bad-input' }); return }
  if (!input || (input.hook_event_name && input.hook_event_name !== 'PermissionRequest')) return

  const verdict = evaluate(input)
  // 工作区外（含私密区）：**弃权**，不写 pending、不投递——否则命令原文会漏进本桥会话。
  // Codex 会回落到它自己的审批弹窗，由该工作区的用户自己处理。
  if (verdict.rule === 'out-of-workspace') {
    log({ t: Date.now(), kind: 'abstain', tool: input.tool_name || '', rule: verdict.rule })
    return
  }
  if (verdict.decision === 'allow' || verdict.decision === 'deny') {
    log({ t: Date.now(), kind: 'policy', tool: input.tool_name || '', rule: verdict.rule, decision: verdict.decision, reason: verdict.reason || null })
    const decision = verdict.decision === 'deny'
      ? { behavior: 'deny', message: 'DSH policy: ' + (verdict.reason || verdict.rule) }
      : { behavior: 'allow' }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
    return
  }

  const id = randomUUID()
  const ti = input.tool_input || null
  const req = {
    id, ts: Date.now(), at: new Date().toISOString(),
    tool_name: input.tool_name || '',
    tool_input: ti,
    cwd: input.cwd || '', session_id: input.session_id || null, turn_id: input.turn_id || null, timeoutMs: TIMEOUT,
  }
  mkdirSync(join(DIR, 'pending'), { recursive: true })
  mkdirSync(join(DIR, 'res'), { recursive: true })
  writeFileSync(join(DIR, 'pending', id + '.json'), JSON.stringify(req, null, 1), 'utf8')
  const keys = ti && typeof ti === 'object' ? Object.keys(ti) : []
  log({ t: Date.now(), kind: 'request', id, tool: req.tool_name, rule: verdict.rule, inputKeys: keys })

  const deadline = Date.now() + TIMEOUT
  while (Date.now() < deadline) {
    await sleep(POLL)
    const f = join(DIR, 'res', id + '.json')
    if (!existsSync(f)) continue
    let r = null
    try { r = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
    const deny = r && r.decision === 'deny'
    log({ t: Date.now(), kind: 'decision', id, tool: req.tool_name, decision: deny ? 'deny' : 'allow', latencyMs: Date.now() - req.ts, reason: (r && typeof r.reason === 'string') ? r.reason.slice(0, 200) : null })
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: deny ? { behavior: 'deny', message: (r && r.reason) || 'Denied by DSH policy.' } : { behavior: 'allow' } } }))
    return
  }
  log({ t: Date.now(), kind: 'timeout', id, latencyMs: Date.now() - req.ts })
}

main().catch((e) => { try { log({ t: Date.now(), kind: 'error', msg: String(e && e.message ? e.message : e) }) } catch {} })