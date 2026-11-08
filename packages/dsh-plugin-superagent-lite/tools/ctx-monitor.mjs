#!/usr/bin/env node
// ctx-monitor.mjs — 低内存会话上下文占用监测（可选配套）
//
// 【只读、不注入】本脚本只「被动读」projcache JSON：不写任何会话的 AGENTS.md / 提示词 / 会话配置，
// 也不调用任何 DSH 接口去改会话。它落盘的东西只有三样：ctx-alerts.log、ingress.jsonl（报警事件）、
// 以及 --daemon 时的 pid 文件。
//
// 数据源（只读这一种）：<USERPROFILE>/.dsh/storages/session_projcache/sessions/*.json
//   record.rows.contextPressure.val         → { pressureTokens, contextWindow }
//   record.rows.modelSelection.val.lastUsed → { provider, model }
//   record.identity.cwd / record.rows.title.val
// 占用百分比 = pressureTokens / contextWindow * 100（surfaceTokens 偏小，不用）
//
// 扫描范围：只处理 cwd 落在 --root（或环境变量 DSH_CTX_ROOT；默认 = 当前工作目录）下的会话。
// 新开的会话会被自动扫到（每轮全量 list 目录，不依赖登记表）。
//
// **每轮热读 settings.json**：监测进程每轮从 <settings.json> 的 ctxMonitor 读参数（按 mtime 缓存），
// 改阈值/间隔**不用重启进程**——下一轮即生效。命令行参数只作「临时覆盖」（自测/一次性用）。
//
// 阈值匹配顺序（命中哪档会写进告警行，便于核对）：
//   1) ctxMonitor.thresholds 里 provider 精确匹配 → 用它
//   2) provider 是 deepseek-account（官方 DS）→ thresholdOfficial（默认 65）
//   3) 其余 → thresholdOther（默认 85）
// 冷却默认 30 分钟 + 迟滞 5%（掉到阈值-5 以下才重新武装）。
// 输出：正常轮询**静默**（只有越阈值才打印 ALERT 行）；--once 打表格；--verbose 打每轮耗时。
// 报警双通道：ctx-alerts.log（一行 JSON，超 1MB 轮转 .1）+ ingress.jsonl（建工单，body 里带 --session-line 那一行）。
//
// 用法：
//   node ctx-monitor.mjs                      # 常驻，默认 60s 一轮，静默，只在越线时输出
//   node ctx-monitor.mjs --once               # 扫一轮打印表格退出（验收用）
//   node ctx-monitor.mjs --once --dry-run     # 不写任何文件（最常用的自检）
//   node ctx-monitor.mjs --once --json        # 同上，JSON
//   node ctx-monitor.mjs --daemon             # 常驻 + pid 文件
//   node ctx-monitor.mjs --session-line=<sid> # 只打一行 [ctx] ...（贴验收用，只读）
// 参数见 --help。


import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = dirname(HERE)

// 默认数据目录（可由 --data-dir / DSH_CTX_DATA 覆盖）。包里跑就是「包根/ctx-monitor-data」，
// 不写死任何绝对路径。
const DEFAULT_DATA_DIR = join(PKG_DIR, 'ctx-monitor-data')

// 报警要投给谁：**不写死**。优先级 命令行 --owner-session → 环境变量 → settings(? 里没有) 。
// 空串时只写 ctx-alerts.log，不写 ingress（宁可不建单，也不把告警投到错误的人名下）。
const DEFAULT_OWNER = process.env.DSH_CTX_OWNER || ''

const HOUR = 3600 * 1000
const MB = 1024 * 1024

const DEFAULTS = {
  // 只扫 cwd 落在这个根下的会话；默认 = 环境变量 DSH_CTX_ROOT，否则当前工作目录
  root: process.env.DSH_CTX_ROOT || process.cwd(),
  dir: join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'),
  dataDir: process.env.DSH_CTX_DATA || DEFAULT_DATA_DIR,
  alertsLog: null,   // 由 dataDir 派生
  ingressFile: null, // 由 dataDir 派生
  pidFile: null,     // 由 dataDir 派生；面板启动时会显式传 --pid-file 对齐
  settingsFile: process.env.DSH_SETTINGS || '', // 面板 settings.json；空 = 不热读
  ownerSession: DEFAULT_OWNER,
  thresholds: [],    // [{provider, pct}] 按 provider 覆盖
  intervalMs: 60000,
  cooldownMs: 30 * 60 * 1000,
  thresholdDs: 65,
  thresholdOther: 85,
  hysteresis: 5,
  ingress: true,
  verbose: false,
  daemon: false,
  rotateBytes: 1 * MB, // ctx-alerts.log 超过就轮转成 .1
  maxFileBytes: 16 * MB, // 正常 projcache 30KB 级；异常大文件跳过，别为了一个坏文件吃掉内存
  staleMs: 24 * HOUR,
  // 缓存只认 mtimeMs+size，理论上存在「同尺寸同毫秒改写」漏检；每 N 轮无条件全量重解析一次兜底
  fullReparseEvery: 200,
  // 2026-11-09：压缩检出。同一会话前后两轮 pct 掉 ≥ dropPts、且掉之前已 ≥ dropMinPrevPct，
  // 判为「压缩」→ 写一条【压缩后自检】事件（带角色化简报）。只提醒，不碰任何会话。
  dropPts: 15,
  dropMinPrevPct: 30,
}

// 由 dataDir 派生三个落盘路径（DEFAULTS 里是 null，createMonitor 时统一算）
export function resolvePaths(o) {
  const dataDir = String(o.dataDir || DEFAULT_DATA_DIR)
  return {
    dataDir,
    alertsLog: o.alertsLog || join(dataDir, 'ctx-alerts.log'),
    ingressFile: o.ingressFile || join(dataDir, 'ingress.jsonl'),
    pidFile: o.pidFile || join(dataDir, 'ctx-monitor.pid'),
  }
}

const pct1 = (v) => Math.round(v * 10) / 10

// ---- 扫描范围 ----------------------------------------------------------------

// 路径归一：统一分隔符、去掉尾部分隔符、忽略大小写（Windows）
export function normPath(p) {
  const s = String(p || '').replace(/\//g, '\\').replace(/\\+$/, '')
  return s.toLowerCase()
}

// cwd 是否落在 root 下（root 本身也算在内；必须带分隔符边界，防止 subagentX 这种前缀误命中）
export function inScope(cwd, root = DEFAULTS.root) {
  const c = normPath(cwd)
  const r = normPath(root)
  if (!c || !r) return false
  return c === r || c.startsWith(r + '\\')
}

// ---- 阈值 --------------------------------------------------------------------

// 官方 DS 的判定（2026-11-06 第二轮修正，用户口径）：**只看 provider 是不是 deepseek-account**。
// TRAE / raccoon / qoder 等中转的 deepseek 模型属于第三方渠道，按「其他模型」= 85%。
// 曾经按 model 正则兜底（/^deepseek-(flash|chat|reasoner|v4)/）判 65%，那会把 trae/deepseek-v4.1-flash
// 错判成官方 DS —— 已删除，不再用 model 名推断阈值。
export function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase()
}

export function isOfficialDeepSeek(provider) {
  return normalizeProvider(provider) === 'deepseek-account'
}

// model 参数保留只为调用兼容，阈值只由 provider 决定
// 阈值匹配顺序（命中哪档会写进告警行，便于核对）：
//   1) thresholds 里 provider 精确匹配 → 用它（来源记为 provider:<name>）
//   2) provider 是 deepseek-account（官方 DS）→ thresholdDs（来源 official）
//   3) 其余 → thresholdOther（来源 other）
export function thresholdFor(provider, model, opts = {}) {
  const ds = opts.thresholdDs ?? DEFAULTS.thresholdDs
  const other = opts.thresholdOther ?? DEFAULTS.thresholdOther
  const norm = normalizeProvider(provider)
  const list = Array.isArray(opts.thresholds) ? opts.thresholds : []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const p = normalizeProvider(row.provider)
    const pct = Number(row.pct)
    if (p && p === norm && Number.isFinite(pct)) return pct
  }
  return isOfficialDeepSeek(provider) ? ds : other
}

// 同时给出「这一档是怎么来的」，写进告警行/表格，方便核对
export function thresholdSource(provider, opts = {}) {
  const norm = normalizeProvider(provider)
  const list = Array.isArray(opts.thresholds) ? opts.thresholds : []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const p = normalizeProvider(row.provider)
    const pct = Number(row.pct)
    if (p && p === norm && Number.isFinite(pct)) return 'provider:' + p
  }
  return isOfficialDeepSeek(provider) ? 'official' : 'other'
}

// ---- 单行摘要（--session-line / ingress body 共用） --------------------------

export function shortSid(sid) {
  const v = String(sid || '')
  const u = v.replace(/^session-/, '')
  if (!u) return '(none)'
  return u.length > 14 ? u.slice(0, 8) + '…' + u.slice(-4) : u
}

// 固定格式：[ctx] <session短号> <provider/model> <pct>% (阈值 <t>%[, 已越线])
export function sessionLine(rec, thresholdOverride, sourceTag) {
  const t = thresholdOverride != null ? thresholdOverride : rec.threshold
  const crossed = rec.pct > t
  const src = sourceTag || rec.thresholdSource
  const srcText = src ? ' [' + src + ']' : ''
  return '[ctx] ' + shortSid(rec.sessionId) + ' ' + (rec.provider || '?') + '/' + (rec.model || '?') +
    ' ' + pct1(rec.pct).toFixed(1) + '% (阈值 ' + t + '%' + (crossed ? ', 已越线' : '') + ')' + srcText
}

// ---- 压缩后自检简报（2026-11-09 用户定调）--------------------------------------
// 用户原话：自动压缩脚本检验 worker 和 judge 时，要告诉 judge「已过的工单证据性极强、可置信，
// 摘要不置信，核对证据工单即可」。这段文本就是那次口径的落字；CLI 用 --brief=<role> 直接打。
export const COMPACT_BRIEF = {
  common: [
    '【压缩后自检·简报】摘要一律不可信：版本号 / 字节数 / 单量 / 水位 / 哈希都别引用，按实测现查。',
    '判据优先级：工单证据（sa_evidence 的清单 + 判词）> 交接文档 > 压缩摘要。',
  ],
  judge: [
    '你是 judge：**已经 done 的工单不用重审** —— 只要 sa_evidence <单> 清单非空、孤儿 orphan=0、判词 pass 在，那条单的证据链极强、可置信。',
    '要引用或复判，就核对那张单的证据本身（sa_evidence / 产物文件实测），不必回到摘要里的转述，也不必全量重跑。',
    '力气只花在：清单缺件、缺判词、以及新交来的 ready 单。',
  ],
  worker: [
    '你是 worker：已交过的活看工单证据（sa_evidence <单> 的清单）与产物文件实测，不要照摘要复述。',
    '先 sa_list 看有没有指向你的 running/ready 单，有就接着干；没有就等 owner 派。',
  ],
}

export function compactBrief(role = 'all') {
  const r = String(role || 'all').toLowerCase()
  const pick = r === 'judge' ? ['common', 'judge'] : r === 'worker' ? ['common', 'worker'] : r === 'owner' ? ['common'] : ['common', 'judge', 'worker']
  return pick.flatMap((k) => COMPACT_BRIEF[k]).join('\n')
}

// ---- 日志轮转 / pid 文件 ------------------------------------------------------

// ctx-alerts.log 超过 maxBytes → 改名成 .1（旧的 .1 覆盖），再由调用方写新文件
export function rotateAlertsLog(file, maxBytes = DEFAULTS.rotateBytes) {
  let st
  try { st = statSync(file) } catch (e) { return { rotated: false, reason: 'absent' } }
  if (st.size <= maxBytes) return { rotated: false, size: st.size }
  const dest = file + '.1'
  try { unlinkSync(dest) } catch {}
  try {
    renameSync(file, dest)
    return { rotated: true, size: st.size, dest }
  } catch (e) {
    // 轮转失败不该挡住报警：记一条错误，继续往原文件追加
    return { rotated: false, size: st.size, error: e && e.message }
  }
}

function readPidFile(file) {
  try { const n = Number(String(readFileSync(file, 'utf8')).trim()); return Number.isFinite(n) ? n : null } catch { return null }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

// 拿 pid 文件：已有活着的实例 → 返回 ok:false（不抢）；残留的旧 pid → 覆盖
export function acquirePidFile(file) {
  const existing = readPidFile(file)
  if (existing && existing !== process.pid && pidAlive(existing)) return { ok: false, pid: existing }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, String(process.pid) + '\n', 'utf8')
    return { ok: true, pid: process.pid }
  } catch (e) {
    return { ok: false, error: e && e.message }
  }
}

export function releasePidFile(file) {
  if (readPidFile(file) !== process.pid) return false
  try { unlinkSync(file); return true } catch { return false }
}

// ---- 记录抽取 -----------------------------------------------------------------

// 从 projcache JSON 里抠出监测需要的那几个字段；结构不对就返回 null（跳过，不猜）
export function extractRecord(j, sessionId, file) {
  const rows = j && j.record && j.record.rows
  if (!rows) return null
  const cp = rows.contextPressure && rows.contextPressure.val
  if (!cp) return null
  const window = Number(cp.contextWindow)
  const pressure = Number(cp.pressureTokens)
  if (!Number.isFinite(window) || window <= 0) return null
  if (!Number.isFinite(pressure) || pressure < 0) return null
  const sel = (rows.modelSelection && rows.modelSelection.val && rows.modelSelection.val.lastUsed) || null
  const identity = j.record.identity || {}
  const titleVal = rows.title && rows.title.val
  const provider = sel ? String(sel.provider || '') : ''
  return {
    sessionId,
    file,
    cwd: String(identity.cwd || ''),
    title: typeof titleVal === 'string' ? titleVal : '',
    provider,
    providerMissing: !provider.trim(), // provider 完全缺失：按「其他」85%，并在告警日志里标出来
    model: sel ? String(sel.model || '') : '',
    window,
    pressure,
    pct: (pressure / window) * 100,
  }
}

// ---- 监测器 -------------------------------------------------------------------

export function createMonitor(partial = {}) {
  // 命令行/环境给的是「基础值」；每轮还会用 settings.json 的 ctxMonitor 覆盖（见 refreshFromSettings）
  const base = { ...DEFAULTS, ...partial }
  const paths = resolvePaths(base)
  const o = { ...base }
  if (o.alertsLog == null) o.alertsLog = paths.alertsLog
  if (o.ingressFile == null) o.ingressFile = paths.ingressFile
  if (o.pidFile == null) o.pidFile = paths.pidFile
  if (o.cooldownMin != null && partial.cooldownMs == null) o.cooldownMs = Number(o.cooldownMin) * 60 * 1000
  const cache = new Map() // full path -> { mtimeMs, size, seenAt, rec, why }
  const state = new Map() // sessionId -> { armed, lastAlertMs, lastSeen }
  const counters = { rounds: 0 }

  // ── settings.json 热读（mtime 缓存）：面板改了阈值/间隔，下一轮就生效 ──
  let settingsCache = { at: -1, value: null }
  let lastSettingsReadAt = null
  const readSettings = () => {
    const f = String(base.settingsFile || '')
    if (!f) return null
    let st = null
    try { st = statSync(f) } catch { return null }
    if (settingsCache.at === st.mtimeMs) return settingsCache.value
    let v = null
    try { v = JSON.parse(readFileSync(f, 'utf8')) } catch { v = null }
    const cm = (v && typeof v === 'object' && v.ctxMonitor && typeof v.ctxMonitor === 'object') ? v.ctxMonitor : null
    settingsCache = { at: st.mtimeMs, value: cm }
    lastSettingsReadAt = new Date().toISOString()
    return cm
  }
  const numOr = (v, d, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return d
    if (min != null && n < min) return d
    if (max != null && n > max) return d
    return n
  }
  // 把 settings 的 ctxMonitor 合进 o（命令行显式给的仍然优先，因为「命令行只作临时覆盖」）
  const applySettings = () => {
    const cm = readSettings()
    if (!cm) return o
    const fromCli = (k) => partial[k] != null
    if (!fromCli('intervalMs')) {
      const iv = numOr(cm.intervalSec, null, 1, 86400)
      if (iv != null) o.intervalMs = Math.round(iv * 1000)
    }
    if (!fromCli('thresholdDs')) {
      const v = numOr(cm.thresholdOfficial, null, 0.1, 100)
      if (v != null) o.thresholdDs = v
    }
    if (!fromCli('thresholdOther')) {
      const v = numOr(cm.thresholdOther, null, 0.1, 100)
      if (v != null) o.thresholdOther = v
    }
    if (!fromCli('thresholds')) {
      const arr = Array.isArray(cm.thresholds) ? cm.thresholds : []
      o.thresholds = arr
        .filter((r) => r && typeof r === 'object' && typeof r.provider === 'string' && Number.isFinite(Number(r.pct)))
        .map((r) => ({ provider: String(r.provider).trim().toLowerCase(), pct: Number(r.pct) }))
    }
    if (!fromCli('ingress') && typeof cm.alertIngress === 'boolean') o.ingress = cm.alertIngress !== false
    return o
  }

  const nowIso = () => new Date().toISOString()

  function writeAlertLines(rec, threshold) {
    const at = nowIso()
    const sid = rec.sessionId
    const pct = pct1(rec.pct)
    const line = sessionLine(rec, threshold) // 报警里也要带这一行，便于一眼看全
    if (o.dryRun) return { wrote: false }
    let wrote = false
    try {
      mkdirSync(dirname(o.alertsLog), { recursive: true })
      const rot = rotateAlertsLog(o.alertsLog, o.rotateBytes)
      if (rot && rot.error) console.error('[ctx-monitor] 轮转 ' + o.alertsLog + ' 失败：' + rot.error)
      const row = {
        at, sessionId: sid, cwd: rec.cwd, title: rec.title,
        provider: rec.provider, model: rec.model,
        pct, threshold, window: rec.window, pressure: rec.pressure, level: 'warn',
      }
      if (rec.providerMissing) row.note = 'provider-missing' // 用户要求：provider 缺失要在日志里标出来（仍按 85%）
      appendFileSync(o.alertsLog, JSON.stringify(row) + '\n', 'utf8')
      wrote = true
    } catch (e) {
      console.error('[ctx-monitor] 写 ' + o.alertsLog + ' 失败：' + (e && e.message))
    }
    if (o.ingress !== false) {
      try {
        mkdirSync(dirname(o.ingressFile), { recursive: true })
        appendFileSync(o.ingressFile, JSON.stringify({
          at,
          source: 'ctx-monitor',
          key: 'ctx:' + sid + ':' + Math.floor(Date.now() / 60000), // 按分钟分桶，防同分钟重复建单
          title: '【上下文告警】' + shortSid(sid) + ' ' + rec.pct.toFixed(1) + '%（' + (rec.model || 'unknown') + '，阈值 ' + threshold + '%）',
          // body 第一行就是那条固定格式摘要（用户要求：报警和交付信息一起出现，不额外刷屏）
          body: line + '\n' +
                'sessionId=' + sid + '\ncwd=' + rec.cwd + '\nmodel=' + rec.provider + '/' + rec.model +
                '\npct=' + pct + '% (pressure=' + rec.pressure + '/' + rec.window + ')',
          sessionId: o.ownerSession || '', // 由 --owner-session / DSH_CTX_OWNER 提供；空则只写 alerts 不建单
          type: 'test',
        }) + '\n', 'utf8')
      } catch (e) {
        console.error('[ctx-monitor] 写 ' + o.ingressFile + ' 失败：' + (e && e.message))
      }
    }
    return { wrote, line }
  }

  // 压缩后自检事件：只写 alerts 日志 + ingress（建一张【压缩后自检】单给 owner），不改任何会话。
  // body 里带角色化简报（compactBrief('all')），owner 转给 judge/worker 时可原样贴。
  function writeCompactLines(rec) {
    const at = nowIso()
    const sid = rec.sessionId
    const line = sessionLine(rec, rec.threshold)
    const from = pct1(rec.compactedFrom)
    if (o.dryRun) return { wrote: false, line }
    try {
      mkdirSync(dirname(o.alertsLog), { recursive: true })
      const rot = rotateAlertsLog(o.alertsLog, o.rotateBytes)
      if (rot && rot.error) console.error('[ctx-monitor] 轮转 ' + o.alertsLog + ' 失败：' + rot.error)
      appendFileSync(o.alertsLog, JSON.stringify({
        at, level: 'compaction', sessionId: sid, cwd: rec.cwd, title: rec.title,
        provider: rec.provider, model: rec.model,
        from: from, pct: pct1(rec.pct), threshold: rec.threshold,
      }) + '\n', 'utf8')
    } catch (e) {
      console.error('[ctx-monitor] 写 ' + o.alertsLog + ' 失败：' + (e && e.message))
    }
    if (o.ingress !== false) {
      try {
        mkdirSync(dirname(o.ingressFile), { recursive: true })
        appendFileSync(o.ingressFile, JSON.stringify({
          at,
          source: 'ctx-monitor',
          key: 'ctx-compact:' + sid + ':' + Math.floor(Date.now() / 60000),
          title: '【压缩后自检】' + shortSid(sid) + ' ' + from.toFixed(1) + '% → ' + pct1(rec.pct).toFixed(1) + '%（' + (rec.model || 'unknown') + '）',
          body: line + '\n' +
                'sessionId=' + sid + '\ncwd=' + rec.cwd + '\nmodel=' + rec.provider + '/' + rec.model +
                '\npct=' + pct1(rec.pct).toFixed(1) + '%（压缩前 ' + from.toFixed(1) + '%）\n\n' + compactBrief('all'),
          sessionId: o.ownerSession || '', // 由 --owner-session / DSH_CTX_OWNER 提供；空则只写 alerts 不建单
          type: 'test',
        }) + '\n', 'utf8')
      } catch (e) {
        console.error('[ctx-monitor] 写 ' + o.ingressFile + ' 失败：' + (e && e.message))
      }
    }
    return { wrote: true, line }
  }

  function scanOnce() {
    const t0 = process.hrtime.bigint()
    // sa-198 C2：每轮都从 settings.json 的 ctxMonitor 刷新参数（改了阈值/间隔下一轮即生效）
    applySettings()
    const now = Date.now()
    counters.rounds++
    const forceFull = o.fullReparseEvery > 0 && counters.rounds > 1 && counters.rounds % o.fullReparseEvery === 0
    const stats = {
      scanned: 0, reparsed: 0, cached: 0, skipped: 0, skippedNoSample: 0, skippedBadValue: 0,
      outOfScope: 0, errors: 0, alerts: 0, dir: o.dir, root: o.root, round: counters.rounds, forceFull,
    }
    const recs = []
    const fired = []
    const dropped = [] // 本轮检出「被压缩」的会话（pct 大幅回落）
    let entries
    try {
      entries = readdirSync(o.dir, { withFileTypes: true })
    } catch (e) {
      stats.errors++
      stats.error = '读目录失败：' + (e && e.message)
      stats.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6
      return { ...stats, rows: [], fired: [] }
    }
    const present = new Set()
    const collect = (rec, why) => {
      if (rec) {
        // 追加要求 ①：cwd 不在 --root 下的会话一律跳过（不报警、不写日志），只计数
        if (!inScope(rec.cwd, o.root)) { stats.outOfScope++; stats.skipped++; return }
        recs.push(rec)
        return
      }
      stats.skipped++
      stats[why === 'no-sample' ? 'skippedNoSample' : 'skippedBadValue']++
    }
    for (const ent of entries) {
      if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue
      const full = join(o.dir, ent.name)
      let st
      try { st = statSync(full) } catch { stats.errors++; continue }
      present.add(full)
      stats.scanned++
      if (st.size > o.maxFileBytes) { stats.skipped++; stats.skippedBadValue++; continue }
      const sessionId = ent.name.replace(/\.json$/i, '')
      const hit = cache.get(full)
      if (!forceFull && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        hit.seenAt = now
        stats.cached++
        collect(hit.rec, hit.why)
        continue
      }
      try {
        const j = JSON.parse(readFileSync(full, 'utf8'))
        const rec = extractRecord(j, sessionId, full)
        const cpv = j && j.record && j.record.rows && j.record.rows.contextPressure && j.record.rows.contextPressure.val
        // 还没采样过（val 里没 contextWindow）→ no-sample；有窗口但数值坏 → bad-value
        const why = rec ? null : (cpv && Number(cpv.contextWindow) > 0 ? 'bad-value' : 'no-sample')
        cache.set(full, { mtimeMs: st.mtimeMs, size: st.size, seenAt: now, rec, why })
        stats.reparsed++
        collect(rec, why)
      } catch (e) {
        // 写到一半 / 结构异常：不缓存，下轮重试；不退出、不拖垮主循环
        stats.errors++
        stats.lastError = ent.name + ': ' + (e && e.message)
      }
    }
    for (const [k, v] of cache) if (!present.has(k) || now - v.seenAt > o.staleMs) cache.delete(k)
    for (const [k, v] of state) if (now - (v.lastSeen || 0) > o.staleMs) state.delete(k)

    for (const rec of recs) {
      const threshold = thresholdFor(rec.provider, rec.model, o)
      rec.threshold = threshold
      let st = state.get(rec.sessionId)
      if (!st) { st = { armed: true, lastAlertMs: 0, lastSeen: now }; state.set(rec.sessionId, st) }
      if (rec.pct < threshold - o.hysteresis) st.armed = true
      rec.alerted = false
      if (st.armed && rec.pct > threshold) {
        if (now - st.lastAlertMs >= o.cooldownMs) {
          st.armed = false
          st.lastAlertMs = now
          rec.alerted = true
          fired.push(rec)
          stats.alerts++
        } else {
          rec.suppressed = true
        }
      }
      // 压缩检出：pct 大幅回落 = 会话刚被压缩（摘要已替换原文，必须重新自检）
      if (st.lastPct != null && st.lastPct >= o.dropMinPrevPct && st.lastPct - rec.pct >= o.dropPts) {
        rec.compactedFrom = st.lastPct
        dropped.push(rec)
      }
      st.lastPct = rec.pct
      st.lastSeen = now
    }
    for (const rec of fired) writeAlertLines(rec, rec.threshold)
    for (const rec of dropped) writeCompactLines(rec)

    recs.sort((a, b) => b.pct - a.pct)
    stats.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6
    stats.compactions = dropped.length
    return { ...stats, round: counters.rounds, rows: recs, fired: fired.map((r) => r.sessionId), compacted: dropped.map((r) => r.sessionId) }
  }

  return {
    opts: o,
    scanOnce,
    cacheSize: () => cache.size,
    stateSize: () => state.size,
    resetState: () => { cache.clear(); state.clear() },
  }
}

// ---- 输出 ---------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n)
const padl = (s, n) => String(s).padStart(n)

export function formatRow(r) {
  return [
    padl(pct1(r.pct).toFixed(1), 6),
    padl(r.threshold, 4),
    pad(r.provider + '/' + (r.model || '?'), 40),
    pad(shortSid(r.sessionId), 16),
    pad((r.title || '').slice(0, 18), 20),
    r.cwd,
  ].join(' ')
}

export function printOnce(res, opts = {}) {
  if (opts.json) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      dir: res.dir, root: res.root,
      scanned: res.scanned, reparsed: res.reparsed, cached: res.cached,
      skipped: res.skipped, skippedNoSample: res.skippedNoSample, skippedBadValue: res.skippedBadValue,
      outOfScope: res.outOfScope, errors: res.errors, alerts: res.alerts, forceFull: !!res.forceFull,
      elapsedMs: Math.round(res.elapsedMs * 10) / 10,
      rows: res.rows.map((r) => ({
        sessionId: r.sessionId, pct: pct1(r.pct), threshold: r.threshold,
        provider: r.provider, model: r.model, window: r.window, pressure: r.pressure,
        title: r.title, cwd: r.cwd, alerted: !!r.alerted, suppressed: !!r.suppressed,
        line: sessionLine(r),
      })),
    }, null, 1))
    return
  }
  if (res.error) console.error('[ctx-monitor] ' + res.error)
  console.log('[ctx-monitor] root=' + res.root + ' dir=' + res.dir)
  console.log('   %    thr model' + ' '.repeat(35) + 'session          title              cwd')
  for (const r of res.rows) {
    const mark = r.alerted ? '!' : (r.suppressed ? '~' : ' ')
    console.log(mark + ' ' + formatRow(r))
  }
  const head = res.rows.filter((r) => r.alerted).length
  console.log('[ctx-monitor] scanned=' + res.scanned + ' inScope=' + res.rows.length + ' outOfScope=' + res.outOfScope +
    ' reparsed=' + res.reparsed + ' cached=' + res.cached +
    ' skipped=' + res.skipped + '(无压采=' + res.skippedNoSample + ',数值异常=' + res.skippedBadValue + ')' +
    ' errors=' + res.errors + ' alerts=' + res.alerts +
    (head ? ' fired=' + head : '') + (res.forceFull ? ' fullReparse' : '') + ' elapsed=' + res.elapsedMs.toFixed(1) + 'ms')
}

function sleep(ms, isStopped) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (isStopped() || Date.now() - t0 >= ms) return resolve()
      setTimeout(tick, Math.max(10, Math.min(250, ms - (Date.now() - t0))))
    }
    if (ms <= 0) return resolve()
    tick()
  })
}

// 常驻循环。默认静默：只有越阈值才打印 ALERT 行；--verbose 才打每轮耗时。
export async function runLoop(monitor, opts = {}) {
  const intervalMs = opts.intervalMs ?? monitor.opts.intervalMs
  const maxRounds = opts.maxRounds ?? Infinity
  const verbose = opts.verbose === true
  const quiet = opts.quiet === true || !verbose
  let stopped = false
  const isStopped = () => stopped
  const stop = () => { stopped = true }
  const onSig = () => { stop() }
  let sigAttached = false
  if (!opts.noSignals) {
    process.on('SIGINT', onSig)
    process.on('SIGTERM', onSig)
    sigAttached = true
  }
  let round = 0
  try {
    while (!stopped && round < maxRounds) {
      round++
      const res = monitor.scanOnce()
      if (!quiet) {
        console.log('[ctx-monitor] round=' + round + ' scanned=' + res.scanned + ' inScope=' + res.rows.length +
          ' outOfScope=' + res.outOfScope + ' reparsed=' + res.reparsed + ' cached=' + res.cached +
          ' skipped=' + res.skipped + '(无压采=' + res.skippedNoSample + ',数值异常=' + res.skippedBadValue + ')' +
          ' errors=' + res.errors + ' alerts=' + res.alerts +
          (res.forceFull ? ' fullReparse' : '') + ' elapsed=' + res.elapsedMs.toFixed(1) + 'ms')
      }
      // 只有越阈值才输出（正常轮询不打印）
      for (const sid of res.fired || []) {
        const r = res.rows.find((x) => x.sessionId === sid)
        console.log('[ctx-monitor] ALERT ' + sessionLine(r))
      }
      if (opts.onRound) {
        const v = opts.onRound(res)
        if (v === false) stop()
      }
      if (stopped || round >= maxRounds) break
      await sleep(intervalMs, isStopped)
    }
  } finally {
    if (sigAttached) {
      process.removeListener('SIGINT', onSig)
      process.removeListener('SIGTERM', onSig)
    }
  }
  if (verbose) console.log('[ctx-monitor] stop rounds=' + round + ' cache=' + monitor.cacheSize() + ' state=' + monitor.stateSize())
  return { rounds: round, stopped }
}

// --daemon：pid 文件占坑（防双实例）+ 稳定长跑；退出时清 pid 文件
export async function runDaemon(monitor, opts = {}) {
  const pidFile = opts.pidFile ?? monitor.opts.pidFile
  const got = acquirePidFile(pidFile)
  if (!got.ok) {
    if (got.error) console.error('[ctx-monitor] pid 文件写不了：' + got.error + '（' + pidFile + '）')
    else console.error('[ctx-monitor] 已有实例在跑（pid=' + got.pid + '，pid 文件 ' + pidFile + '），本次退出')
    return { rounds: 0, stopped: true, pidConflict: true }
  }
  const cleanup = () => { try { releasePidFile(pidFile) } catch {} }
  process.on('exit', cleanup)
  try {
    return await runLoop(monitor, { ...opts, quiet: opts.quiet, verbose: opts.verbose })
  } finally {
    cleanup()
    process.removeListener('exit', cleanup)
  }
}

// ---- 参数 ---------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { once: false, json: false, dryRun: false, help: false, unknown: [] }
  for (const a of argv) {
    if (a === '--once') o.once = true
    else if (a === '--json') o.json = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--no-ingress') o.ingress = false
    else if (a === '--verbose' || a === '-v') o.verbose = true
    else if (a === '--daemon') o.daemon = true
    else if (a === '--help' || a === '-h') o.help = true
    else if (a.startsWith('--session-line=')) o.sessionLine = a.slice('--session-line='.length)
    else if (a.startsWith('--root=')) o.root = a.slice('--root='.length)
    else if (a.startsWith('--dir=')) o.dir = a.slice('--dir='.length)
    // sa-198：新增参数（命令行只作临时覆盖；常驻时参数热读 settings.json 的 ctxMonitor）
    else if (a.startsWith('--settings=')) o.settingsFile = a.slice('--settings='.length)
    else if (a.startsWith('--data-dir=')) o.dataDir = a.slice('--data-dir='.length)
    else if (a.startsWith('--owner-session=')) o.ownerSession = a.slice('--owner-session='.length)
    else if (a.startsWith('--pid-file=')) o.pidFile = a.slice('--pid-file='.length)
    else if (a.startsWith('--alerts-log=')) o.alertsLog = a.slice('--alerts-log='.length)
    else if (a.startsWith('--ingress=')) o.ingressFile = a.slice('--ingress='.length)
    else if (a.startsWith('--interval=')) o.intervalMs = Number(a.slice('--interval='.length))
    else if (a.startsWith('--cooldown-min=')) o.cooldownMin = Number(a.slice('--cooldown-min='.length))
    else if (a.startsWith('--threshold-ds=')) o.thresholdDs = Number(a.slice('--threshold-ds='.length))
    else if (a.startsWith('--threshold-other=')) o.thresholdOther = Number(a.slice('--threshold-other='.length))
    else if (a.startsWith('--hysteresis=')) o.hysteresis = Number(a.slice('--hysteresis='.length))
    else if (a.startsWith('--full-reparse-every=')) o.fullReparseEvery = Number(a.slice('--full-reparse-every='.length))
    else if (a.startsWith('--rotate-bytes=')) o.rotateBytes = Number(a.slice('--rotate-bytes='.length))
    else if (a.startsWith('--brief=')) o.brief = a.slice('--brief='.length)
    else if (a.startsWith('--drop-pts=')) o.dropPts = Number(a.slice('--drop-pts='.length))
    else if (a.startsWith('--drop-min-prev=')) o.dropMinPrevPct = Number(a.slice('--drop-min-prev='.length))
    else o.unknown.push(a)
  }
  for (const k of ['intervalMs', 'cooldownMin', 'thresholdDs', 'thresholdOther', 'hysteresis', 'fullReparseEvery', 'rotateBytes', 'dropPts', 'dropMinPrevPct']) {
    if (o[k] != null && !Number.isFinite(o[k])) throw new Error('参数 ' + k + ' 不是数字')
  }
  return o
}

const HELP = [
  'ctx-monitor — 会话上下文占用监测（只读，不注入任何会话）',
  '',
  '  node ctx-monitor.mjs [--once] [--json] [--dry-run] [--verbose] [--daemon] [--session-line=<sessionId>]',
  '                       [--root=<目录>] [--dir=<projcache 目录>] [--data-dir=<数据目录>]',
  '                       [--settings=<settings.json>] [--owner-session=<sid>] [--pid-file=<文件>]',
  '                       [--interval=<ms>] [--cooldown-min=<分>] [--threshold-ds=<%>] [--threshold-other=<%>]',
  '                       [--hysteresis=<%>] [--full-reparse-every=<轮>] [--rotate-bytes=<字节>]',
  '                       [--alerts-log=<文件>] [--ingress=<文件>] [--no-ingress]',
  '                       [--brief=judge|worker|owner] [--drop-pts=<%>] [--drop-min-prev=<%>]',
  '',
  '  --brief：只打「压缩后自检简报」的角色化文本（judge 版写明：已 done 的工单证据可置信、摘要不可信）；',
  '  --drop-pts：两轮之间 pct 回落多少个百分点算「被压缩」（默认 15，配合 --drop-min-prev 默认 30 防误报）。',
  '',
  '默认：root=环境变量 DSH_CTX_ROOT（否则当前目录）；数据落在 --data-dir（默认 包根/ctx-monitor-data）；',
  '      阈值 官方 DS(provider=deepseek-account)>65% / 其余>85%；',
  '      **每轮热读 settings.json 的 ctxMonitor**（intervalSec/thresholds/alertIngress 改了下一轮即生效）；',
  '      冷却 30 分钟、迟滞 5%；正常轮询静默，只在越阈值时输出；ctx-alerts.log 超 1MB 轮转 .1。',
].join('\n')

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (e) {
    console.error('[ctx-monitor] ' + e.message); process.exitCode = 2; return
  }
  if (args.help) { console.log(HELP); return }
  if (args.unknown.length) {
    console.error('[ctx-monitor] 不认识的参数：' + args.unknown.join(' ') + '\n\n' + HELP)
    process.exitCode = 2
    return
  }

  // --brief：只读查询，只打压缩后自检简报（角色化），不扫描、不写文件
  if (args.brief) {
    console.log(compactBrief(args.brief))
    return
  }

  // --session-line：只读查询，只打一行（dryRun 保证不写任何文件）
  if (args.sessionLine) {
    const monitor = createMonitor({ ...args, dryRun: true })
    const res = monitor.scanOnce()
    const want = String(args.sessionLine)
    const rec = res.rows.find((r) => r.sessionId === want || r.sessionId === 'session-' + want || r.sessionId.endsWith(want)) ||
                res.rows.find((r) => r.sessionId.replace(/^session-/, '') === want.replace(/^session-/, ''))
    if (!rec) {
      console.error('[ctx-monitor] 找不到会话 ' + want + '（可能没压采、或 cwd 不在 ' + res.root + ' 下）')
      process.exitCode = 1
      return
    }
    console.log(sessionLine(rec))
    return
  }

  const monitor = createMonitor(args)
  if (args.once) {
    const res = monitor.scanOnce()
    printOnce(res, { json: args.json })
    process.exitCode = res.error ? 1 : 0
    return
  }
  if (args.daemon) {
    const r = await runDaemon(monitor, { intervalMs: monitor.opts.intervalMs, verbose: args.verbose, pidFile: monitor.opts.pidFile })
    if (r.pidConflict) process.exitCode = 1
    return
  }
  await runLoop(monitor, { intervalMs: monitor.opts.intervalMs, verbose: args.verbose })
}

// 只有「被 node 直接跑」时才进 main；被测试 import 时什么都不做
const ENTRY = (() => {
  try {
    if (!process.argv[1]) return false
    const self = realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
    return realpathSync(process.argv[1]).toLowerCase() === self
  } catch { return false }
})()

if (ENTRY) {
  main().then(() => {}).catch((e) => {
    console.error('[ctx-monitor] 未捕获异常：' + (e && e.stack || e))
    process.exitCode = 1
  })
}
