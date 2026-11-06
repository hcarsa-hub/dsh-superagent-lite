#!/usr/bin/env node
/**
 * Codex Stop hook —— 把「Codex 回合结束」变成一条本地文件队列事件。
 *
 * 契约（详见 contract.md）：
 *  - stdin 读一个 JSON：{ hook_event_name, session_id, turn_id, cwd }
 *  - 只认 hook_event_name === 'Stop'（缺省时按 Stop 处理，兼容老版本）
 *  - 找 handoff 文件：先 <cwd>/handoff/inbox/latest.md，找不到再 <HANDOFF_ROOT>/handoff/inbox/latest.md
 *  - 新鲜度：默认 15 分钟（HANDOFF_FRESH_MS），超过当 stale 不投
 *  - 去重：<HANDOFF_QUEUE>/state.json 记「文件绝对路径 → mtimeMs」，同文件无新 mtime 不再触发
 *  - 事件：向 <HANDOFF_QUEUE>/events.jsonl 追加一行 {ts,sessionId,turnId,cwd,file,mtimeMs,size}，
 *          同时写 last.json，并把动作记到 hook.log（写失败也吞）
 *
 * 铁律：fail-open —— 任何异常都吞掉、exit 0、stdout 打 {}；不联网、不读凭据、不执行 DSH/Codex 命令。
 *
 * 环境变量：
 *  - HANDOFF_ROOT      工作区根；默认 = 当前进程 cwd（在 Codex 里就是该回合的工作目录）
 *  - HANDOFF_FILE      直接指定 handoff 文件（优先级最高，方便自测）
 *  - HANDOFF_QUEUE     队列目录；默认 <HANDOFF_ROOT>/handoff/queue
 *  - HANDOFF_FRESH_MS  认多新的 handoff；默认 900000（15 分钟）
 */
import { readFileSync, statSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.env.HANDOFF_ROOT || process.cwd()
// 队列固定在「根」下面：DSH 侧 watcher / 插件只盯这一处；handoff 文件则按 Codex 当前 cwd 找
const QUEUE = process.env.HANDOFF_QUEUE || join(ROOT, 'handoff', 'queue')
const FRESH = Number(process.env.HANDOFF_FRESH_MS || 15 * 60 * 1000)

/** 先在 cwd 下找 handoff/inbox/latest.md（新项目零配置），找不到再用根目录那份；HANDOFF_FILE 直接指定优先。 */
function pickFile(cwd) {
  const explicit = process.env.HANDOFF_FILE
  if (explicit) { try { statSync(explicit); return explicit } catch {} }
  const local = join(cwd, 'handoff', 'inbox', 'latest.md')
  try { statSync(local); return local } catch {}
  try { const fallback = join(ROOT, 'handoff', 'inbox', 'latest.md'); statSync(fallback); return fallback } catch {}
  return null
}

function trace(line) {
  try { mkdirSync(QUEUE, { recursive: true }); appendFileSync(join(QUEUE, 'hook.log'), new Date().toISOString() + ' ' + line + '\n', 'utf8') } catch {}
}

function main(raw) {
  let input
  try { input = JSON.parse(raw) } catch { trace('bad-input'); return }
  if (!input || typeof input !== 'object') return
  // 只认 Stop；其它事件（PreToolUse、PermissionRequest…）直接返回，不落任何东西
  if (input.hook_event_name && input.hook_event_name !== 'Stop') return

  const cwd = String(input.cwd || '')
  if (!cwd) { trace('no-cwd'); return }
  const file = pickFile(cwd)
  if (!file) { trace('no-handoff cwd=' + cwd); return }

  let st
  try { st = statSync(file) } catch { return }
  if (Date.now() - st.mtimeMs > FRESH) { trace('stale file=' + file); return }

  // 同一个文件只触发一次（按文件路径分别记 mtime，多个项目互不影响）
  const seenFile = join(QUEUE, 'state.json')
  let seen = {}
  try { seen = JSON.parse(readFileSync(seenFile, 'utf8')).seen || {} } catch {}
  const last = Number(seen[file] || 0)
  if (st.mtimeMs <= last) { trace('duplicate file=' + file); return }

  const rec = {
    ts: new Date().toISOString(),
    sessionId: input.session_id || null,
    turnId: input.turn_id || null,
    cwd,
    file,
    mtimeMs: st.mtimeMs,
    size: st.size,
  }
  mkdirSync(QUEUE, { recursive: true })
  appendFileSync(join(QUEUE, 'events.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
  writeFileSync(join(QUEUE, 'last.json'), JSON.stringify(rec, null, 1), 'utf8')
  trace('event file=' + file)
  seen[file] = st.mtimeMs
  writeFileSync(seenFile, JSON.stringify({ seen }, null, 1), 'utf8')
}

// fail-open：任何异常都不许冒泡，也不许阻断 Codex 回合
try { main(readFileSync(0, 'utf8')) } catch {}
process.stdout.write('{}')
