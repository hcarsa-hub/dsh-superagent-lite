/**
 * superagent-panel v28 — Host 半部（v27 的归档证据/回滚全保留）：v26 的只读数据源全保留，新增「归档证据正文」（路径双重校验）与「归档回滚」（只写 commands 队列）。
 *
 * 只做一件事：把 handoff/superagent/state.json 读出来，翻译成面板要的 JSON，
 * 挂在 /superagent/* 上。**不写任何文件、不改工单状态、不碰主链路**。
 *
 * 契约（给 client 半部与人工 curl 共用）：
 *   GET  /superagent/selftest  -> { ok, stateDir, stateFile, tickets, error? }
 *   GET  /superagent/tickets   -> { generatedAt, counts, active, tickets:[...] }
 *   POST /superagent/reveal    -> { ok, path }   按 ticketId 找证据文件并用资源管理器选中（路径由宿主算，不接受任意路径）
 *   POST /superagent/close     -> { ok, queued } 手动结档：只写 commands/<id>.json，由 lite 的 tick 按状态机收口（面板不直接改 state.json）
 *   GET  /superagent/archive?q= -> { ok, total, rows } 已归档工单（archive/<前缀>.json），按 id/标题过滤
 *   GET  /superagent/archive/evidence?ticketId=&file= -> 归档证据：不带 file 列文件（Fact-<工单号>-<序号>），带 file 出正文
 *   GET  /superagent/archive/verdict?ticketId=sa-0xx -> { ok, ticketId, text } 归档判词（archive/verdicts/<id>.md）
 *   POST /superagent/rollback -> { ok, action } 归档回滚：只写 commands/*.json（restore / restore-all），由 lite 搬回
 *   GET  /superagent/evidence?ticketId=sa-006 -> { ok, path, relative, bytes, text, truncated }  给右侧实时预览
 *   GET  /superagent/diagnostics -> 12 项只读体检（异常降级 unverified，不 500，不写盘）
 *   POST /superagent/monitor/start|stop|restart -> 只控制包内 ctx-monitor.mjs（detached + pid；stop 校验命令行）
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, statSync, realpathSync, openSync, readSync, closeSync, accessSync, constants as fsConstants } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { connect as netConnect } from 'node:net'

function commandFileName(kind, id) {
  return kind + (id ? '-' + id : '') + '-' + Date.now() + '-' + randomUUID().replace(/-/g, '').slice(0, 8)
}
import { join, basename, sep, relative, isAbsolute } from 'node:path'

export const name = 'superagent-panel'
export const inject = []

const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'subagent')
const STATE_ORDER = { running: 0, ready: 1, queued: 2, blocked: 3, done: 4 }
const EVIDENCE_SKIP = new Set(['state.json', 'watchdog.json', 'heartbeat.json'])

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * N4：证据解析 —— 清单优先（ticket.artifacts + evidence/<id>/），再落目录扫描，最后才是历史文件名规则。
 * 迁移后历史文件已收进 evidence/<id>/，只靠文件名猜会 404，所以这里必须跟 lite12 用同一套顺序。
 */
function evidenceInfo(stateDir, t, scan = null) {
  const evRoot = join(stateDir, 'evidence')
  const man = Array.isArray(t.artifacts) ? t.artifacts : []
  for (const a of man) {
    try {
      const p = join(evRoot, String(a.rel || (t.id + '/' + a.name)))
      if (existsSync(p)) return { path: p, kind: 'manifest', count: man.length }
    } catch {}
  }
  if (!scan || scan.evidenceIds.has(String(t.id))) try {
    const names = readdirSync(join(evRoot, String(t.id))).filter((n) => /\.(md|json|txt)$/i.test(n)).sort()
    if (names.length) return { path: join(evRoot, String(t.id), names[0]), kind: 'dir', count: names.length }
  } catch {}
  const direct = []
  if (t.evidence) direct.push(String(t.evidence))
  direct.push(join(stateDir, 'codex-' + t.id + '.md'))
  for (const c of direct) { try { if (existsSync(c)) return { path: c, kind: 'legacy', count: man.length } } catch {} }
  let names = []
  if (scan) {
    if (scan.legacyNames === null) {
      try { scan.legacyNames = readdirSync(stateDir) } catch { scan.legacyNames = [] }
    }
    names = scan.legacyNames
  } else {
    try { names = readdirSync(stateDir) } catch { names = [] }
  }
  for (const n of names) {
    if (!/\.(md|json)$/i.test(n)) continue
    if (EVIDENCE_SKIP.has(n)) continue
    if (!n.includes(t.id)) continue
    return { path: join(stateDir, n), kind: 'legacy', count: man.length }
  }
  return null
}

function evidenceFor(stateDir, t) {
  const i = evidenceInfo(stateDir, t)
  return i ? i.path : null
}

/** 读 owners.json，把 sessionId 映射成「角色(名字)」——panel22 */
export function readRoleMap(stateDir) {
  let doc = null
  try { doc = JSON.parse(readFileSync(join(stateDir, 'owners.json'), 'utf8')) } catch { return {} }
  const map = {}
  const models = doc && doc.models && typeof doc.models === 'object' ? doc.models : {}
  const add = (arr, label) => { for (const sid of (Array.isArray(arr) ? arr : [])) map[String(sid)] = label }
  add(doc.owners, 'owner')
  add(doc.workers, 'worker')
  add(doc.judges, 'judge')
  add(doc.ops, 'ops')
  add(doc.children, 'child')
  for (const sid of Object.keys(map)) {
    const m = String(models[sid] || '')
    if (m) map[sid] = map[sid] + ' · ' + m.split(/[（(]/)[0].trim()
  }
  return map
}

const shortId = (sid) => { const v = String(sid || '').replace(/^session-/, ''); return v ? v.slice(0, 8) + '…' : '' }
const who = (map, sid) => { const s = String(sid || ''); if (!s) return ''; const role = map[s] || 'session'; return role + ' ' + shortId(s) }

/** 纯函数：state -> 面板数据（便于离线单测） */
export function buildTickets(stateDir, state, nowMs = Date.now()) {
  const tickets = Array.isArray(state && state.tickets) ? state.tickets : []
  let evidenceIds = new Set()
  try { evidenceIds = new Set(readdirSync(join(stateDir, 'evidence'))) } catch {}
  const scan = { evidenceIds, legacyNames: null }
  const roleMap = readRoleMap(stateDir)
  const rows = tickets.map((t) => {
    const ev = evidenceInfo(stateDir, t, scan)
    return ({
    id: t.id,
    state: t.state,
    title: String(t.title || ''),
    backend: t.backend || null,
    revision: Number(t.revision || 0),
    updatedAt: t.updatedAt || null,
    ageMin: t.updatedAt ? Math.max(0, Math.round((nowMs - Date.parse(t.updatedAt)) / 60000)) : null,
    evidence: ev ? ev.path : null,
    evidenceKind: ev ? ev.kind : null,
    artifacts: Array.isArray(t.artifacts) ? t.artifacts.length : 0,
    childId: t.childId || null,
    // panel22：给右侧「参与人」卡用
    type: String(t.type || ''),
    createdAt: t.createdAt || null,
    firstReadyAt: t.firstReadyAt || null,
    sessionId: t.sessionId || '',
    creator: who(roleMap, t.sessionId),
    assignees: (Array.isArray(t.assignees) ? t.assignees : []).map((a) => ({ who: who(roleMap, a.sessionId), status: String(a.status || 'assigned'), at: a.at || null, reportedAt: a.reportedAt || null })),
    // v37：reports 末项可能是 null/非对象（历史坏数据）—— 判空后再取，别让一条坏数据把整张 /tickets 打成空表
    reports: (() => { const arr = Array.isArray(t.reports) ? t.reports : []; const last = arr.length ? arr[arr.length - 1] : null; const ok = last && typeof last === 'object'; return { count: arr.length, last: ok ? { at: last.at || null, by: who(roleMap, last.sessionId), summary: String(last.summary || '').slice(0, 400) } : null } })(),
    judge: t.judge ? { who: who(roleMap, t.judge.sessionId), status: t.judge.status || 'pending', at: t.judge.at || null } : null,
    verdict: t.verdict ? { pass: !!t.verdict.pass, reason: String(t.verdict.reason || '').slice(0, 600), at: t.verdict.at || null, by: who(roleMap, t.verdict.by) } : null,
    manualClose: (Array.isArray(t.history) ? t.history : []).some((h) => String(h && h.reason || '') === 'manual-close'),
    children: Array.isArray(t.childrenIds) ? t.childrenIds.length : (t.childId ? 1 : 0),
    })
  })
  rows.sort((a, b) => {
    const d = (STATE_ORDER[a.state] == null ? 9 : STATE_ORDER[a.state]) - (STATE_ORDER[b.state] == null ? 9 : STATE_ORDER[b.state])
    return d !== 0 ? d : String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  })
  const counts = {}
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1
  const active = rows.filter((r) => r.state === 'running' || r.state === 'ready' || r.state === 'queued' || r.state === 'blocked').length
  return { generatedAt: new Date(nowMs).toISOString(), counts, active, total: rows.length, tickets: rows }
}

/** panel25：面板「设置」页的默认值（与 lite46 内置默认一致） */
export const SETTINGS_DEFAULTS = {
  runningTimeoutMs: 300000,
  maxDeliverAttempts: 30,
  attachMaxBytes: 8388608,
  watchdogAlerts: true,
  errorEvidence: true,
  autoDispatch: true,
  autoDispatchMs: 15000,
  pruneCaps: { outboxMax: 500, outboxKeepDays: 7, abandonedKeepDays: 3, historyMax: 100, artifactMax: 200, reportMax: 50 },
  // sa-196：流程开关（kernel 194/195 已实现；面板同批上）
  autoJudge: false,
  judgeRotate: true,
  notifyReadyTo: 'judge',
  quietSources: [],
  deliverOut: null,
  docJudge: true,
  docCriteria: [],
  notifyEvents: { verdictFail: true, watchdog: true, deliverFailed: true, docDone: true },
  // sa-196：面板自身
  refreshMs: 1500,
  defaultTab: 'tickets',
  theme: 'auto',
  // sa-196：上下文监测（脚本每轮热读；enabled 只是显式启停标记）
  ctxMonitor: { enabled: false, intervalSec: 60, thresholdOfficial: 65, thresholdOther: 85, thresholds: [], alertIngress: true },
}

/** 每个设置键的生效方式（UI 徽标用；按 settings-contract.md） */
export const APPLY_MODES = (() => {
  const hot = ['runningTimeoutMs', 'maxDeliverAttempts', 'attachMaxBytes', 'watchdogAlerts', 'autoDispatch', 'autoDispatchMs', 'errorEvidence', 'pruneCaps', 'autoJudge', 'judgeRotate', 'notifyReadyTo', 'quietSources', 'deliverOut', 'docJudge', 'docCriteria', 'notifyEvents', 'refreshMs', 'defaultTab', 'theme', 'ctxMonitor']
  const out = {}
  for (const k of hot) out[k] = 'hot'
  return out
})()

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const deepMerge = (base, over) => {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  if (!isObj(over)) return out
  for (const k of Object.keys(over)) {
    const b = out[k]
    const v = over[k]
    out[k] = (isObj(b) && isObj(v)) ? deepMerge(b, v) : v
  }
  return out
}

/** 生效值 = 默认值深合并文件值（嵌套对象单独合并，不整块覆盖） */
export function effectiveSettings(stateDir) {
  return deepMerge(SETTINGS_DEFAULTS, readSettingsFile(stateDir))
}

export function readSettingsFile(stateDir) {
  try { return JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8')) } catch { return {} }
}

/** 校验并归一化用户提交的设置（只收已知字段，数字要有界） */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  const num = (k, min, max, opts) => {
    if (src[k] === undefined || src[k] === null || src[k] === '') return undefined
    const v = Number(src[k])
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(k + ' 超出范围（' + min + '~' + max + '）')
    return opts && opts.int ? Math.round(v) : v
  }
  const timeout = num('runningTimeoutMs', 1000, 24 * 3600 * 1000)
  if (timeout !== undefined) out.runningTimeoutMs = Math.round(timeout)
  const deliver = num('maxDeliverAttempts', 1, 500, { int: true })
  if (deliver !== undefined) out.maxDeliverAttempts = deliver
  const cap = num('attachMaxBytes', 1024, 64 * 1024 * 1024, { int: true })
  if (cap !== undefined) out.attachMaxBytes = cap
  if (src.watchdogAlerts !== undefined) out.watchdogAlerts = src.watchdogAlerts !== false
  if (src.autoDispatch !== undefined) out.autoDispatch = src.autoDispatch !== false
  const autoMs = num('autoDispatchMs', 1000, 600000, { int: true })
  if (autoMs !== undefined) out.autoDispatchMs = autoMs
  if (src.errorEvidence !== undefined) out.errorEvidence = src.errorEvidence !== false
  // sa-196：流程开关 / 面板自身 / 上下文监测
  if (src.autoJudge !== undefined) {
    if (src.autoJudge === true || src.autoJudge === false) out.autoJudge = src.autoJudge
    else if (typeof src.autoJudge === 'string' && src.autoJudge.trim()) out.autoJudge = src.autoJudge.trim().slice(0, 120)
    else throw new Error('autoJudge 必须是 false / true / judge 会话 id')
  }
  if (src.judgeRotate !== undefined) out.judgeRotate = src.judgeRotate !== false
  if (src.notifyReadyTo !== undefined) {
    const v = String(src.notifyReadyTo)
    if (!['judge', 'owner'].includes(v)) throw new Error('notifyReadyTo 只能是 judge / owner')
    out.notifyReadyTo = v
  }
  if (src.quietSources !== undefined) {
    if (!Array.isArray(src.quietSources)) throw new Error('quietSources 必须是数组')
    if (src.quietSources.length > 20) throw new Error('quietSources 最多 20 项')
    out.quietSources = [...new Set(src.quietSources.map((x) => String(x).trim()).filter(Boolean))].map((x) => x.slice(0, 40))
  }
  if (src.deliverOut !== undefined) {
    if (src.deliverOut === null) out.deliverOut = null
    else if (!isObj(src.deliverOut)) throw new Error('deliverOut 必须是对象或 null')
    else {
      const mode = String(src.deliverOut.mode || 'onebot')
      if (!['onebot', 'hostTool'].includes(mode)) throw new Error('deliverOut.mode 只能是 onebot / hostTool')
      const d = { mode }
      if (mode === 'onebot') {
        const apiBase = String(src.deliverOut.apiBase || '').trim()
        if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase)) throw new Error('deliverOut.apiBase 必须是本机 http(s) 地址（如 http://127.0.0.1:3001）')
        d.apiBase = apiBase
      } else {
        const tool = String(src.deliverOut.tool || '').trim()
        if (!tool) throw new Error('deliverOut.tool 不能为空（hostTool 模式）')
        d.tool = tool.slice(0, 60)
      }
      if (src.deliverOut.onlyWhenDone !== undefined) d.onlyWhenDone = src.deliverOut.onlyWhenDone !== false
      const mb = src.deliverOut.maxBytes === undefined ? undefined : Number(src.deliverOut.maxBytes)
      if (mb !== undefined && (!Number.isFinite(mb) || mb < 1024 || mb > 64 * 1024 * 1024)) throw new Error('deliverOut.maxBytes 超出范围（1024~67108864）')
      if (mb !== undefined) d.maxBytes = Math.round(mb)
      out.deliverOut = d
    }
  }
  if (src.docJudge !== undefined) out.docJudge = src.docJudge !== false
  if (src.docCriteria !== undefined) {
    if (!Array.isArray(src.docCriteria)) throw new Error('docCriteria 必须是数组')
    if (src.docCriteria.length > 10) throw new Error('docCriteria 最多 10 条')
    out.docCriteria = src.docCriteria.map((x) => String(x || '').trim()).filter(Boolean).map((x) => x.slice(0, 500))
  }
  if (src.notifyEvents !== undefined) {
    if (!isObj(src.notifyEvents)) throw new Error('notifyEvents 必须是对象')
    const ne = {}
    for (const k of ['verdictFail', 'watchdog', 'deliverFailed', 'docDone']) {
      if (src.notifyEvents[k] !== undefined) ne[k] = src.notifyEvents[k] !== false
    }
    out.notifyEvents = ne
  }
  const refresh = num('refreshMs', 200, 60000, { int: true })
  if (refresh !== undefined) out.refreshMs = refresh
  if (src.defaultTab !== undefined) {
    const v = String(src.defaultTab)
    if (!['tickets', 'archive', 'stats', 'settings'].includes(v)) throw new Error('defaultTab 只能是 tickets / archive / stats / settings')
    out.defaultTab = v
  }
  if (src.theme !== undefined) {
    const v = String(src.theme)
    if (!['auto', 'light', 'dark'].includes(v)) throw new Error('theme 只能是 auto / light / dark')
    out.theme = v
  }
  if (src.ctxMonitor !== undefined) {
    if (!isObj(src.ctxMonitor)) throw new Error('ctxMonitor 必须是对象')
    const cm = {}
    const c = src.ctxMonitor
    if (c.enabled !== undefined) cm.enabled = c.enabled === true
    const iv = c.intervalSec === undefined ? undefined : Number(c.intervalSec)
    if (iv !== undefined) { if (!Number.isFinite(iv) || iv < 10 || iv > 3600) throw new Error('ctxMonitor.intervalSec 超出范围（10~3600）'); cm.intervalSec = Math.round(iv) }
    for (const k of ['thresholdOfficial', 'thresholdOther']) {
      if (c[k] === undefined) continue
      const v = Number(c[k])
      if (!Number.isFinite(v) || v <= 0 || v > 100) throw new Error('ctxMonitor.' + k + ' 超出范围（0~100]')
      cm[k] = Math.round(v * 10) / 10
    }
    if (c.thresholds !== undefined) {
      if (!Array.isArray(c.thresholds)) throw new Error('ctxMonitor.thresholds 必须是数组')
      if (c.thresholds.length > 50) throw new Error('ctxMonitor.thresholds 最多 50 条')
      const rows = []
      for (const row of c.thresholds) {
        if (!isObj(row)) throw new Error('ctxMonitor.thresholds 元素必须是 {provider, pct}')
        const provider = String(row.provider || '').trim()
        const pct = Number(row.pct)
        if (!provider || provider.length > 60) throw new Error('ctxMonitor.thresholds.provider 非法')
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error('ctxMonitor.thresholds.pct 超出范围（0~100]')
        rows.push({ provider, pct: Math.round(pct * 10) / 10 })
      }
      cm.thresholds = rows
    }
    if (c.alertIngress !== undefined) cm.alertIngress = c.alertIngress !== false
    out.ctxMonitor = cm
  }
  const rawPrune = src.pruneCaps && typeof src.pruneCaps === 'object' ? src.pruneCaps : null
  if (rawPrune) {
    const prune = {}
    const put = (k, min, max) => { if (rawPrune[k] === undefined || rawPrune[k] === '') return; const v = Number(rawPrune[k]); if (!Number.isFinite(v) || v < min || v > max) throw new Error('pruneCaps.' + k + ' 超出范围（' + min + '~' + max + '）'); prune[k] = Math.round(v) }
    put('outboxMax', 10, 100000); put('outboxKeepDays', 1, 365); put('abandonedKeepDays', 1, 365)
    put('historyMax', 5, 10000); put('artifactMax', 5, 10000); put('reportMax', 5, 10000)
    out.pruneCaps = prune
  }
  return out
}

/** 面板内部小写入：把 patch 深合并进 settings.json（原子写）。失败抛错，由调用方决定吞不吞。 */
export function writeSettingsQuiet(stateDir, patch) {
  const file = join(stateDir, 'settings.json')
  const cur = readSettingsFile(stateDir)
  const next = deepMerge(cur, patch)
  const tmp = file + '.' + commandFileName('tmp')
  writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8')
  renameSync(tmp, file)
  return next
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); try { req.destroy() } catch {} ; return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 给一张工单找证据文件；只允许落在本 stateDir 里（防止路径注入） */
export function resolveEvidence(stateDir, ticketId) {
  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
  const t = (state.tickets || []).find((x) => x.id === ticketId)
  if (!t) return null
  const ev = evidenceFor(stateDir, t)
  if (!ev) return null
  // v37：不再用字符串前缀（同前缀兄弟目录可绕过）；按 realpath + relative 判，且拒绝 .. 与绝对路径
  try {
    const rel = relative(realpathSync(stateDir), realpathSync(ev))
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return null
    return ev
  } catch (e) { return null }
}

/** 面板「统计」页：直接从 state.json 算，不依赖 lite 服务 */
export function buildStats(stateDir, state, nowMs = Date.now()) {
  const tickets = Array.isArray(state && state.tickets) ? state.tickets : []
  const byState = {}
  const byBackend = {}
  let withArtifacts = 0
  let artifactsTotal = 0
  const durs = []
  for (const t of tickets) {
    byState[t.state] = (byState[t.state] || 0) + 1
    const b = t.backend || '(none)'
    byBackend[b] = (byBackend[b] || 0) + 1
    const arts = Array.isArray(t.artifacts) ? t.artifacts : []
    if (arts.length) { withArtifacts++; artifactsTotal += arts.length }
    const end = t.firstReadyAt || (t.state === 'done' ? t.updatedAt : null)
    if (end && t.createdAt) {
      const ms = Date.parse(end) - Date.parse(t.createdAt)
      if (Number.isFinite(ms) && ms >= 0) durs.push(ms)
    }
  }
  durs.sort((a, b) => a - b)
  const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null
  const p50 = durs.length ? durs[Math.floor(durs.length * 0.5)] : null
  return { total: tickets.length, byState, byBackend, evidence: { withArtifacts, artifactsTotal, noArtifact: tickets.length - withArtifacts }, durations: { n: durs.length, avgMs: avg, p50Ms: p50, maxMs: durs.length ? durs[durs.length - 1] : null } }
}

/** lite42：读 archive/<prefix>.json（已归档工单），按 q 过滤 id/标题，按更新时间倒序 */
/** panel31：归档搜索也认类型词（中文标签 / 英文 id），找「办公」就能命中 type=office */
const ARCHIVE_TYPE_WORDS = { test: ['test', '测试'], code: ['code', '代码'], office: ['office', '办公', '文档', '表格', '演示'] }
const archiveTypeHit = (type, needle) => {
  if (!needle) return false
  const words = ARCHIVE_TYPE_WORDS[String(type || '')] || []
  if (!words.length) return false
  return words.some((w) => { const x = String(w).toLowerCase(); return x === needle || x.includes(needle) })
}
export function readArchive(stateDir, q = '') {
  const dir = join(stateDir, 'archive')
  // sa-187/P02：同时扫 archive/*.json 与 archive/tickets/*.json（lite50+ 分目录归档），按 id 去重取 updatedAt 更新的
  let names = []
  try { names = readdirSync(dir).filter((n) => /\.json$/i.test(n)) } catch { names = [] }
  try { names = names.concat(readdirSync(join(dir, 'tickets')).filter((n) => /\.json$/i.test(n)).map((n) => 'tickets/' + n)) } catch {}
  const needle = String(q || '').trim().toLowerCase()
  const out = []
  const byId = new Map()
  for (const n of names) {
    let doc = null
    try { doc = JSON.parse(readFileSync(join(dir, n), 'utf8')) } catch { continue }
    const rows = Array.isArray(doc && doc.tickets) ? doc.tickets : []
    for (const t of rows) {
      const id = String(t.id || '')
      const title = String(t.title || '')
      if (needle && !(id.toLowerCase().includes(needle) || title.toLowerCase().includes(needle) || archiveTypeHit(t.type, needle))) continue
      const row = { id, title, state: String(t.state || ''), type: String(t.type || ''), prefix: String(doc.prefix || id.split('-')[0]), updatedAt: t.updatedAt || t.createdAt || null, archivedAt: doc.updatedAt || null, artifacts: Array.isArray(t.artifacts) ? t.artifacts.length : 0 }
      const prev = byId.get(id)
      // 同 id：取 updatedAt 更新的那份（新旧目录并存时以新为准）
      if (!prev || String(row.updatedAt || '').localeCompare(String(prev.updatedAt || '')) > 0) {
        if (prev) { const i = out.indexOf(prev); if (i >= 0) out.splice(i, 1) }
        byId.set(id, row)
        out.push(row)
      }
    }
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return out
}

/** panel27(#68)：归档证据 —— 列出 archive/evidence/<工单>/ 下的文件（按钮名固定 Fact-<工单号>-<序号>） */
export function listArchiveEvidence(stateDir, ticketId) {
  const id = String(ticketId || '')
  if (!/^(?:sa|s\d+)-\d+$/.test(id)) return []
  const dir = join(stateDir, 'archive', 'evidence', id)
  let names = []
  try { names = readdirSync(dir).filter((n) => /\.(md|json|txt|log|diff|patch|ya?ml)$/i.test(n)) } catch { return [] }
  names.sort()
  return names.map((n, i) => {
    let bytes = 0
    try { bytes = statSync(join(dir, n)).size } catch {}
    return { name: n, bytes, seq: i + 1, fact: 'Fact-' + id + '-' + String(i + 1).padStart(2, '0') }
  })
}

/** 读一份归档证据正文：只允许落在 archive/evidence/<工单>/ 里（basename + realpath 双校验，防路径注入） */
/** v37：证据正文按块读 —— 先 statSync 看大小，超 256KB 只用 openSync/readSync 读前 256KB，不整份进内存 */
export function readEvidencePreview(file, cap = 256 * 1024) {
  const size = statSync(file).size
  if (size <= cap) { const buf = readFileSync(file); return { bytes: buf.length, truncated: false, text: buf.toString('utf8') } }
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(cap)
    const n = readSync(fd, buf, 0, cap, 0)
    return { bytes: size, truncated: true, text: buf.subarray(0, n).toString('utf8') }
  } finally { try { closeSync(fd) } catch (e) {} }
}

export function readArchiveEvidence(stateDir, ticketId, file) {
  const id = String(ticketId || '')
  if (!/^(?:sa|s\d+)-\d+$/.test(id)) return { ok: false, code: 400, error: 'bad ticketId' }
  const name = String(file || '')
  if (!name || name !== basename(name) || name === '.' || name === '..') return { ok: false, code: 400, error: 'bad file' }
  const root = join(stateDir, 'archive', 'evidence', id)
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(join(root, name))
    if (!real.startsWith(realRoot + sep)) return { ok: false, code: 403, error: 'outside archive evidence' }
    const buf = readFileSync(real)
    const cap = 256 * 1024
    const truncated = buf.length > cap
    return { ok: true, path: real, relative: 'archive/evidence/' + id + '/' + name, bytes: buf.length, truncated, text: buf.subarray(0, cap).toString('utf8') }
  } catch (e) { return { ok: false, code: 404, error: String(e && e.message ? e.message : e) } }
}

/** sa-187/P03：读归档判词 archive/verdicts/<id>.md —— basename + realpath 双校验，防越界写法与 readArchiveEvidence 一致 */
export function readArchiveVerdict(stateDir, ticketId) {
  const id = String(ticketId || '')
  if (!/^(?:sa|s\d+)-\d+$/.test(id)) return { ok: false, code: 400, error: 'bad ticketId' }
  const name = id + '.md'
  if (name !== basename(name)) return { ok: false, code: 400, error: 'bad file' }
  const root = join(stateDir, 'archive', 'verdicts')
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(join(root, name))
    if (!real.startsWith(realRoot + sep)) return { ok: false, code: 403, error: 'outside archive verdicts' }
    const buf = readFileSync(real)
    return { ok: true, ticketId: id, path: real, relative: 'archive/verdicts/' + name, bytes: buf.length, text: buf.toString('utf8') }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (/ENOENT|no such file/i.test(msg)) return { ok: false, code: 404, error: 'no-verdict' }
    return { ok: false, code: 400, error: msg }
  }
}

/** v37：错误单重跑命令 —— 只写 commands/requeue-<id>-<ts>.json，lite 的 tick 把 blocked 按状态机重排回 queued */
export function writeRequeueCommand(stateDir, ticketId) {
  const id = String(ticketId || '')
  if (!/^(?:sa|s\d+)-\d+$/.test(id)) return { ok: false, code: 400, error: 'bad ticketId' }
  try {
    const dir = join(stateDir, 'commands')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, commandFileName('requeue', id) + '.json')
    writeFileSync(file, JSON.stringify({ action: 'requeue', ticketId: id, by: 'panel', at: new Date().toISOString() }))
    return { ok: true, ticketId: id, file }
  } catch (e) { return { ok: false, code: 500, error: String(e && e.message ? e.message : e) } }
}

/** panel32：单张归档命令 —— 只写 commands/archive-<id>-<ts>.json，lite49 的 tick 按 done/blocked 校验后搬进 archive */
export function writeArchiveCommand(stateDir, ticketId) {
  const id = String(ticketId || '')
  if (!/^(?:sa|s\d+)-\d+$/.test(id)) return { ok: false, code: 400, error: 'bad ticketId' }
  try {
    const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
    const t = (Array.isArray(state && state.tickets) ? state.tickets : []).find((t) => t && t.id === id)
    if (!t) return { ok: false, code: 404, error: 'no-such-ticket' }
    if (t.state !== 'done' && t.state !== 'blocked') return { ok: false, code: 409, error: 'bad-state', state: t.state, hint: '只有已完成或错误的工单可以归档，请等待工单完成后再试。' }
    const dir = join(stateDir, 'commands')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, commandFileName('archive', id) + '.json')
    writeFileSync(file, JSON.stringify({ action: 'archive', ticketId: id, by: 'panel', at: new Date().toISOString() }))
    return { ok: true, queued: true, ticketId: id, state: t.state, file }
  } catch (e) { return { ok: false, code: 500, error: String(e && e.message ? e.message : e) } }
}

/** 回滚命令：只写 commands/*.json，lite 的 tick 按状态机把归档单搬回（面板不直接改 state.json） */
export function writeRollbackCommand(stateDir, body) {
  const src = body && typeof body === 'object' ? body : {}
  const all = src.all === true
  const batch = all || Object.prototype.hasOwnProperty.call(src, 'ids')
  const validId = (id) => typeof id === 'string' && /^(?:sa|s\d+)-\d+$/.test(id)
  const id = String(src.ticketId || '')
  let ids = []
  let truncated = false
  const at = new Date().toISOString()
  const submitted = []
  try {
    if (batch) {
      if (!all && !Array.isArray(src.ids)) return { ok: false, code: 400, error: 'bad ids' }
      ids = all ? readArchive(stateDir).map((t) => t.id) : src.ids
      // 先校验全部输入（包括超过上限的部分），再写任何命令。
      if (!ids.every(validId)) return { ok: false, code: 400, error: 'bad ticketId' }
      ids = [...new Set(ids)]
      if (all) ids.sort()
      truncated = ids.length > 200
      ids = ids.slice(0, 200)
    } else {
      if (!validId(id)) return { ok: false, code: 400, error: 'bad ticketId' }
      ids = [id]
    }
    const dir = join(stateDir, 'commands')
    if (ids.length) mkdirSync(dir, { recursive: true })
    let file = null
    for (const ticketId of ids) {
      file = join(dir, commandFileName('restore', ticketId) + '.json')
      writeFileSync(file, JSON.stringify({ action: 'restore', ticketId, by: 'panel', at }))
      submitted.push(ticketId)
    }
    if (batch) return { ok: true, action: 'restore', count: submitted.length, ids: submitted, truncated, at }
    return { ok: true, action: 'restore', ticketId: id, file }
  } catch (e) {
    return { ok: false, code: 500, error: String(e && e.message ? e.message : e), action: 'restore', count: submitted.length, ids: submitted, truncated, at }
  }
}

export function readPanel(stateDir) {
  const stateFile = join(stateDir, 'state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  return { stateFile, ...buildTickets(stateDir, state) }
}


// ---------------------------------------------------------------- sa-196：诊断（只读）
const msgOf = (e) => String(e && e.message ? e.message : e)
const isAlive = (pid) => { try { process.kill(Number(pid), 0); return true } catch (e) { return e && e.code === 'EPERM' } }
const readPid = (file) => { try { const n = Number(String(readFileSync(file, 'utf8')).trim()); return Number.isFinite(n) ? n : null } catch { return null } }

/** 读进程命令行：Windows 用 CIM，其它平台读 /proc。读不到返回空串（调用方据此拒绝"验不了就不杀"）。 */
export function processCmdline(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + n + '").CommandLine'], { encoding: 'utf8', timeout: 5000 })
      return String(out || '').trim()
    } catch { return '' }
  }
  try { return readFileSync('/proc/' + n + '/cmdline', 'utf8').replace(/\u0000/g, ' ').trim() } catch { return '' }
}

function probeTcp(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port: Number(port) })
    let done = false
    const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch {}; resolve(v) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/** 12 项体检：只读、不 spawn、不写盘；每项异常都降级 unverified，绝不抛给路由 */
export async function buildDiagnostics(stateDir, config = {}, ctx = null, nowMs = Date.now()) {
  const checks = []
  const msg = msgOf
  const add = (item) => checks.push(Object.assign({ key: '', title: '', status: 'unverified', detail: '', fix: '' }, item))
  const run = async (key, title, fn) => {
    try { add(Object.assign({ key, title }, (await fn()) || {})) }
    catch (e) { add({ key, title, status: 'unverified', detail: '检查异常：' + msg(e), fix: '这是诊断自身的降级（不影响插件）；可刷新或重启宿主后再看' }) }
  }
  const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
  const stateFile = join(stateDir, 'state.json')
  const ownersFile = join(stateDir, 'owners.json')
  const patchFile = config.patchFile || join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  const hooksFile = config.codexHooks || join(homedir(), '.codex', 'hooks.json')
  const queueDir = config.queueDir || join(stateDir, '..', 'queue')
  const stopHook = config.stopHook || join(stateDir, '..', 'hooks', 'codex-stop-hook.mjs')
  const monitorScript = config.monitorScript || join(stateDir, '..', 'tools', 'ctx-monitor.mjs')
  const monitorPid = config.monitorPid || join(stateDir, 'ctx-monitor.pid')

  // 1 宿主
  await run('host', '宿主版本 / GUI 端口', () => {
    let version = 'unknown'
    try { version = readJson(join(stateDir, '..', 'superagent-panel', 'package.json')).version || version } catch { try { version = 'node ' + process.version } catch {} }
    const port = config.port || process.env.DSH_WEB_PORT || process.env.PORT || ''
    return port
      ? { status: 'ok', detail: 'panel ' + version + ' · GUI 端口 ' + port }
      : { status: 'unverified', detail: 'panel ' + version + ' · 未配置端口（config.port / DSH_WEB_PORT）', fix: '在 panel config 里给 port，或设环境变量 DSH_WEB_PORT' }
  })

  // 2 插件挂载 + patch active
  await run('plugins', '三个插件是否 active + patch active 条数', () => {
    let patchActive = null
    let patchErr = ''
    try {
      const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/)
      patchActive = lines.filter((l) => /^\s*-\s*id:\s*\S+/.test(l) && !/^\s*#/.test(l)).length
    } catch (e) { patchErr = msg(e) }
    let liteActive = false
    try { liteActive = Date.now() - statSync(stateFile).mtimeMs < 10 * 60 * 1000 } catch {}
    const detail = 'lite=' + (liteActive ? 'active(state 近 10 分钟更新)' : 'unknown') + ' · panel=active(本进程) · watch3=' + (existsSync(queueDir) ? 'unknown(queue 存在)' : 'missing') + ' · patchActive=' + (patchActive == null ? 'unreadable' : patchActive)
    if (patchActive == null) return { status: 'unverified', detail: detail + ' · ' + patchErr, fix: '确认面板能读 profile 的 cordis.patch.yml（config.patchFile）' }
    return patchActive >= 1
      ? { status: 'ok', detail }
      : { status: 'bad', detail, fix: '打开 <host>/profiles/desktop/cordis.patch.yml，确认面板 insert 未被注释，然后重启宿主' }
  })

  // 3 宿主服务
  await run('services', '宿主服务（tools/schedule/subagents/webServer）', () => {
    const probe = (name) => { try { return typeof ctx.get === 'function' ? !!ctx.get(name, false) : false } catch { return false } }
    const r = { tools: probe('tools'), schedule: probe('schedule'), subagents: probe('subagents'), webServer: probe('webServer') }
    const missing = Object.keys(r).filter((k) => !r[k])
    const detail = Object.entries(r).map(([k, v]) => k + '=' + (v ? 'ok' : 'missing')).join(' · ')
    if (r.tools && r.webServer && r.schedule && r.subagents) return { status: 'ok', detail }
    if (!r.tools || !r.webServer) return { status: 'bad', detail, fix: 'tools/webServer 是必需服务；重启宿主并检查插件依赖' }
    return { status: 'missing', detail, fix: '缺少 ' + missing.join('/') + '：schedule 影响投递，subagents 影响 sa_run/sa_fanout；按需启用后重启宿主' }
  })

  // 4 ownerSessions
  await run('owners', 'ownerSessions 已配置', () => {
    try {
      const doc = readJson(ownersFile)
      const n = Array.isArray(doc.owners) ? doc.owners.length : 0
      return n > 0
        ? { status: 'ok', detail: 'owners=' + n + ' workers=' + (doc.workers || []).length + ' judges=' + (doc.judges || []).length }
        : { status: 'bad', detail: 'owners 为空：所有写工具都会被拒', fix: '在设置页「流程开关」上方或直接编辑 owners.json 的 owners 数组，填 owner 会话 id' }
    } catch (e) { return { status: 'bad', detail: '读 owners.json 失败：' + msg(e), fix: '确认 stateDir 指向正确目录、owners.json 是合法 JSON；或重启插件让它重新播种' } }
  })

  // 5 stateDir 可写
  await run('statedir', 'stateDir 存在且可写', () => {
    try {
      accessSync(stateDir, fsConstants.W_OK)
      return { status: 'ok', detail: stateDir + '（可写）' }
    } catch (e) { return { status: 'bad', detail: stateDir + ' → ' + msg(e), fix: '把 stateDir 改到当前用户可写目录，或修正权限' } }
  })

  // 6 state.json 可解析 + 工单计数
  await run('state', 'state.json 可解析 + 工单计数', () => {
    try {
      const st = readJson(stateFile)
      const tickets = Array.isArray(st.tickets) ? st.tickets : []
      const counts = { total: tickets.length, done: 0, blocked: 0, ready: 0, running: 0, queued: 0 }
      for (const t of tickets) if (counts[t.state] != null) counts[t.state]++
      const pendingOutbox = (Array.isArray(st.outbox) ? st.outbox : []).filter((o) => !o.sentAt && !o.abandonedAt).length
      return { status: 'ok', detail: 'total=' + counts.total + ' done=' + counts.done + ' blocked=' + counts.blocked + ' ready=' + counts.ready + ' running=' + counts.running + ' queued=' + counts.queued + ' · pendingOutbox=' + pendingOutbox, counts, pendingOutbox }
    } catch (e) { return { status: 'bad', detail: '读/解析 state.json 失败：' + msg(e), fix: '确认 stateDir 正确；坏文件可从 state.json.bak 恢复（先停插件再换）' } }
  })

  // 7 归档目录
  await run('archive', '归档目录结构', () => {
    const archive = join(stateDir, 'archive')
    if (!existsSync(archive)) return { status: 'missing', detail: '还没有归档目录（没归档过时正常）', fix: '归档过一次后 lite 会自动建 archive/；不需要手动修' }
    const dirs = ['tickets', 'verdicts', 'handoff'].filter((d) => existsSync(join(archive, d)))
    return dirs.length === 3
      ? { status: 'ok', detail: 'archive/ 下 ' + dirs.join(' / ') + ' 都在' }
      : { status: 'missing', detail: 'archive/ 下只有 ' + (dirs.join(' / ') || '（空）'), fix: '缺的目录会在对应动作第一次发生时由 lite 创建；不需要手动建' }
  })

  // 8 免费模型
  await run('free-model', '配套：Our Free Model', () => {
    try {
      const doc = readJson(ownersFile)
      const models = doc.models && typeof doc.models === 'object' ? Object.values(doc.models) : []
      const hit = models.some((m) => String(m).includes('our-free-model'))
      return hit
        ? { status: 'ok', detail: 'owners.models 里出现 our-free-model' }
        : { status: 'unverified', detail: '面板读不到 provider 注册表；owners.models 里没有 our-free-model 备注', fix: '装了 dsh-our-free-model 才可选免费模型；在 SaRunAllow/roles 里用 provider our-free-model 前先确认宿主模型列表' }
    } catch (e) { return { status: 'unverified', detail: '读 owners.models 失败：' + msg(e), fix: '确认 owners.json 可读' } }
  })

  // 9 QQ 通道
  await run('qq', '配套：QQ 触发（NapCat + bridge）', async () => {
    const port = Number(config.napcatPort || 3001)
    const up = await probeTcp(config.napcatHost || '127.0.0.1', port, 300)
    const bridgeLog = config.bridgeLog || join(stateDir, 'onebot-bridge.log')
    let bridgeRecent = false
    try { bridgeRecent = Date.now() - statSync(bridgeLog).mtimeMs < 5 * 60 * 1000 } catch {}
    const detail = 'napcat 127.0.0.1:' + port + '=' + (up ? 'ok' : 'missing') + ' · bridge 日志 5 分钟内=' + (bridgeRecent ? 'yes' : 'no')
    if (up && bridgeRecent) return { status: 'ok', detail }
    if (up || bridgeRecent) return { status: 'unverified', detail, fix: 'NapCat 开着但 bridge 没新一轮日志（或反之）：确认 onebot-bridge.mjs 在跑、白名单非空' }
    return { status: 'missing', detail, fix: '要用 QQ 建单：启动 NapCat（127.0.0.1:3001）并跑 onebot-bridge.mjs；不需要就忽略' }
  })

  // 10 Codex 桥
  await run('codex', '配套：Codex 桥', () => {
    const parts = { hooks: existsSync(hooksFile), queue: existsSync(queueDir), stopHook: existsSync(stopHook) }
    const detail = 'hooks.json=' + (parts.hooks ? 'ok' : 'missing') + ' · queue=' + (parts.queue ? 'ok' : 'missing') + ' · stop-hook=' + (parts.stopHook ? 'ok' : 'missing')
    if (parts.hooks && parts.queue && parts.stopHook) return { status: 'ok', detail }
    return { status: 'missing', detail, fix: '要用 Codex 后端：按 integrations/codex-bridge/README 放 stop-hook、注册 hooks.json、建 queue；不用就忽略' }
  })

  // 11 watcher
  await run('watcher', '配套：watcher 插件', () => {
    const pkg = config.watcherPkg || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-plugin-handoff-watch', 'package.json')
    return existsSync(pkg)
      ? { status: 'ok', detail: '已挂载 dsh-plugin-handoff-watch（' + pkg + '）' }
      : { status: 'missing', detail: '未发现 dsh-plugin-handoff-watch', fix: '需要普通 handoff 自动投递时按 integrations/codex-bridge/watcher/README 装；不需要就忽略' }
  })

  // 12 ctx-monitor
  await run('ctx-monitor', '配套：上下文监测', () => {
    const pid = readPid(monitorPid)
    if (!pid) return { status: 'missing', detail: '未启动（没有 pid 文件 ' + monitorPid + '）', fix: '在设置页「上下文监测」点「启动监测」；默认关闭' }
    if (!isAlive(pid)) return { status: 'bad', detail: 'pid=' + pid + ' 但不存活（残留 pid 文件）', fix: '点「启动监测」会覆盖残留 pid；或删掉 ' + monitorPid }
    return { status: 'ok', detail: 'pid=' + pid + ' 存活 · 脚本 ' + monitorScript }
  })

  // 13 compaction（sa-198）：读 profile patch 判断自动压缩开没开
  //    语义：`compaction-basic` 的 auto 是否 false；没装插件 = not-installed
  let compactionOn = null   // true/false/null(未知)
  let compactionNote = ''
  await run('compaction', '\u914d\u5957\uff1a\u4e0a\u4e0b\u6587\u81ea\u52a8\u538b\u7f29\uff08compaction\uff09', () => {
    let lines = []
    try { lines = readFileSync(patchFile, 'utf8').split(/\r?\n/) } catch (e) {
      return { status: 'unverified', detail: '读不到 patch：' + patchFile + '（' + msgOf(e) + '）', fix: '确认 profile 的 cordis.patch.yml 存在且可读；读不到时无法判断 compaction 开关' }
    }
    // 找 compaction-basic 条目与其后的 auto: 值（只看未注释的行）
    let seen = false
    let autoVal = null
    let sawCompactionPlugin = false
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const trimmed = l.trim()
      const isComment = trimmed.startsWith('#')
      if (!isComment && /\bcompaction-basic\b/.test(l)) { sawCompactionPlugin = true; seen = true; continue }
      if (seen && !isComment && /^\s*auto\s*:\s*(true|false)\s*$/.test(l)) { autoVal = /^\s*auto\s*:\s*true/.test(l); break }
      if (seen && l.trim().length === 0) continue
    }
    if (!sawCompactionPlugin) {
      compactionOn = null
      compactionNote = '\u672a\u627e\u5230 compaction-basic\uff08\u53ef\u80fd\u5378\u8f7d\u4e86\u538b\u7f29\u63d2\u4ef6\uff09'
      return { status: 'ok', detail: compactionNote, fix: '\u5378\u4e86\u538b\u7f29\u63d2\u4ef6\u65f6\uff0c\u5efa\u8bae\u542f\u7528\u4e0a\u4e0b\u6587\u76d1\u6d4b\uff08\u5426\u5219\u4f1a\u8bdd\u5230\u9876\u624d\u53d1\u73b0\uff09' }
    }
    if (autoVal == null) {
      compactionOn = null
      compactionNote = '\u627e\u5230 compaction-basic\uff0c\u4f46\u6ca1\u770b\u5230\u660e\u786e\u7684 auto: \u503c'
      return { status: 'unverified', detail: compactionNote, fix: '\u76f4\u63a5\u770b patch \u91cc compaction-basic \u7684 auto \u5f00\u5173\uff1b\u4e0d\u786e\u5b9a\u65f6\u5efa\u8bae\u5148\u542f\u76d1\u6d4b\u89c2\u5bdf' }
    }
    compactionOn = autoVal
    compactionNote = autoVal ? '\u81ea\u52a8\u538b\u7f29\u5df2\u5f00\uff08auto:true\uff09' : '\u81ea\u52a8\u538b\u7f29\u5df2\u5173\uff08auto:false\uff09'
    return { status: 'ok', detail: compactionNote }
  })

  // 14 monitor \u4e0e compaction \u7684\u77db\u76fe\u68c0\u67e5\uff08sa-198\uff09
  //    \u88c5\u4e86\u81ea\u52a8\u538b\u7f29\u8fd8\u5728\u8dd1\u76d1\u6d4b = bad\uff08\u91cd\u590d\u544a\u8b66 + \u538b\u7f29\u540e\u8bef\u5224\uff09
  await run('monitor-vs-compaction', '\u76d1\u6d4b\u4e0e\u538b\u7f29\u662f\u5426\u77db\u76fe', () => {
    const pid = readPid(monitorPid)
    const monitorRunning = !!(pid && isAlive(pid))
    if (compactionOn === true && monitorRunning) {
      return {
        status: 'bad',
        detail: '\u81ea\u52a8\u538b\u7f29\u5df2\u5f00\uff08auto:true\uff09\uff0c\u4f46\u4e0a\u4e0b\u6587\u76d1\u6d4b\u4e5f\u5728\u8dd1\uff08pid=' + pid + '\uff09\u2014\u2014\u91cd\u590d\u544a\u8b66\uff0c\u4e14\u538b\u7f29\u540e\u6c34\u4f4d\u9aa4\u964d\u4f1a\u8bef\u5224',
        fix: '\u5efa\u8bae\u505c\u6b62\uff1a\u5728\u8bbe\u7f6e\u9875\u300c\u4e0a\u4e0b\u6587\u76d1\u6d4b\u300d\u70b9\u300c\u505c\u6b62\u300d\uff08\u5b83\u53ea\u8d1f\u8d23\u63d0\u9192\uff0c\u538b\u7f29\u5df2\u7531\u5bbf\u4e3b\u8d1f\u8d23\uff09',
      }
    }
    if (compactionOn === false && !monitorRunning) {
      return {
        status: 'missing',
        detail: '\u81ea\u52a8\u538b\u7f29\u5df2\u5173\uff08auto:false\uff09\uff0c\u4f46\u76d1\u6d4b\u6ca1\u5728\u8dd1\u2014\u2014\u6b64\u65f6\u6ca1\u4eba\u76ef\u6c34\u4f4d',
        fix: '\u5efa\u8bae\u542f\u52a8\uff1a\u5728\u8bbe\u7f6e\u9875\u300c\u4e0a\u4e0b\u6587\u76d1\u6d4b\u300d\u70b9\u300c\u542f\u52a8\u76d1\u6d4b\u300d\uff0c\u8d85\u9608\u503c\u65f6\u63d0\u9192\u4f60\u6362\u4f1a\u8bdd\u6216\u624b\u52a8 /compact',
      }
    }
    if (compactionOn === null) {
      return {
        status: 'unverified',
        detail: '\u770b\u4e0d\u51fa compaction \u5f00\u5173\uff08' + (compactionNote || '\u672a\u77e5') + '\uff09\uff0c\u65e0\u6cd5\u5224\u65ad\u662f\u5426\u77db\u76fe',
        fix: '\u5148\u770b\u4e0a\u4e00\u9879 compaction \u7684\u7ed3\u8bba\uff1b\u4e0d\u786e\u5b9a\u65f6\u5efa\u8bae\u7167\u5f00\u76d1\u6d4b\u89c2\u5bdf\uff08\u5b81\u591a\u4e00\u4e0b\u63d0\u9192\uff09',
      }
    }
    if (compactionOn === true && !monitorRunning) {
      return { status: 'ok', detail: '\u81ea\u52a8\u538b\u7f29\u5df2\u5f00\uff0c\u76d1\u6d4b\u672a\u8fd0\u884c\uff08\u6b63\u786e\u914d\u7f6e\uff1a\u4e0d\u91cd\u590d\u544a\u8b66\uff09' }
    }
    return { status: 'unverified', detail: '\u672a\u547d\u4e2d\u4efb\u4f55\u7ec4\u5408\uff08compactionOn=' + String(compactionOn) + ' running=' + monitorRunning + '\uff09' }
  })

  const summary = { ok: 0, missing: 0, bad: 0, unverified: 0 }
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1
  return { ok: true, generatedAt: new Date(nowMs).toISOString(), stateDir, checks, summary }
}

// ---------------------------------------------------------------- sa-196：监测进程控制
export function monitorPaths(stateDir, config = {}) {
  return {
    script: config.monitorScript || join(stateDir, '..', 'tools', 'ctx-monitor.mjs'),
    pidFile: config.monitorPid || join(stateDir, 'ctx-monitor.pid'),
  }
}

export function monitorStart(stateDir, config = {}) {
  const { script, pidFile } = monitorPaths(stateDir, config)
  try {
    if (!existsSync(script)) return { ok: false, error: '监测脚本不存在：' + script + '（用 config.monitorScript 指定）' }
    const pid = readPid(pidFile)
    if (pid && isAlive(pid)) return { ok: true, already: true, pid }
    const child = spawn(process.execPath, [script, '--daemon'], {
      cwd: join(script, '..'),
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    return { ok: true, started: true, pid: child.pid, script, pidFile }
  } catch (e) { return { ok: false, error: msgOf(e) } }
}

export function monitorStop(stateDir, config = {}) {
  const { script, pidFile } = monitorPaths(stateDir, config)
  const pid = readPid(pidFile)
  if (!pid) return { ok: false, error: '没有 pid 文件：' + pidFile }
  if (!isAlive(pid)) return { ok: false, error: 'pid=' + pid + ' 已不存活（残留 pid 文件，可删除）' }
  const cmd = processCmdline(pid)
  if (!cmd) return { ok: false, error: '读不到 pid=' + pid + ' 的命令行，拒绝停止（验不了就不杀）' }
  const scriptName = basename(String(script))
  if (!cmd.includes(scriptName) && !cmd.includes('ctx-monitor')) return { ok: false, error: 'pid=' + pid + ' 的命令行与监测脚本不符，拒绝停止：' + cmd.slice(0, 160) }
  try { process.kill(pid) } catch (e) { return { ok: false, error: 'kill 失败：' + msgOf(e) } }
  return { ok: true, stopped: true, pid }
}

export function monitorRestart(stateDir, config = {}) {
  const stop = monitorStop(stateDir, config)
  const start = monitorStart(stateDir, config)
  return { ok: start.ok, stop, start }
}

export function apply(ctx, config = {}) {
  const stateDir = config.stateDir || DEFAULT_STATE_DIR
  const routeBase = config.route || '/superagent'

  const handler = async (req, res) => {
    const pathname = String(req.url || '').split('?')[0]
    // sa-187/P01（第二轮 judge 修正）：写方法纵深校验 —— fail-closed，写方法一律校验，不做「无 headers 就放行」后门。
    // 归一化兼容真实 req.headers（对象）与 Headers-like（带 get(k)）两种形态；
    // Origin 白名单只看本机回环；POST 的 content-type 缺失或不含 application/json → 415。
    const wMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase())
    if (wMethod) {
      const hh = req.headers || {}
      const getH = (k) => (typeof hh.get === 'function' ? hh.get(k) : hh[k])
      const origin = getH('origin') != null ? String(getH('origin')) : ''
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
        return json(res, 403, { ok: false, error: 'bad origin' })
      }
      if (String(req.method || '').toUpperCase() === 'POST') {
        const ct = getH('content-type') != null ? String(getH('content-type')) : ''
        if (!ct.toLowerCase().includes('application/json')) {
          return json(res, 415, { ok: false, error: 'content-type must be application/json' })
        }
      }
    }
    try {
      if (pathname === routeBase + '/selftest') {
        let n = 0
        let error = null
        try { n = readPanel(stateDir).total } catch (e) { error = String(e && e.message ? e.message : e) }
        return json(res, 200, { ok: !error, stateDir, stateFile: join(stateDir, 'state.json'), tickets: n, error })
      }
      if (pathname === routeBase + '/tickets') {
        return json(res, 200, readPanel(stateDir))
      }
      if (pathname === routeBase + '/evidence') {
        const q = new URL(String(req.url || ''), 'http://localhost').searchParams
        const ticketId = String(q.get('ticketId') || '')
        if (!/^(?:sa|s\d+)-\d+$/.test(ticketId)) return json(res, 400, { ok: false, error: 'bad ticketId' })
        const file = resolveEvidence(stateDir, ticketId)
        if (!file) return json(res, 404, { ok: false, error: 'no evidence file for ' + ticketId })
        try {
          const preview = readEvidencePreview(file)
          const rel = relative(realpathSync(stateDir), file)
          return json(res, 200, { ok: true, path: file, relative: rel, ...preview })
        } catch (e) { return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }) }
      }
      if (pathname === routeBase + '/reveal' && req.method === 'POST') {
        let ticketId = ''
        try { ticketId = String((JSON.parse(await readBody(req)) || {}).ticketId || '') } catch {}
        if (!/^(?:sa|s\d+)-\d+$/.test(ticketId)) return json(res, 400, { ok: false, error: 'bad ticketId' })
        const file = resolveEvidence(stateDir, ticketId)
        if (!file) return json(res, 404, { ok: false, error: 'no evidence file for ' + ticketId })
        try {
          const child = spawn('explorer.exe', ['/select,' + file], { detached: true, stdio: 'ignore' })
          child.unref()
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
        }
        return json(res, 200, { ok: true, path: file })
      }
      if (pathname === routeBase + '/settings') {
        if (req.method === 'GET') {
          const file = join(stateDir, 'settings.json')
          let mtime = null
          try { mtime = statSync(file).mtimeMs } catch {}
          return json(res, 200, { ok: true, file, mtime, defaults: SETTINGS_DEFAULTS, applyModes: APPLY_MODES, settings: readSettingsFile(stateDir), effective: effectiveSettings(stateDir) })
        }
        if (req.method === 'POST') {
          let body = null
          try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { ok: false, error: 'bad json' }) }
          let norm = null
          try { norm = normalizeSettings(body) } catch (e) { return json(res, 400, { ok: false, error: String(e && e.message ? e.message : e) }) }
          const file = join(stateDir, 'settings.json')
          try {
            const cur = readSettingsFile(stateDir)
            const next = deepMerge(cur, norm)
            const tmp = file + '.' + commandFileName('tmp')
            writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8')
            renameSync(tmp, file)
            return json(res, 200, { ok: true, file, settings: next, effective: effectiveSettings(stateDir), saved: Object.keys(norm).length })
          } catch (e) { return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }) }
        }
        return json(res, 405, { ok: false, error: 'method' })
      }
      if (pathname === routeBase + '/diagnostics') {
        // 只读：任何异常都降级成 unverified（buildDiagnostics 内部兜底），这里再兜一层
        try {
          const r = await buildDiagnostics(stateDir, config, ctx)
          return json(res, 200, r)
        } catch (e) {
          return json(res, 200, { ok: false, error: msgOf(e), checks: [], summary: { ok: 0, missing: 0, bad: 0, unverified: 0 } })
        }
      }
      if (pathname === routeBase + '/monitor/start' && req.method === 'POST') {
        const r = monitorStart(stateDir, config)
        if (r.ok) { try { writeSettingsQuiet(stateDir, { ctxMonitor: { enabled: true } }) } catch {} }
        return json(res, r.ok ? 200 : 500, { ...r, enabled: r.ok })
      }
      if (pathname === routeBase + '/monitor/stop' && req.method === 'POST') {
        const r = monitorStop(stateDir, config)
        if (r.ok) { try { writeSettingsQuiet(stateDir, { ctxMonitor: { enabled: false } }) } catch {} }
        return json(res, r.ok ? 200 : 400, r)
      }
      if (pathname === routeBase + '/monitor/restart' && req.method === 'POST') {
        const r = monitorRestart(stateDir, config)
        return json(res, r.ok ? 200 : 500, r)
      }
      if (pathname === routeBase + '/owners') {
        try {
          const doc = JSON.parse(readFileSync(join(stateDir, 'owners.json'), 'utf8'))
          return json(res, 200, { ok: true, owners: Array.isArray(doc.owners) ? doc.owners : [], workers: Array.isArray(doc.workers) ? doc.workers : [], judges: Array.isArray(doc.judges) ? doc.judges : [] })
        } catch (e) { return json(res, 200, { ok: false, owners: [], error: String(e && e.message ? e.message : e) }) }
      }
      if (pathname === routeBase + '/stats') {
        try {
          const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
          return json(res, 200, { ok: true, ...buildStats(stateDir, state) })
        } catch (e) { return json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) }) }
      }
      if (pathname === routeBase + '/archive') {
        const q = new URL(String(req.url || ''), 'http://localhost').searchParams.get('q') || ''
        try {
          const allRows = readArchive(stateDir, q)
          const rows = allRows.slice(0, 200)
          return json(res, 200, { ok: true, q, total: allRows.length, returned: rows.length, hasMore: allRows.length > rows.length, rows })
        } catch (e) { return json(res, 200, { ok: false, q, total: 0, returned: 0, hasMore: false, rows: [], error: String(e && e.message ? e.message : e) }) }
      }
      if (pathname === routeBase + '/archive/evidence') {
        const q = new URL(String(req.url || ''), 'http://localhost').searchParams
        const ticketId = String(q.get('ticketId') || '')
        const file = String(q.get('file') || '')
        if (!file) {
          const files = listArchiveEvidence(stateDir, ticketId)
          return json(res, 200, { ok: files.length > 0, ticketId, count: files.length, files })
        }
        const r = readArchiveEvidence(stateDir, ticketId, file)
        return json(res, r.ok ? 200 : (r.code || 400), r)
      }
      // sa-187/P03：归档判词 —— GET ?ticketId=sa-0xx，读 archive/verdicts/<id>.md
      if (pathname === routeBase + '/archive/verdict') {
        const q = new URL(String(req.url || ''), 'http://localhost').searchParams
        const ticketId = String(q.get('ticketId') || '')
        const r = readArchiveVerdict(stateDir, ticketId)
        return json(res, r.ok ? 200 : (r.code || 400), r)
      }
      if (pathname === routeBase + '/archive-one' && req.method === 'POST') {
        let ticketId = ''
        try { ticketId = String((JSON.parse(await readBody(req)) || {}).ticketId || '') } catch (e) {}
        const r = writeArchiveCommand(stateDir, ticketId)
        return json(res, r.ok ? 200 : (r.code || 400), r)
      }
      if (pathname === routeBase + '/rollback' && req.method === 'POST') {
        let body = null
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: 'bad json' }) }
        const r = writeRollbackCommand(stateDir, body)
        return json(res, r.ok ? 200 : (r.code || 400), r)
      }
      if (pathname === routeBase + '/requeue' && req.method === 'POST') {
        let ticketId = ''
        try { ticketId = String((JSON.parse(await readBody(req)) || {}).ticketId || '') } catch (e) {}
        const r = writeRequeueCommand(stateDir, ticketId)
        return json(res, r.ok ? 200 : (r.code || 400), r)
      }
      if (pathname === routeBase + '/close' && req.method === 'POST') {
        let ticketId = ''
        try { ticketId = String((JSON.parse(await readBody(req)) || {}).ticketId || '') } catch {}
        if (!/^(?:sa|s\d+)-\d+$/.test(ticketId)) return json(res, 400, { ok: false, error: 'bad ticketId' })
        try {
          const dir = join(stateDir, 'commands')
          mkdirSync(dir, { recursive: true })
          const file = join(dir, commandFileName('close', ticketId) + '.json')
          writeFileSync(file, JSON.stringify({ ticketId, action: 'close', by: 'panel', at: new Date().toISOString() }))
          return json(res, 200, { ok: true, queued: true, ticketId, file })
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
        }
      }
      return json(res, 404, { error: 'not found', hint: routeBase + '/tickets | ' + routeBase + '/selftest' })
    } catch (err) {
      // 面板读不到状态时也不许把宿主搞坏：返回空表 + error
      return json(res, 200, { generatedAt: new Date().toISOString(), counts: {}, active: 0, total: 0, tickets: [], error: String(err && err.message ? err.message : err) })
    }
  }

  try {
    ctx.inject(['webServer'], (childCtx) => {
      try {
        childCtx.effect(
          () => childCtx.webServer.register({ kind: 'prefix', path: routeBase, handler }),
          'superagent-panel routes',
        )
      } catch {}
    })
  } catch {}
  return { stateDir, routeBase }
}
