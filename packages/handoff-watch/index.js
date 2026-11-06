/**
 * dsh-handoff-watch3 — 把 Codex Stop 钩子写下的队列事件，投递成本会话的一条用户消息。
 * M4 修正：带 sa-ticket 标记的 handoff 由 superagent-lite 自己收口，这里跳过，避免双重通知。
 *
 * 投递必须走宿主的 ctx.schedule 服务（voice-push 实测：直接改 storages/schedule.json 无效，
 * 服务只在启动时全量读入内存，外部写入不会触发投递，且下次写盘会被覆盖）。
 */
export const name = 'handoff-watch3'
export const inject = []

import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

/** P02：deliveredFiles 只保留最近 50 条，超出丢最旧 */
const DELIVERED_FILES_LIMIT = 50

/** 纯逻辑：按字节游标读队列，逐条投递；返回可手动 tick 的实例（便于离线自测）。 */
export function createWatcher({ queueDir, sessionId, deliver, log = () => {} }) {
  const events = join(queueDir, 'events.jsonl')
  const cursorFile = join(queueDir, 'cursor.json')
  let offset = 0
  let lastMtime = 0
  // P02：已成功投递（或已按 sa-ticket 跳过）的文件内容哈希；旧 cursor.json 没有该字段也能跑
  let deliveredFiles = {}
  try {
    const c = JSON.parse(readFileSync(cursorFile, 'utf8'))
    if (typeof c.offset === 'number' && c.offset >= 0) offset = c.offset
    if (typeof c.mtimeMs === 'number') lastMtime = c.mtimeMs
    if (c.deliveredFiles && typeof c.deliveredFiles === 'object' && !Array.isArray(c.deliveredFiles)) {
      for (const [k, v] of Object.entries(c.deliveredFiles)) if (typeof v === 'string' && v) deliveredFiles[k] = v
    }
  } catch {}
  let busy = false

  const hashOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
  const fileKey = (file) => { try { return resolve(String(file)) } catch { return String(file) } }
  // 记哈希并保持「最近 50 条」：重复 key 先删后插（刷新为最新），超限丢最旧
  function rememberDelivered(file, hash) {
    const key = fileKey(file)
    if (deliveredFiles[key] === hash) return
    if (Object.prototype.hasOwnProperty.call(deliveredFiles, key)) delete deliveredFiles[key]
    deliveredFiles[key] = hash
    let keys = Object.keys(deliveredFiles)
    while (keys.length > DELIVERED_FILES_LIMIT) {
      delete deliveredFiles[keys[0]]
      keys = Object.keys(deliveredFiles)
    }
  }

  function persist() {
    try {
      writeFileSync(cursorFile, JSON.stringify({ offset, mtimeMs: lastMtime, updatedAt: new Date().toISOString(), deliveredFiles }, null, 1), 'utf8')
    } catch {}
  }

  async function tick() {
    if (busy) return
    busy = true
    try {
      if (!existsSync(events)) return
      const st = statSync(events)
      const size = st.size
      // 文件被截断或原地重写（mtime 变了但大小相同）→ 从头读
      if (size < offset) { offset = 0 }
      else if (size === offset) {
        if (st.mtimeMs === lastMtime) return
        offset = 0
      }
      const buf = readFileSync(events)
      const slice = buf.subarray(offset, size).toString('utf8')
      const lines = slice.split('\n')
      let consumed = 0
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]
        const bytes = Buffer.byteLength(line, 'utf8') + 1
        let rec = null
        try { rec = JSON.parse(line) } catch { consumed += bytes; continue }
        if (!rec || !rec.file || !existsSync(rec.file)) { consumed += bytes; continue }
        // superagent-lite 的 handoff 自带 sa-ticket 标记：由插件按 Stop 事件收口，不投递成「handoff 就绪」
        // P01：锚定到行首（允许前置空白/列表符），正文里「引用」这句不算标记
        let body = ''
        try { body = readFileSync(rec.file, 'utf8') } catch {}
        const hash = hashOf(body)
        const key = fileKey(rec.file)
        // P02：同一文件内容已成功投递过 → 按已消费处理，不再投
        if (deliveredFiles[key] === hash) {
          consumed += bytes
          log('skipped duplicate handoff (same content): ' + rec.file)
          continue
        }
        if (/^[ \t]*-?[ \t]*sa-ticket:[ \t]*sa-\d+/m.test(body)) {
          consumed += bytes
          rememberDelivered(rec.file, hash)
          log('skipped superagent handoff: ' + rec.file)
          continue
        }
        try {
          await deliver(rec, sessionId)
          consumed += bytes
          rememberDelivered(rec.file, hash)
          log('delivered: ' + rec.file)
        } catch (e) {
          // P02：投递失败不记哈希，下轮仍要重试
          log('deliver failed (will retry): ' + (e && e.message ? e.message : String(e)))
          break
        }
      }
      if (consumed > 0) { offset += consumed; lastMtime = st.mtimeMs; persist() }
    } finally { busy = false }
  }

  return { tick, get offset() { return offset } }
}

/** 纯逻辑：盯 approvals/pending，把每个新请求投递一次（用 seen.json 去重）。 */
export function createApprovalsWatcher({ approvalsDir, deliver, log = () => {} }) {
  const pendingDir = join(approvalsDir, 'pending')
  const seenFile = join(approvalsDir, 'seen.json')
  let seen = new Set()
  try { seen = new Set(JSON.parse(readFileSync(seenFile, 'utf8')).ids || []) } catch {}
  let busy = false
  function persist() { try { writeFileSync(seenFile, JSON.stringify({ ids: [...seen] }, null, 1), 'utf8') } catch {} }
  async function tick() {
    if (busy) return
    busy = true
    try {
      if (!existsSync(pendingDir)) return
      const files = readdirSync(pendingDir).filter((f) => f.endsWith('.json')).sort()
      for (const f of files) {
        if (seen.has(f)) continue
        let rec = null
        try { rec = JSON.parse(readFileSync(join(pendingDir, f), 'utf8')) } catch { seen.add(f); persist(); continue }
        try {
          await deliver(rec)
          seen.add(f); persist(); log('approval delivered: ' + f)
        } catch (e) {
          log('approval deliver failed (will retry): ' + (e && e.message ? e.message : String(e)))
          break
        }
      }
    } finally { busy = false }
  }
  return { tick }
}

export function buildPrompt(file) {
  return '【handoff 就绪】Codex 已完成并写入 ' + file + ' 。按 handoff 协议处理：先跑 node handoff/check-handoff.mjs 校验它，再复现证据命令、核对产物；通过就归档到 done/ 并写验收记录，不通过就退回并说明缺什么。'
}

export function apply(ctx, config = {}) {
  const queueDir = config.queueDir || join(homedir(), '.dsh', 'queue')
  const sessionId = config.sessionId || process.env.DSH_SESSION_ID || ''
  const pollMs = Math.max(500, Number(config.pollMs || 2000))
  const title = config.title || 'handoff 就绪'
  const logFile = join(queueDir, 'watch.log')
  const log = (msg) => {
    try { mkdirSync(queueDir, { recursive: true }); appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n', 'utf8') } catch {}
  }

  let schedule = null
  try {
    ctx.inject(['schedule'], (childCtx) => { schedule = childCtx.schedule })
  } catch { schedule = null }

  const targetFile = config.targetFile || ''
  const resolveTarget = (fallback) => {
    if (!targetFile) return fallback
    try {
      const j = JSON.parse(readFileSync(targetFile, 'utf8'))
      if (j && typeof j.sessionId === 'string' && j.sessionId) return j.sessionId
    } catch {}
    return fallback
  }

  const deliver = async (rec, fallback) => {
    if (!schedule || typeof schedule.create !== 'function') throw new Error('schedule service not ready')
    const target = resolveTarget(fallback)
    if (!target) throw new Error('sessionId not configured')
    const at = new Date(Date.now() + 1000).toISOString()
    await schedule.create(target, { title, prompt: buildPrompt(rec.file), at })
  }

  const approvalsDir = config.approvalsDir || join(queueDir, '..', 'approvals')
  const summarize = (v) => {
    const raw = v && typeof v === 'object' && typeof v.command === 'string' ? v.command : JSON.stringify(v)
    return String(raw || '').replace(/\s+/g, ' ').slice(0, 300)
  }
  const approvalPrompt = (rec) => '【Codex 权限请求】id=' + rec.id + '；工具=' + rec.tool_name + '；请求=' + summarize(rec.tool_input) + '；请在 ' + join(approvalsDir, 'res', rec.id + '.json') + ' 写 {"decision":"allow"} 或 {"decision":"deny","reason":"..."}；超时 ' + Math.round(Number(rec.timeoutMs || 60000) / 1000) + ' 秒后自动弃权。'
  const deliverApproval = async (rec) => {
    if (!schedule || typeof schedule.create !== 'function') throw new Error('schedule service not ready')
    const target = resolveTarget(sessionId)
    if (!target) throw new Error('sessionId not configured')
    await schedule.create(target, { title: 'Codex 权限请求', prompt: approvalPrompt(rec), at: new Date(Date.now() + 1000).toISOString() })
  }

  const watcher = createWatcher({ queueDir, sessionId, deliver, log })
  const approvals = createApprovalsWatcher({ approvalsDir, deliver: deliverApproval, log })
  ctx.effect(() => {
    const timer = setInterval(() => { void watcher.tick(); void approvals.tick() }, pollMs)
    log('watcher started: queue=' + queueDir + ' approvals=' + approvalsDir + ' session=' + sessionId + ' poll=' + pollMs + 'ms')
    return () => clearInterval(timer)
  }, 'handoff-watch.poll()')
}