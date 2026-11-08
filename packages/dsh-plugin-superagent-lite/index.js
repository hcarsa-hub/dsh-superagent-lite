/* ============================================================
 * 注释切片 # 1 / 4  —— 源文件 handoff/dist/dsh-plugin-superagent-lite/index.js
 * 原始行号：1 – 846（846 行）
 * 任务：本文件内只新增「整行注释」，不改任何代码字符。整行注释 = 以双斜杠开头的整行，
 *       或独立成块的星号注释（首行仅含斜杠星号、末行仅含星号斜杠）。行内尾注也算，但别改代码本身。
 * 禁碰：handoff/annotate/slices（原始副本）｜handoff/dist（在跑的代码）｜~/.dsh（宿主配置）
 * 自检：node handoff/annotate/verify-slice.mjs 1   → 末行必须是 SLICE 1: PASS
 * ============================================================ */
/**
 * superagent-lite —— DSH 原生插件（lite30：A 死孩子不污染派单池 / B tick 不整档回写 / C tell 失败退回重派 / D report 空 sid 拒绝 / E childId 缺失中止）
 *
 * 状态机：queued → running → ready → done；任意态可 → blocked。
 * 投递：进入 ready 时把 outbox 写进 state（key = ticketId:revision）；
 *       tick 里逐条投递，成功才标 sentAt；重启后未 sent 的继续投。
 * 约束：不碰 hooks.json / sessions / 私密区；schedule 不可用时只积压不丢。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, copyFileSync, cpSync, statSync, renameSync, unlinkSync, realpathSync, openSync, fstatSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// 深冻结：给宿主 Agent 投递的 UserMessage 必须是不可变的（与宿主 createMessage 行为一致）。
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}

export const name = 'superagent-lite'
export const inject = ['tools', 'subagents']

// One queue per module instance. Keep callbacks synchronous; never nest this lock.
// 串行闸：所有「读 state → 改 → 写 state」的临界区都从这里排队，防止并发写互相覆盖。
// 约束：fn 必须是同步的（返回 Promise 会被 tail 立刻释放，锁就白拿了）；严禁在 fn 里再调 runExclusive，
// 会自锁成死循环。结果里的 rejection 只回给本次调用者，tail 本身永远 resolve，否则一次失败把后续全堵死。
let exclusiveTail = Promise.resolve()
function runExclusive(fn) {
  const result = exclusiveTail.then(fn)
  // Recover the tail while preserving rejection for this caller.
  exclusiveTail = result.then(() => undefined, () => undefined)
  return result
}

// 默认状态目录落在 ~/.dsh/subagent：插件卸载后工单还在。测试/多实例时用 stateDir 换目录，
// 否则两个实例抢同一份 state.json（不是崩溃，是静默互相覆盖）。
const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'subagent')
const STATES = ['queued', 'running', 'ready', 'done', 'blocked']
// 2026-11-05 用户定案 A：blocked 允许 → queued（重排）与 → done（人工收口），不再是终态
// 状态迁移白名单：不在表里的迁移一律判 illegal 拒绝（advance 里查 NEXT[t.state]）。
// done 是唯一没有出边的终态；想重开旧单只能 restore（从归档读回来），不许直接改状态。
const NEXT = { queued: ['running', 'blocked'], running: ['ready', 'blocked'], ready: ['done', 'blocked'], done: [], blocked: ['queued', 'done'] }

// #59（lite36）：敏感路径在任意允许根内都拒绝，真实路径用于识别链接目标。
// 命中即拒，没有白名单例外：路径先经 realOrResolve 取真实路径，符号链接/大小写都能认出。
// 宁可误挡也不放行 —— 一次泄露就够致命；AppData\Roaming 专挡浏览器与宿主配置目录。
const ATTACH_DENY = [/[\\/]\.ssh[\\/]/i, /[\\/]\.gnupg[\\/]/i, /[\\/]\.codex[\\/]/i, /[\\/]\.dsh[\\/]/i, /[\\/]\.aws[\\/]/i, /(^|[\\/])id_rsa/i, /(^|[\\/])id_ed25519/i, /\.pem$/i, /\.pfx$/i, /\.p12$/i, /(^|[\\/])auth\.json$/i, /(^|[\\/])credentials?\.json$/i, /(^|[\\/])\.env(\.|$)/i, /(^|[\\/])AppData[\\/]Roaming[\\/]/i]

// 取真实路径（解软链）；文件不存在返回 null。调用方必须把 null 当「拒绝」处理，不能当放行。
function realOrResolve(p) {
  try { return realpathSync(p) } catch { return null }
}

function emptyState() {
  return { version: 2, seq: 0, tickets: [], outbox: [] }
}

// 纯函数放模块顶层：service 作用域与 apply（工具）作用域都要用，放里面就会出现「工具里 is not defined」
// lite42：工单号按「纪元」滚动 —— sa-001…sa-999 → s1-001…s1-999 → s2-…；换纪元时旧单归档
// 999 = 纪元容量：满 1000 换前缀 s1-、s2-…，同时把旧纪元的已收口单归档，state.json 才不会无限变长。
// 改这个数会让已有 id 的解析位置漂移（sa-500 可能变成另一个序号），除非同时迁移全部工单，否则别动。
const EPOCH_SIZE = 999
const prefixFor = (seq) => {
  // B9（2026-11-07）：每份新 state 第一次 submit 会拿 seq-1 = 0 来比纪元；旧实现算出
  // Math.floor(-1/999) = -1 → 's-1'，与 'sa' 不等 → 首单误触一次 epoch rotate（archiveInto all:true）。
  // 现状虽无害，但该分支一旦加副作用就会误清数据。这里把 seq<1 归一成 1，首单不再跨纪元。
  const ep = Math.floor((Math.max(1, seq) - 1) / EPOCH_SIZE)
  return ep === 0 ? 'sa' : 's' + ep
}
const idFor = (seq) => prefixFor(seq) + '-' + String(((seq - 1) % EPOCH_SIZE) + 1).padStart(3, '0')
// 宽松校验：只认「前缀 + 数字」，不校验 1..999 区间 —— 老 id 与手写序号照样能读。
const ID_RE = /^(?:sa|s\d+)-\d+$/

// lite43：工单类型（面板筛选用）—— test / code / office（办公文档/表格/演示/图片编辑这类轻活）
// 显式 type 优先；没给就按标题关键词猜；都不中默认 code。
// 猜词顺序有讲究：先 test（测试标题也常带「文档/表格」字样），再 office，最后 code。
const TICKET_TYPES = ['test', 'code', 'office', 'doc']
const inferType = (raw, title) => {
  const t = String(raw || '').toLowerCase()
  if (TICKET_TYPES.includes(t)) return t
  const s = String(title || '')
  if (/测试|冒烟|验收|回归|test|verify|smoke/i.test(s)) return 'test'
  if (/excel|word|ppt|表格|文档|演示|海报|图片|修图|office|docx|pptx|xlsx/i.test(s)) return 'office'
  return 'code'
}

const NL = String.fromCharCode(10)
// 会话 id 只留头 10 + 尾 6：日志与投递提示里到处出现，全长 uuid 会把一行撑爆。
// 22 是「已经足够区分、又不至于截断」的折中阈值。
const shortSid = (s) => { const v = String(s || ''); return v ? (v.length > 22 ? v.slice(0, 10) + '…' + v.slice(-6) : v) : '(none)' }
const isPendingOutbox = (o) => !o.sentAt && !o.abandonedAt && !o.canceledAt
// blocked 时把该单还没投出去的 outbox 全标 canceledAt：否则 tick 还会把「请验收」的旧提示发出去，
// 让 owner 收到一张已经被 block 的单。sentAt 的不动 —— 已投过的是历史，留着。
const cancelPendingOutbox = (s, ticketId, at) => {
  for (const o of s.outbox) {
    if (o.ticketId === ticketId && isPendingOutbox(o)) o.canceledAt = at
  }
}
// 判词截 200 字（按码点切，防止 emoji 被劈成半个）：投递提示本身还要塞工单标题与要求，
// 不截断会让一条对话消息超长。空 verdict 返回空串，让调用方能干净地拼接。
const judgeSummary = (t) => {
  const v = t.verdict
  if (!v) return ''
  const chars = Array.from(String(v.reason || ''))
  const excerpt = chars.slice(0, 200).join('') + (chars.length > 200 ? '…' : '')
  return NL + 'judge 判词（' + (v.pass === true ? '通过' : '不通过') + '）：' + excerpt + '（by ' + shortSid(v.by) + '）'
}

// #60（lite36）：默认保留窗口和容量，允许宿主浅合并覆盖。
// 默认裁剪口径：outbox 500 条/7 天、abandoned 3 天、history 100、artifact 200、report 50。
// 这些值决定 state.json 的稳态体积；调大意味着每次 load/save 的 JSON 解析变慢。
const DEFAULT_PRUNE_CAPS = { outboxMax: 500, outboxKeepDays: 7, abandonedKeepDays: 3, historyMax: 100, artifactMax: 200, reportMax: 50 }

// #60（lite36）：五元组中位数选出第 k 个时间，最坏 O(n)，仅排序至多五项的小组。
// 五元组中位数 + 递归选择：只为在 outbox 超限时找出「第 k 小的时间」当截断点，不排序全部。
// 返回值语义是「前 k 个会被删」；不整体排序是因为工单多时 outbox 可能上千条。
function selectPruneTime(times, k) {
  if (times.length <= 5) return times.sort((a, b) => a - b)[k]
  const medians = []
  for (let i = 0; i < times.length; i += 5) {
    const group = times.slice(i, i + 5).sort((a, b) => a - b)
    medians.push(group[Math.floor(group.length / 2)])
  }
  const pivot = selectPruneTime(medians, Math.floor(medians.length / 2))
  const lower = []
  const upper = []
  let equal = 0
  for (const time of times) {
    if (time < pivot) lower.push(time)
    else if (time > pivot) upper.push(time)
    else equal++
  }
  if (k < lower.length) return selectPruneTime(lower, k)
  if (k < lower.length + equal) return pivot
  return selectPruneTime(upper, k - lower.length - equal)
}

// #60（lite36）：只原地裁剪传入状态，无读写盘或日志副作用；可注入时钟复现期限边界。
// 就地裁剪 state：调用方必须已经独占 s（正常路径是 save 里同步调用），别在锁外跑。
// now 可注入是为了复现「7 天前送达」的期限边界；hooks.spillArtifacts 失败时整条 artifact 清单保留。
export function pruneState(s, caps = {}, now = () => Date.now(), hooks = null) {
  const limits = { ...DEFAULT_PRUNE_CAPS, ...caps }
  for (const key of Object.keys(DEFAULT_PRUNE_CAPS)) {
    if (!Number.isFinite(limits[key]) || limits[key] < 0) limits[key] = DEFAULT_PRUNE_CAPS[key]
    if (key.endsWith('Max')) limits[key] = Math.floor(limits[key])
  }
  // 四类计数用返回值的形式给出来：save 只拿它决定要不要写一行 prune 日志，不影响落盘内容。
  const pruned = { outbox: 0, history: 0, artifacts: 0, reports: 0 }
  const tNow = now()
  const expired = (at, days) => {
    const time = Date.parse(at)
    return Number.isFinite(time) && tNow - time > days * 86400000
  }
  const outbox = s.outbox
  let kept = 0
  for (const o of outbox) {
    if ((o.abandonedAt && expired(o.abandonedAt, limits.abandonedKeepDays)) ||
        (o.canceledAt && expired(o.canceledAt, limits.abandonedKeepDays)) ||
        (o.sentAt && expired(o.sentAt, limits.outboxKeepDays))) {
      pruned.outbox++
    } else {
      outbox[kept++] = o
    }
  }
  if (pruned.outbox) outbox.length = kept
  // 超限后按 sentAt 从小到大裁 —— 只有「已送达」的才可丢，坏日期（NaN）不进 times，保守留着。
  // 相等时间用 equal 计数逐条消化，保证恰好删 remove 条，而不是把同一毫秒里的一片全删掉。
  if (outbox.length > limits.outboxMax) {
    // #60（lite36）：仅在超限时收集已发送的有效时间；坏日期和未发送项保守保留。
    const times = []
    for (const o of outbox) {
      if (o.sentAt && Number.isFinite(Date.parse(o.sentAt))) times.push(Date.parse(o.sentAt))
    }
    const remove = Math.min(outbox.length - limits.outboxMax, times.length)
    if (remove) {
      const cutoff = selectPruneTime(times, remove - 1)
      let equal = remove
      for (const time of times) if (time < cutoff) equal--
      kept = 0
      for (const o of outbox) {
        const time = o.sentAt ? Date.parse(o.sentAt) : NaN
        if (time < cutoff || (time === cutoff && equal-- > 0)) pruned.outbox++
        else outbox[kept++] = o
      }
      outbox.length = kept
    }
  }
  for (const t of s.tickets) {
    for (const [field, max] of [['history', limits.historyMax], ['artifacts', limits.artifactMax], ['reports', limits.reportMax]]) {
      if (!Array.isArray(t[field]) || t[field].length <= max) continue
      // #63（lite48）：被裁掉的证据清单条目不许凭空消失 —— 先落 sidecar 再裁
      if (field === 'artifacts' && hooks && typeof hooks.spillArtifacts === 'function') {
        const dropped = max ? t[field].slice(0, t[field].length - max) : t[field].slice()
        try { hooks.spillArtifacts(t, dropped) } catch (e) {
          if (typeof hooks.log === 'function') hooks.log('prune spill artifacts failed ' + t.id + ' ' + (e && e.message ? e.message : String(e)))
          continue // Keep the original artifacts until the sidecar is committed.
        }
      }
      pruned[field] += t[field].length - max
      t[field] = max ? t[field].slice(-max) : []
    }
  }
  return pruned
}

// 内核主体：所有能力都收在这个闭包里，参数是宿主 config 的投影。
// 除 mkdir 外这里不做 IO，真正的读写在 load/save；deliver/alert/notify 是注入的副作用口子，
// 允许 null 就是为了测试时换成假函数 —— 改签名会影响所有调用点，加参数一律放尾部或走 config。
export function createService({ stateDir, log = () => {}, deliver = null, now = () => Date.now(), queueDir = '', inboxFile = '', alert = null, policy = null, concurrency = null, defaultSessionId = '', onTicketDone = null, ingressFile: ingressFilePath = '', notifyCodexReady = false, attachRoots, attachMaxBytes, pruneCaps, autoDispatchEnabled = false, autoDispatchMsDefault = 15000, readyOwnerNotify = null, verdictOwnerNotify = null, quietSources = [], deliverOut = null, maxAutoRework = 1, dispatchStaleMin = 15 }) {
  // #60（lite36）：所有保存共用浅合并后的裁剪配置。
  const caps = { ...DEFAULT_PRUNE_CAPS, ...pruneCaps }
  // lite46：面板「设置」页可改的运行时参数（settings.json，mtime 热读，无需重启）
  const settingsFile = join(stateDir, 'settings.json')
  let settingsCache = { at: -1, value: {} }
  // settings 热读：靠 mtimeMs 判断变没变，变了才重新 parse，没变直接返回缓存对象。
  // 返回值被多处共享，调用方不许原地修改它 —— 要改就写 settings.json，否则缓存与盘上会不一致。
  const readSettings = () => {
    let st = null
    try { st = statSync(settingsFile) } catch { return {} }
    if (settingsCache.at === st.mtimeMs) return settingsCache.value
    let v = {}
    try { v = JSON.parse(readFileSync(settingsFile, 'utf8')) } catch { v = {} }
    settingsCache = { at: st.mtimeMs, value: v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
    return settingsCache.value
  }
  // 每次现算生效参数 = 默认值 ← settings.json ← 合法性过滤。非法/越界一律回落默认，
  // 这样面板写进一个脏数字也不会让服务起不来（例如 runningTimeoutMs 写 0 会被顶回默认）。
  const eff = () => {
    const s = readSettings()
    const num = (k, d, min) => { const v = Number(s[k]); return Number.isFinite(v) && v >= (min == null ? 0 : min) ? v : d }
    const rawPrune = s.pruneCaps && typeof s.pruneCaps === 'object' ? s.pruneCaps : {}
    const prune = { ...caps }
    for (const k of Object.keys(DEFAULT_PRUNE_CAPS)) { const v = Number(rawPrune[k]); if (Number.isFinite(v) && v >= 0) prune[k] = v }
    return {
      runningTimeoutMs: num('runningTimeoutMs', POLICY.runningTimeoutMs, 1000),
      // sa-207：连续多少次「updatedAt 没变化」才判 timeout（settings 优先 → policy.config → 默认 2）
      staleMisses: Math.max(1, Math.floor(num('staleMisses', POLICY.staleMisses || 2, 1))),
      maxDeliverAttempts: num('maxDeliverAttempts', POLICY.maxDeliverAttempts, 1),
      attachMaxBytes: num('attachMaxBytes', Number((cfg && cfg.attachMaxBytes) || 8 * 1024 * 1024), 1024),
      watchdogAlerts: s.watchdogAlerts === undefined ? true : s.watchdogAlerts !== false,
      autoDispatch: s.autoDispatch === undefined ? autoDispatchEnabled === true : s.autoDispatch !== false,
      autoDispatchMs: num('autoDispatchMs', Number(autoDispatchMsDefault || 15000), 1000),
      errorEvidence: s.errorEvidence !== false,
      pruneCaps: prune,
    }
  }
  // #59（lite36）：接收宿主配置，直接创建 service 的调用也使用同一套边界。
  const cfg = { attachRoots, attachMaxBytes }
  // N5：工单归属会话。空串 = 没配置，投递时会显式报 no-session，不静默丢
  const DEFAULT_SESSION = String(defaultSessionId || '')
  // N5：兜底会话 = 配置默认 → 最近一次有会话的调用/事件。这样 profile 配置里不需要硬编码 sessionId
  const fallbackSession = () => DEFAULT_SESSION || (load().lastCallerSession || '')
  const noteCaller = (s, sid) => { if (sid) s.lastCallerSession = sid }
  // N2 并发与优先级（可由 profile config.concurrency 覆盖）
  const CONC = {
    maxConcurrent: (concurrency && concurrency.maxConcurrent) || 1,
    defaultPriority: (concurrency && concurrency.defaultPriority) || 5,
  }
  const clampPriority = (p) => {
    const n = Number(p)
    if (!Number.isFinite(n)) return CONC.defaultPriority
    return Math.max(1, Math.min(9, Math.round(n)))
  }
  // N3 失败策略参数（可由 profile config.policy 覆盖）
  // N5.2：外部事件建单后是否通知待派单（默认开）
  const NOTIFY_DISPATCH = !(policy && policy.notifyDispatch === false)
  // sa-195 B：静默来源（命中则不写 dispatch-needed、不叫醒 owner；judge 通知/verdict 提醒/watchdog 仍保留）
  const QUIET_SOURCES = new Set((Array.isArray(quietSources) ? quietSources : []).map(String).filter(Boolean))
  // sa-202：judge fail 自动复活上限 / queued 积压阈值（可由 config/settings 覆盖；createService 直构时用入参）
  const maxAutoReworkOpt = maxAutoRework
  const dispatchStaleMinOpt = dispatchStaleMin
  // 策略默认：runningTimeoutMs 从 5 分钟放宽到 20 分钟 —— 长回合改代码期间 updatedAt 不刷新，
  // 5 分钟会把好好干活的单误判成超时。staleMisses=2 配合 sa_progress 心跳，连续 2 次才 block。
  const POLICY = {
    // sa-207 B：默认 5 分钟 → 20 分钟（长回合改代码不刷新 updatedAt，10 分钟会误杀）
    runningTimeoutMs: (policy && policy.runningTimeoutMs) || 20 * 60 * 1000,
    staleMisses: (policy && policy.staleMisses) || 2,
    maxDeliverAttempts: (policy && policy.maxDeliverAttempts) || 30,
    maxRunAttempts: (policy && policy.maxRunAttempts) || 3,
  }
  mkdirSync(stateDir, { recursive: true })
  const stateFile = join(stateDir, 'state.json')
  const stateBackupFile = stateFile + '.bak'
  // 原子写：先写同目录临时文件再 rename，避免进程被杀时留下半截 JSON。
  // 失败必须清掉临时文件，否则 state 目录会攒一堆 .tmp（Windows 上 rename 覆盖还要求目标可替换）。
  const writeJsonAtomic = (file, value) => {
    const tempFile = file + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(tempFile, JSON.stringify(value, null, 1), 'utf8')
      renameSync(tempFile, file)
    } catch (error) {
      try { unlinkSync(tempFile) } catch {}
      throw error
    }
  }
  // 结构校验只认 tickets/outbox 两个数组：parse 成功但结构不对（比如被写成 {}）当 INVALID_STATE，
  // 走隔离 + 备份恢复流程，而不是让后续代码在「半坏状态」上继续跑。
  const readStateFile = (file) => {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    if (s && Array.isArray(s.tickets) && Array.isArray(s.outbox)) return s
    const error = new Error('Invalid state file: tickets and outbox must be arrays: ' + file)
    error.code = 'INVALID_STATE'
    throw error
  }
  // queue/ 与 inbox/ 默认放在 stateDir 的上一级：它们是宿主与插件共享的投递通道，不属于某份 state。
  // ingressFile 与 inboxFile 都允许显式覆盖，便于把插件指向已有的 handoff 目录。
  const eventsFile = join(queueDir || join(stateDir, '..', 'queue'), 'events.jsonl')
  const ingressFile = ingressFilePath || join(stateDir, 'ingress.jsonl')
  const inbox = inboxFile || join(stateDir, '..', 'inbox', 'latest.md')
  // lite41：面板写命令文件、lite 在 tick 里安全执行（避免两边同时写 state.json）
  const commandsDir = join(stateDir, 'commands')
  try { mkdirSync(commandsDir, { recursive: true }) } catch {}
  const archiveDir = join(stateDir, 'archive')
  try { mkdirSync(archiveDir, { recursive: true }) } catch {}
  const archiveTicketsDir = join(archiveDir, 'tickets')
  const archiveStamp = (time) => {
    const d = new Date(time)
    const pad = (n) => String(n).padStart(2, '0')
    // B10（2026-11-07）：原来只到分钟，同一分钟内两次归档快照同名 → writeJsonAtomic 直接覆盖，
    // 前一份快照静默丢失。加秒后同分钟内也唯一（文件名格式变长 2 位，测试断言需同步）。
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  }
  const archiveJsonNames = (dir) => {
    try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && /\.json$/i.test(d.name)).map((d) => d.name).sort() }
    catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  const writeArchiveText = (file, text) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(tmp, text, 'utf8'); renameSync(tmp, file) }
    catch (e) { try { unlinkSync(tmp) } catch {}; throw e }
  }
  // 旧布局（archive/*.json）一次性搬进 archive/tickets/，带上 mtime 戳防重名。
  // 只要 tickets/ 里已有任何一个文件就直接返回 —— 幂等靠这个判断，重复调用不会二次搬。
  const migrateArchive = () => {
    if (archiveJsonNames(archiveTicketsDir).length) return
    const oldNames = archiveJsonNames(archiveDir)
    if (!oldNames.length) return
    mkdirSync(archiveTicketsDir, { recursive: true })
    for (const name of oldNames) {
      const from = join(archiveDir, name)
      let to = join(archiveTicketsDir, name.replace(/\.json$/i, '') + '-' + archiveStamp(statSync(from).mtimeMs) + '.json')
    for (let dup = 2; existsSync(to); dup++) to = join(archiveTicketsDir, name.replace(/\.json$/i, '') + '-' + archiveStamp(statSync(from).mtimeMs) + '-' + dup + '.json')
      const tmp = to + '.' + randomUUID() + '.tmp'
      try { copyFileSync(from, tmp); renameSync(tmp, to) }
      catch (e) { try { unlinkSync(tmp) } catch {}; throw e }
      log('archive migrate ' + name)
    }
  }
  // 把该单名下的交接类文件聚成 archive/handoff/<id>.md，归档后仍能查到「当时怎么验的」。
  // 只匹配 verify/handoff/note 三类文件名；源文件只读不搬，keepSource 决定后面是复制还是移动。
  const archiveHandoff = (id) => {
    const records = new Map()
    let keepSource = false
    const walk = (root, rel = '', current = false) => {
      const dir = join(root, rel)
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(rel, entry.name)
        if (entry.isDirectory()) walk(root, path, current)
        else if (entry.isFile() && /verify|handoff|note/i.test(entry.name)) {
          records.set(path, readFileSync(join(root, path), 'utf8'))
          if (current) keepSource = true
        }
      }
    }
    // 同名源文件以当前 evidence 为准；只读文件，不移动或删除交接源。
    walk(join(archiveDir, 'evidence', id))
    walk(join(stateDir, 'evidence', id), '', true)
    if (records.size) {
      const body = [...records].map(([name, text]) => '## ' + name + '\n\n' + text).join('\n\n')
      writeArchiveText(join(archiveDir, 'handoff', id + '.md'), '# ' + id + ' 交接记录\n\n' + body + '\n')
    }
    return keepSource
  }

  // 保留兼容文件，附加本地分钟时间戳的完整前缀批次快照。
  // 归档主流程。参数语义：keep=N 保留最近 N 张已收口单；before=ISO 只归档更早的；ids 精确点名；
  // all=true 才允许「什么都不给」时全收。三者都不给 → 直接返回 0，防止误调用把 state 清空。
  // dryRun 只算 targets 不落盘；真归档先写快照再写增量，最后才从 state 里摘掉工单。
  const archiveInto = (s, opts) => {
    const o = opts || {}
    const keep = Math.max(0, Number(o.keep == null ? 0 : o.keep))
    const before = o.before ? Date.parse(o.before) : null
    const eligible = (s.tickets || []).filter((t) => t.state === 'done' || t.state === 'blocked')
    const onlyIds = Array.isArray(o.ids) ? new Set(o.ids.map(String)) : null
    let targets = onlyIds ? eligible.filter((t) => onlyIds.has(String(t.id))) : eligible
    if (keep > 0) {
      const sorted = eligible.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      const keepIds = new Set(sorted.slice(0, keep).map((t) => t.id))
      targets = eligible.filter((t) => !keepIds.has(t.id))
    }
    if (Number.isFinite(before)) targets = targets.filter((t) => Date.parse(t.updatedAt || t.createdAt) < before)
    if (o.all !== true && keep === 0 && !Number.isFinite(before) && !onlyIds) targets = []
    if (!targets.length) return { archived: 0, files: [] }
    const byPrefix = {}
    for (const t of targets) {
      const p = String(t.id).split('-')[0]
      ;(byPrefix[p] = byPrefix[p] || []).push(t)
    }
    const files = []
    if (!o.dryRun) {
      migrateArchive()
      mkdirSync(archiveTicketsDir, { recursive: true })
      const time = now()
      for (const p of Object.keys(byPrefix)) {
        const file = join(archiveDir, p + '.json')
        let cur = { prefix: p, updatedAt: null, count: 0, tickets: [] }
        try { cur = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
          if (e.code !== 'ENOENT') { log('archive read failed ' + file + ' ' + e.message); throw e }
        }
        const batch = new Map((Array.isArray(cur.tickets) ? cur.tickets : []).map((t) => [String(t.id), t]))
        for (const t of byPrefix[p]) batch.set(String(t.id), t)
        cur.tickets = [...batch.values()]
        cur.count = cur.tickets.length
        cur.updatedAt = iso(time)
        for (const t of byPrefix[p]) {
          const id = String(t.id)
          if (t.verdict) {
            const v = t.verdict
            writeArchiveText(join(archiveDir, 'verdicts', id + '.md'), '# ' + id + ' judge 判词\n- 结论：' + (v.pass === true ? '通过' : '不通过') + '\n- 时间：' + String(v.at || '') + '\n- 判者：' + String(v.by || '') + '\n\n## 理由\n' + String(v.reason || '') + '\n')
          }
          const keepEvidence = archiveHandoff(id)
          const fromEv = join(stateDir, 'evidence', id)
          const toEv = join(archiveDir, 'evidence', id)
          if (existsSync(fromEv)) {
            mkdirSync(dirname(toEv), { recursive: true })
            if (keepEvidence || existsSync(toEv)) {
              cpSync(fromEv, toEv, { recursive: true, force: true })
              log('archive copy evidence ' + id)
            } else {
              renameSync(fromEv, toEv)
              log('archive move evidence ' + id)
            }
          }
        }
        // B10（2026-11-07）：加秒还不够——同一秒内连做两次归档仍会撞名覆盖。这里撞名就加 -2/-3 后缀，
    // 归档快照是「事后唯一能取回的东西」，宁可有几个近似名，也不许静默覆盖。
    let snapshot = join(archiveTicketsDir, p + '-' + archiveStamp(time) + '.json')
    for (let dup = 2; existsSync(snapshot); dup++) snapshot = join(archiveTicketsDir, p + '-' + archiveStamp(time) + '-' + dup + '.json')
        writeJsonAtomic(snapshot, cur)
        writeJsonAtomic(file, cur)
        files.push(file, snapshot)
      }
      const ids = new Set(targets.map((t) => t.id))
      s.tickets = (s.tickets || []).filter((t) => !ids.has(t.id))
      if (Array.isArray(s.outbox)) s.outbox = s.outbox.filter((x) => !ids.has(String(x.ticketId || '')))
    }
    return { archived: targets.length, files }
  }

  // 按 id 合并：旧目录先读，tickets 快照按文件名时间升序覆盖。
  // 读归档做恢复：先旧目录文件、再 tickets/ 快照，按文件名时间戳 → mtime → 名字排序，
  // 后读的覆盖先读的，所以同一工单最终取最新快照；坏文件只记日志跳过，不中断整次恢复。
  const readArchive = () => {
    const docs = []
    const tickets = new Map()
    const snapshots = archiveJsonNames(archiveTicketsDir).sort((a, b) => {
      const stamp = (n) => (n.match(/-(\d{8}-\d{4})\.json$/i) || [null, ''])[1]
      return stamp(a).localeCompare(stamp(b)) || statSync(join(archiveTicketsDir, a)).mtimeMs - statSync(join(archiveTicketsDir, b)).mtimeMs || a.localeCompare(b)
    })
    const files = [...archiveJsonNames(archiveDir).map((n) => join(archiveDir, n)), ...snapshots.map((n) => join(archiveTicketsDir, n))]
    for (const file of files) {
      let doc
      try { doc = JSON.parse(readFileSync(file, 'utf8')) }
      catch (e) { log('restore read archive failed ' + file + ' ' + e.message); continue }
      if (!doc || !Array.isArray(doc.tickets)) { log('restore invalid archive ' + file); continue }
      docs.push({ file, doc })
      for (const t of doc.tickets) if (t && t.id) tickets.set(String(t.id), t)
    }
    return { docs, tickets }
  }
  // 恢复成功后从归档里摘掉已经回到 state 的工单：文件空了就删，非空才重写。
  // 不这么做的话，下次 restoreAll 会把同一批单再塞一遍。
  const consumeArchive = (docs, ids) => {
    for (const { file, doc } of docs) {
      const keep = doc.tickets.filter((t) => !t || !ids.has(String(t.id)))
      if (keep.length === doc.tickets.length) continue
      doc.tickets = keep
      doc.count = keep.length
      doc.updatedAt = iso(now())
      if (keep.length) writeJsonAtomic(file, doc)
      else unlinkSync(file)
    }
  }
  // 证据回迁：当前目录缺文件才 rename（省一次复制、归档里不留副本）；同名已存在则 copy 且不覆盖，
  // 保证现在的证据不被旧归档盖掉。整体失败只记日志，不阻断工单恢复。
  const restoreEvidence = (id) => {
    const from = join(archiveDir, 'evidence', id)
    const to = join(stateDir, 'evidence', id)
    try {
      if (existsSync(from)) {
        mkdirSync(dirname(to), { recursive: true })
        // 当前 evidence 的同名文件优先；缺失文件从归档补回。
        if (!existsSync(to)) {
          renameSync(from, to)
          log('restore move evidence ' + id)
        } else {
          cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
          log('restore copy evidence ' + id)
        }
      }
    } catch (e) { log('restore copy evidence failed ' + id + ' ' + e.message) }
  }
  const restoreOneImpl = (s, id) => {
    id = String(id)
    const { docs, tickets } = readArchive()
    const t = tickets.get(id)
    if (!t) return false
    if (!Array.isArray(s.tickets)) s.tickets = []
    if (!s.tickets.some((x) => String(x.id) === id)) s.tickets.push(t)
    save(s, { prune: false })
    restoreEvidence(id)
    consumeArchive(docs, new Set([id]))
    return true
  }
  // 全量恢复：先补 tickets，再 save(prune:false) 避免刚恢复的单被立刻裁剪，最后清空归档里已恢复的部分。
  const restoreAllImpl = (s) => {
    const { docs, tickets } = readArchive()
    if (!tickets.size) return 0
    if (!Array.isArray(s.tickets)) s.tickets = []
    const present = new Set(s.tickets.map((t) => String(t.id)))
    let k = 0
    for (const [id, t] of tickets) {
      if (!present.has(id)) { s.tickets.push(t); present.add(id); k++ }
    }
    save(s, { prune: false })
    for (const id of tickets.keys()) restoreEvidence(id)
    consumeArchive(docs, new Set(tickets.keys()))
    return k
  }

  // 读取 state 的兜底链：正常读 → 坏文件先隔离（改名 state.corrupt-* 留证据）→ 退到 .bak → 才允许空状态。
  // 隔离文件存在时即使读不到也绝不返回空 state：空 state 会被下一次 save 覆盖成真数据丢失；
  // 这就是「只有干净的新目录才能从零开始」这条判断的全部意义，改它会直接吃掉历史工单。
  const load = () => {
    try { return readStateFile(stateFile) } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.code !== 'INVALID_STATE') throw error
      if (error.code !== 'ENOENT') {
        const corruptFile = join(stateDir, 'state.corrupt-' + now() + '-' + randomUUID() + '.json')
        renameSync(stateFile, corruptFile)
        log('state quarantined ' + corruptFile + ' ' + error.message)
      }
      try {
        const s = readStateFile(stateBackupFile)
        writeJsonAtomic(stateFile, s)
        log('state recovered from ' + stateBackupFile)
        return s
      } catch (backupError) {
        // Only a fresh directory may become empty; quarantine must survive retries/restarts.
        if (error.code === 'ENOENT' && backupError.code === 'ENOENT' &&
            !readdirSync(stateDir).some((n) => /^state\.corrupt-.*\.json$/.test(n))) return emptyState()
        log('state recovery failed ' + (backupError && backupError.message ? backupError.message : String(backupError)))
        throw new Error('state recovery failed: ' + error.message + '; backup: ' + backupError.message, { cause: backupError })
      }
    }
  }
  // 落盘顺序：裁剪 → 读旧 state 当备份 → 写 .bak → 写 state。先备份再覆盖，任何时候崩溃都能退回上一份。
  // 恢复流程传 prune:false：刚拼回来的 state 往往是历史数据，按默认策略裁会立刻丢掉一批。
  const save = (s, { prune = true } = {}) => {
    // Restoration skips pruning; normal saves spill before trimming artifacts.
    const pruned = prune ? pruneState(s, eff().pruneCaps, now, { spillArtifacts, log }) : {}
    if (Object.values(pruned).some((n) => n > 0)) {
      log('prune outbox=' + pruned.outbox + ' history=' + pruned.history + ' artifacts=' + pruned.artifacts + ' reports=' + pruned.reports)
    }
    let previous = s
    try { previous = readStateFile(stateFile) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    // Back up the previous valid snapshot before committing the new state.
    writeJsonAtomic(stateBackupFile, previous)
    writeJsonAtomic(stateFile, s)
  }
  let ticking = false
  const iso = (t) => new Date(t).toISOString()

  // ---- M4 watchdog：只读 state.json 与产物文件，只告警，绝不改工单状态 ----
  // watchdog 自己的状态单独存一个文件：它只告警、不改工单状态，所以既不污染 state.json，也不需要事务。
  const watchdogFile = join(stateDir, 'watchdog.json')
  const loadW = () => {
    try {
      const w = JSON.parse(readFileSync(watchdogFile, 'utf8'))
      if (w && typeof w === 'object') { w.alerts = w.alerts || {}; w.findings = w.findings || [] ; return w }
    } catch {}
    return { baselineAt: null, lastRunAt: null, alerts: {}, findings: [] }
  }
  const saveW = (w) => writeFileSync(watchdogFile, JSON.stringify(w, null, 1), 'utf8')
  // baseline 在服务创建时就落盘：dry-run 不再推进基线，避免「历史工单」误跳过新工单
  // baseline 必须尽早落盘：它把「历史问题」和「这一轮新出现的问题」分开。
  // 放在服务创建时做；dry-run 不推进基线 —— 否则一次手工巡检就把积压问题永久认成历史，再也报不出来。
  const ensureBaseline = () => {
    const w = loadW()
    if (!w.baselineAt) { w.baselineAt = iso(now()); saveW(w); log('watchdog baseline=' + w.baselineAt) }
    return w.baselineAt
  }
  // 这几个是内核自己的状态文件：扫「哪些文件属于某单证据」时必须跳过，否则每单都能匹配到 state.json。
  const EVIDENCE_SKIP = new Set(['state.json', 'watchdog.json', 'heartbeat.json'])
  // ---- N4 产物规范：证据一律落 evidence/<工单id>/，清单登记在 ticket.artifacts ----
  const evidenceRoot = join(stateDir, 'evidence')
  const ticketEvidenceDir = (id) => join(evidenceRoot, String(id))
  // #63（lite48）：清单被裁剪时把溢出条目落到 evidence/<id>/manifest-overflow.json（按 rel 去重合并）
  const MANIFEST_OVERFLOW = 'manifest-overflow.json'
  const overflowPath = (id) => join(ticketEvidenceDir(id), MANIFEST_OVERFLOW)
  const readOverflow = (id) => {
    try {
      const doc = JSON.parse(readFileSync(overflowPath(id), 'utf8'))
      return Array.isArray(doc && doc.entries) ? doc.entries : []
    } catch (e) { return [] }
  }
  // 清单被裁剪时把溢出条目追加进 manifest-overflow.json（按 rel/name 去重合并）：证据条目不允许凭空消失，
  // 宁可多一个 sidecar 文件。写失败就抛出去，让 pruneState 保留原清单（不然两边都没了）。
  const spillArtifacts = (t, dropped) => {
    if (!Array.isArray(dropped) || !dropped.length) return
    const file = overflowPath(t.id)
    let doc = { ticketId: t.id, updatedAt: null, entries: [] }
    try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
      if (e.code !== 'ENOENT') throw e // Let pruneState log and retain the manifest.
    }
    if (!Array.isArray(doc.entries)) doc.entries = []
    const seen = new Set(doc.entries.map((a) => String((a && (a.rel || a.name)) || '')))
    let added = 0
    for (const a of dropped) {
      const k = String((a && (a.rel || a.name)) || '')
      if (!k || seen.has(k)) continue
      doc.entries.push(a)
      seen.add(k)
      added++
    }
    if (!added) return
    doc.ticketId = String(t.id)
    doc.updatedAt = iso(now())
    try { mkdirSync(ticketEvidenceDir(t.id), { recursive: true }) } catch (e) {}
    writeJsonAtomic(file, doc)
    log('prune spill artifacts ' + t.id + ' +' + added + ' -> ' + MANIFEST_OVERFLOW)
  }
  // 产物文件名消毒：替换 Windows 非法字符、去掉开头点（防隐藏与 ../），再截到 80 字符。
  // 80 是保守值 —— 要留给目录前缀和扩展名，避免整条路径超长在 Windows 上直接失败。
  const safeName = (n) => {
    const v = String(n || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/^\.+/, '').trim()
    return (v || 'evidence.md').slice(0, 80)
  }
  const manifestOf = (t) => (Array.isArray(t.artifacts) ? t.artifacts : [])
  const artifactPath = (t, a) => join(evidenceRoot, String(a.rel || (t.id + '/' + a.name)))
  const missingArtifacts = (t) => manifestOf(t).filter((a) => { try { return !existsSync(artifactPath(t, a)) } catch { return true } })
  // 清单优先：清单登记且文件在 = manifest；清单空才回退目录/历史规则（迁移期兜底）
  // 证据解析优先级：清单（manifest）> 目录首个 md/json/txt（dir）> 历史文件名（legacy）。
  // 清单优先因为「登记过的就该是最新的」；legacy 分支保留是为了让迁移期的老工单仍能被认出来。
  const evidenceInfo = (t) => {
    for (const a of manifestOf(t)) {
      try { const p = artifactPath(t, a); if (existsSync(p)) return { path: p, kind: 'manifest' } } catch {}
    }
    const d = ticketEvidenceDir(t.id)
    try {
      const names = readdirSync(d).filter((n) => /\.(md|json|txt)$/i.test(n)).sort()
      if (names.length) return { path: join(d, names[0]), kind: 'dir' }
    } catch {}
    const direct = []
    if (t.evidence) direct.push(String(t.evidence))
    direct.push(join(stateDir, 'codex-' + t.id + '.md'))
    for (const c of direct) { try { if (existsSync(c)) return { path: c, kind: 'legacy' } } catch {} }
    let names = []
    try { names = readdirSync(stateDir) } catch { names = [] }
    for (const n of names) {
      if (!/\.(md|json)$/i.test(n)) continue
      if (EVIDENCE_SKIP.has(n)) continue
      if (!n.includes(t.id)) continue
      return { path: join(stateDir, n), kind: 'legacy' }
    }
    return null
  }
  const evidenceFor = (t) => { const i = evidenceInfo(t); return i ? i.path : null }

  // #R1（lite40）：每个「新执行轮次」都递增代际，旧轮次的失败回调拿旧 gen 就回退不了新活
  // 代际号：每次进入 running 就 +1。旧轮次的失败回调带着旧 gen，回来时对不上就不许改状态 ——
  // 否则重派之后，上一轮的迟到回调会把新一轮判成失败（人已换了，判决还挂在老账上）。
  const bumpDispatchGen = (t) => {
    t.dispatchGen = (t.dispatchGen || 0) + 1
    t.dispatchAt = iso(now())
    return t.dispatchGen
  }

  // sa-194 F7/F8：进入 ready 的统一副作用（原 advance 里的逻辑抽出，供 advance 与 report(final) 共用）
  // 进 ready 的唯一入口：revision+1 → 记首次就绪时间 → 给 owner 投「请验收」。
  // outbox 以 id:revision 为幂等键，同一 revision 重复进入不会重复投递；autoJudge 生效时跳过 owner 提醒。
  function enterReady(s, t) {
    t.revision = (t.revision || 0) + 1
    // #R4（lite39）：首次就绪时间独立保存，避免历史裁剪后耗时漂移
    if (!t.firstReadyAt) t.firstReadyAt = iso(now())
    // sa-194 §14：autoJudge 生效时，ready 阶段不再打扰 owner（改为由 F8 直接提醒 judge）
    const notifyOwner = typeof readyOwnerNotify === 'function' ? readyOwnerNotify(t) !== false : true
    if (!notifyOwner) { log('enqueue-skip(ready) ' + t.id + ' reason=autoJudge'); return }
    const key = t.id + ':' + t.revision
    if (!s.outbox.some((o) => o.key === key)) {
      s.outbox.push({
        key,
        ticketId: t.id,
        revision: t.revision,
        sessionId: t.sessionId || DEFAULT_SESSION || '',
        prompt: '【superagent】工单 ' + t.id + ' 已就绪：' + t.title + '。请验收产物与证据：通过则置 done；不通过则置 blocked 并写明缺什么。' + judgeSummary(t),
        enqueuedAt: iso(now()),
        sentAt: null,
        attempts: 0,
      })
      log('enqueue ' + key + ' session=' + shortSid(t.sessionId || DEFAULT_SESSION))
    }
  }

  const svc = {
    ensureBaseline,

    // 建单：seq 自增就是工单号来源（不依赖 uuid，便于按号引用）。sessionId 三级兜底：
    // 显式 → 配置默认 → 最近一次调用者；都空则留空，投递时会显式报 no-session，不静默丢。
    // 标题截 200 字；换纪元时顺手把旧纪元的已收口单归档。
    submit(title, priority, sessionId, auto, type, noJudge) {
      const s = load()
      s.seq = (s.seq || 0) + 1
      const sid = String(sessionId || DEFAULT_SESSION || s.lastCallerSession || '')
      noteCaller(s, sid)
      const t = {
        id: idFor(s.seq),
        title: String(title || '').slice(0, 200),
        priority: clampPriority(priority),
        state: 'queued',
        revision: 0,
        sessionId: sid,
        createdAt: iso(now()),
        updatedAt: iso(now()),
        artifacts: [],
        history: [{ at: iso(now()), from: null, to: 'queued', session: sid ? shortSid(sid) : null }],
        ...(auto === true ? { auto: true } : {}),
        ...(noJudge === true ? { noJudge: true } : {}),
        type: inferType(type, title),
      }
      s.tickets.push(t)
      // 换纪元（sa-999 → s1-001）时，把旧纪元的 done/blocked 单归档，state 不再无限变长
      if (prefixFor(s.seq) !== prefixFor(s.seq - 1)) {
        const ar = archiveInto(s, { all: true })
        if (ar.archived) log('epoch rotate ' + prefixFor(s.seq) + ' archived=' + ar.archived)
      }
      save(s)
      log('submit ' + t.id + ' ' + t.title)
      return t
    },

    // #27 自动派单的候选：只认显式 auto:true 的 queued 单，priority 高者先、同龄按创建时间
    // 只认显式 auto:true 的单：auto 是「允许自动派」的开关，缺省 false 必须由人/owner 决定派给谁。
    // 排序：priority 降序，同龄按 createdAt 升序（先来先跑），避免高优先级长单把同档新单一直挤后面。
    autoNext() {
      const s = load()
      const cands = s.tickets.filter((t) => t.state === 'queued' && t.auto === true)
      if (!cands.length) return null
      cands.sort((a, b) => (b.priority - a.priority) || String(a.createdAt).localeCompare(String(b.createdAt)))
      return cands[0]
    },

    // sa-194 F7/F8：进入 ready 的公共副作用（owner advance 与 worker-final 共用）
    // —— revision+1、首次就绪时间、给 owner 投「已就绪，请验收/请派审」outbox（按 key 幂等）
    enterReadyEffects(s, t) { enterReady(s, t) },

    // 状态推进的唯一写口：查表校验合法迁移 → 改状态 → 副作用（cancel outbox / enterReady / 回收孩子）。
    // 同态返回 ok+noop，调用方不必先自己判断。ready|blocked → queued 会清 verdict：那是上一轮的判决，
    // 留着会让新轮次一开始就带着错误结论（历史里记一条 verdict-cleared 说明它被清了）。
    advance(id, to, reason) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      if (!STATES.includes(to)) return { ok: false, error: 'bad-state: ' + to }
      if (t.state === to) return { ok: true, ticket: t, noop: true }
      const allowed = NEXT[t.state] || []
      if (!allowed.includes(to)) return { ok: false, error: 'illegal: ' + t.state + ' -> ' + to }
      const from = t.state
      t.state = to
      if (to === 'running') bumpDispatchGen(t)
      t.updatedAt = iso(now())
      if (to === 'blocked') {
        if (reason) t.blockedReason = String(reason)
        cancelPendingOutbox(s, t.id, t.updatedAt)
      }
      // 2026-11-08 修：只有「被判过又要重来」的才作废旧 judge 指派（有 verdict = 上一轮确实判过）。
      // 单纯 blocked（如 policy timeout）→queued 不动 judge，保持幂等、不重复打扰 judge。
      if (to === 'queued' && (from === 'ready' || from === 'blocked') && Object.hasOwn(t, 'verdict')) {
        delete t.verdict
        t.history.push({ at: t.updatedAt, event: 'verdict-cleared', from, to, reason: 'stale-verdict-cleared' })
        if (t.judge) {
          delete t.judge
          t.history.push({ at: t.updatedAt, event: 'judge-cleared', from, to, reason: 'judge-reassign-next-round' })
        }
      }
      if (to === 'ready') enterReady(s, t)
      t.history.push({ at: iso(now()), from, to, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) })
      save(s)
      log('advance ' + t.id + ' ' + from + ' -> ' + to)
      // A（lite30）：done 收口时回调回收该单孩子（角色文件在 apply 层，service 只交工单）
      if (to === 'done') { try { onTicketDone && onTicketDone(t) } catch (e) { log('onTicketDone error ' + (e && e.message ? e.message : String(e))) } }
      return { ok: true, ticket: t }
    },

    // One delivery round; serialize state transactions, never delivery I/O.
    // 投递一轮：锁只包「读/写 state」，真正的 deliver 放在锁外 —— 网络/唤醒可能几十秒，放锁里会卡死整条状态机。
    // ticking 是防重入护栏，重复进来直接返回当前待投数。每投一条都在锁内重新 load，
    // 因为等待期间 policyTick 可能已经改了 outbox（甚至撤单）。
    async tick() {
      if (ticking) return runExclusive(() => ({ sent: 0, pending: load().outbox.filter(isPendingOutbox).length }))
      ticking = true
      try {
        const pend = await runExclusive(() => load().outbox.filter(isPendingOutbox))
        let sent = 0
        const failedKeys = []
        for (const queued of pend) {
          // Earlier delivery I/O may have yielded to policyTick; re-read before starting this delivery.
          const o = await runExclusive(() => load().outbox.find((x) => x.key === queued.key && isPendingOutbox(x)))
          if (!o) continue
          if (!deliver) { failedKeys.push(o.key); continue }
          // N5：目标会话缺失时不静默——记失败、计数，让 policy/watchdog 能看出来
          if (!o.sessionId) { failedKeys.push(o.key); log('deliver skipped ' + o.key + ' reason=no-session'); continue }
          try {
            await deliver(o)
          } catch (e) {
            failedKeys.push(o.key)
            log('deliver failed ' + o.key + ' ' + (e && e.message ? e.message : String(e)))
            continue
          }
          await runExclusive(() => {
            const s = load()
            const current = s.outbox.find((x) => x.key === o.key)
            if (current && !current.sentAt) {
              current.sentAt = iso(now())
              save(s)
            }
          })
          sent++
          log('delivered ' + o.key + ' -> ' + shortSid(o.sessionId))
        }
        if (failedKeys.length) {
          await runExclusive(() => {
            const s = load()
            const failSet = new Set(failedKeys)
            for (const o of s.outbox) {
              if (isPendingOutbox(o) && failSet.has(o.key)) o.attempts = (o.attempts || 0) + 1
            }
            save(s)
          })
        }
        // Keep ticking true until the final queued read completes.
        return await runExclusive(() => ({ sent, pending: load().outbox.filter(isPendingOutbox).length }))
      } finally {
        ticking = false
      }
    },

    // 巡检：只读 state 与产物文件，产出 findings 并告警，绝不改工单状态（改状态只能走 advance）。
    // graceMs=60s 是给 ready 的缓冲期：刚进 ready 证据还没登记，立刻判「无产物」全是噪音。
    async watchdogTick(opts = {}) {
      const runningTimeoutMs = opts.runningTimeoutMs || 20 * 60 * 1000
      const graceMs = opts.graceMs == null ? 60 * 1000 : opts.graceMs
      const dryRun = !!opts.dryRun
      const w = loadW()
      const tNow = now()
      w.baselineAt = w.baselineAt || (dryRun ? iso(tNow) : ensureBaseline())
      const baseline = Date.parse(w.baselineAt)
      let s
      if (dryRun) {
        try { s = readStateFile(stateFile) } catch (error) {
          if (error.code !== 'ENOENT') throw error
          s = emptyState()
        }
      } else {
        s = load()
      }
      const findings = []
      // sa-202 C：queued 积压提醒（只提醒，不自动改）。阈值 dispatchStaleMin 默认 15 分钟
      // dispatchStaleMin 默认 15 分钟：queued 长时间没人派活，说明 autoDispatch 或 owner 掉了；
      // 阈值调太小会把「正常排队」也报成问题。
      const staleMinRaw = Number(svc._dispatchStaleMin ? svc._dispatchStaleMin() : 15)
      const dispatchStaleMs = (Number.isFinite(staleMinRaw) && staleMinRaw >= 0 ? staleMinRaw : 15) * 60000
      let queuedBacklog = 0
      for (const t of s.tickets) {
        const upd = Date.parse(t.updatedAt)
        // sa-202 C：queued 积压检查**不受 baseline 限制**——积压的天生就是「很久以前更新过的单」，
        // 用 baseline 过滤会永远报不出来（baseline 只针对「新一轮才出现的问题」）。
        if (t.state === 'queued') {
          const age = tNow - upd
          if (age > dispatchStaleMs) {
            queuedBacklog++
            findings.push({ ticketId: t.id, reason: 'dispatch-stale', detail: 'queued 已 ' + Math.round(age / 60000) + ' 分钟未被派活（阈值 ' + Math.round(dispatchStaleMs / 60000) + ' 分钟）auto=' + (t.auto === true ? 'true' : 'false') })
          }
          continue
        }
        // B11（2026-11-07）：updatedAt 非法时 Date.parse = NaN，而 !(NaN >= x) 恒真 →
        // 该单被静默 continue，既不报 running 超时也不报积压。坏数据要留痕，不许静默丢单。
        if (!Number.isFinite(upd)) { log('watchdog skip ' + t.id + ' reason=bad-updatedAt ' + String(t.updatedAt)); continue }
        if (!(upd >= baseline)) continue
        if (t.state === 'running') {
          const age = tNow - upd
          if (age > runningTimeoutMs) {
            findings.push({ ticketId: t.id, reason: 'running-timeout', detail: 'running 已 ' + Math.round(age / 60000) + ' 分钟无状态变更（阈值 ' + Math.round(runningTimeoutMs / 60000) + ' 分钟）' })
          }
        } else if (t.state === 'ready' || t.state === 'done') {
          if (t.state === 'ready' && tNow - upd < graceMs) continue
          // N4：清单核对优先；清单登记了但文件不在 = artifact-missing（比「完全没产物」更急）
          const man = manifestOf(t)
          const miss = missingArtifacts(t)
          if (man.length && !miss.length) continue
          if (man.length) {
            findings.push({ ticketId: t.id, reason: 'artifact-missing', detail: '清单登记 ' + man.length + ' 个产物，其中 ' + miss.length + ' 个文件已不在：' + miss.map((a) => a.rel || a.name).join(', ') })
            continue
          }
          if (evidenceInfo(t)) continue
          if (t.state === 'done' && t.verdict && t.verdict.pass === true &&
              typeof t.verdict.reason === 'string' && t.verdict.reason.trim()) continue
          // 2026-11-06 用户定（选项 2）：Codex 的产物先落在它自己的工作区，等 owner 登记证据；
          // 这段时间不报 ready-no-evidence，免得每单都弹一条噪音。
          if (t.state === 'ready' && t.backend === 'codex') continue
          findings.push({ ticketId: t.id, reason: t.state === 'ready' ? 'ready-no-evidence' : 'done-no-artifact', detail: t.state + ' 无产物：artifacts 清单为空、evidence/' + t.id + '/ 无文件、也无历史文件名命中' })
        }
      }
      // 告警去重键 = ticketId:reason：同一单同一个问题只叫醒一次；修好后再出现才会重新告警（见下方清理）。
      // alerts 表最多留 500 条，按最早时间淘汰，防止 watchdog.json 无限增长。
      const fresh = findings.filter((f) => !w.alerts[f.ticketId + ':' + f.reason])
      const text = fresh.length
        ? '【superagent watchdog】' + fresh.map((f) => '\n- ' + f.ticketId + ' [' + f.reason + '] ' + f.detail).join('') + '\n（只告警，不改状态；修好后状态自然消失）'
        : ''
      let alerted = false
      if (!dryRun) {
        if (fresh.length && alert) {
          try {
            await alert(text)
            alerted = true
            for (const f of fresh) w.alerts[f.ticketId + ':' + f.reason] = iso(tNow)
            log('watchdog alert ' + fresh.map((f) => f.ticketId + ':' + f.reason).join(','))
          } catch (e) { log('watchdog alert failed ' + (e && e.message ? e.message : String(e))) }
        } else if (fresh.length) { log('watchdog: no alert channel (' + fresh.length + ')') }
        const activeKeys = new Set(findings.map((f) => f.ticketId + ':' + f.reason))
        for (const key of Object.keys(w.alerts)) {
          if (!activeKeys.has(key)) delete w.alerts[key]
        }
        const alertKeys = Object.keys(w.alerts).sort((a, b) =>
          (Date.parse(w.alerts[a]) || 0) - (Date.parse(w.alerts[b]) || 0))
        for (const key of alertKeys.slice(0, Math.max(0, alertKeys.length - 500))) delete w.alerts[key]
        w.findings = findings
        w.lastRunAt = iso(tNow)
        saveW(w)
      }
      return { findings, fresh, alerted, text, baselineAt: w.baselineAt }
    },

    // N2：下一张该跑的工单（queued 里 priority 高者优先，同优先级先来先跑）
    // 派单候选：所有 queued（不要求 auto），priority 高者优先、同龄先来先跑 —— 人工派单用这个。
    // 与 autoNext 的区别只在「是否过滤 auto:true」。
    pickNext() {
      const s = load()
      const queued = s.tickets.filter((t) => t.state === 'queued')
      if (!queued.length) return null
      queued.sort((a, b) => {
        const pa = clampPriority(a.priority)
        const pb = clampPriority(b.priority)
        if (pb !== pa) return pb - pa
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      })
      return queued[0]
    },

    // 并发视图：running 计数与上限（config.concurrency.maxConcurrent，默认 1）。
    // 这里只报数不排队 —— 排队交给 queued 状态本身。
    concurrency() {
      const s = load()
      const running = s.tickets.filter((t) => t.state === 'running').length
      return { running, max: CONC.maxConcurrent, full: running >= CONC.maxConcurrent }
    },

/* ============================================================
 * 注释切片 # 2 / 4  —— 源文件 handoff/dist/dsh-plugin-superagent-lite/index.js
 * 原始行号：847 – 1730（884 行）
 * 任务：本文件内只新增「整行注释」，不改任何代码字符。整行注释 = 以双斜杠开头的整行，
 *       或独立成块的星号注释（首行仅含斜杠星号、末行仅含星号斜杠）。行内尾注也算，但别改代码本身。
 * 禁碰：handoff/annotate/slices（原始副本）｜handoff/dist（在跑的代码）｜~/.dsh（宿主配置）
 * 自检：node handoff/annotate/verify-slice.mjs 2   → 末行必须是 SLICE 2: PASS
 * ============================================================ */
    // N1：触发层消费 —— 外部事件（QQ/定时/脚本）追加到 ingress.jsonl，这里按游标读、按 key 去重后建单
    tickIngress() {
      const s = load()
      s.ingressOffset = s.ingressOffset || 0
      s.ingressSeen = s.ingressSeen || {}
      // 日志被轮转/截断后 offset 可能大于文件长度：归零重读。不归零时 subarray 静默返回空串，
      // 表现是「事件再也不会建单」却不报任何错，是本文件最隐蔽的失效点之一。
      let buf
      try { buf = readFileSync(ingressFile) } catch { return { created: 0 } }
      if (buf.length < s.ingressOffset) s.ingressOffset = 0
      const slice = buf.subarray(s.ingressOffset).toString('utf8')
      // 只读到倒数第二行：最后一段通常还没写完（没有换行收尾），提前消费会把半行当事件，
      // 或让 offset 越过未写完的字节，把这条事件永久弄丢。
      const lines = slice.split('\n')
      let consumed = 0
      let created = 0
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]
        const bytes = Buffer.byteLength(line, 'utf8') + 1
        consumed += bytes
        let rec = null
        // B3（2026-11-07）：以前 catch 里直接 continue，而 offset 已先按字节推进（上面 2 行）→
        // 坏行（BOM / 截断 / 半个 JSON）被永久跳过且零痕迹（生产上真踩过 PowerShell 写 BOM）。
        // offset 仍前进（坏行不能卡住整个队列），但要留一行可追的日志。
        try { rec = JSON.parse(line) } catch {
          log('ingress bad-line offset=' + (s.ingressOffset + consumed - bytes) + ' bytes=' + bytes + ' head=' + JSON.stringify(String(line).slice(0, 60)))
          continue
        }
        if (!rec || typeof rec !== 'object') continue
        // 去重键要「事件级唯一」（QQ 侧是 qq:g:<群号>:<msgId>）：同 key 只建一张单，
        // 桥接断线重连重放时不会重复建单；没有 key 的记录直接丢弃，宁缺不重。
        const key = String(rec.key || '')
        if (!key) continue
        if (s.ingressSeen[key]) { log('ingress duplicate ' + key); continue }
        const title = String(rec.title || rec.body || '外部事件').slice(0, 200)
        s.seq = (s.seq || 0) + 1
        const id = idFor(s.seq)
        const at = iso(now())
        const sid = String(rec.sessionId || DEFAULT_SESSION || s.lastCallerSession || '')
        noteCaller(s, sid)
        // sa-195 C：来源元数据（回传地址）——显式字段优先，否则从 key（qq:g:<群号>:<msgId>）解析
        const keyParts = key.split(':')
        const chat = String(rec.chat || (keyParts[1] === 'g' || keyParts[1] === 'u' ? keyParts[1] : '') || '')
        const chatId = String(rec.chatId || (chat ? (keyParts[2] || '') : '') || '')
        const msgId = String(rec.msgId || (chat ? (keyParts[3] || '') : '') || '')
        const sourceMeta = (chat && chatId) ? { chat, id: chatId, msgId, files: Array.isArray(rec.files) ? rec.files.map(String) : [] } : null
        s.tickets.push({
          id, title, state: 'queued', revision: 0, sessionId: sid,
          type: inferType(rec.type, title),
          createdAt: at, updatedAt: at,
          history: [{ at, from: null, to: 'queued', source: String(rec.source || 'unknown'), session: sid ? shortSid(sid) : null }],
          source: String(rec.source || 'unknown'),
          ingressKey: key,
          body: String(rec.body || '').slice(0, 4000),
          ...(sourceMeta ? { sourceMeta } : {}),
          ...(Array.isArray(rec.files) && rec.files.length ? { files: rec.files.map(String) } : {}),
        })
        s.ingressSeen[key] = at
        created++
        log('ingress create ' + id + ' source=' + String(rec.source || 'unknown') + ' key=' + key)
        // quietSources 里的来源（cron/心跳）只静音「待派单」提醒，不影响建单本身——
        // 否则定时任务每几分钟吵一次，owner 会把真正的告警也一起忽略。
        // N5.2：外部事件建单后立刻通知决策人「有待派单」，别让工单静默躺在 queued
        if (NOTIFY_DISPATCH && !QUIET_SOURCES.has(String(rec.source || 'unknown'))) {
          const dkey = 'dispatch:' + id
          if (!s.outbox.some((o) => o.key === dkey)) {
            s.outbox.push({
              key: dkey,
              ticketId: id,
              revision: 0,
              sessionId: sid || '',
              kind: 'dispatch-needed',
              prompt: '【superagent】新工单 ' + id + ' 待派单（来源 ' + String(rec.source || 'unknown') + '）：' + title + '\n派单：sa_run ' + id + '（子代理）或 sa_delegate_codex ' + id + '（Codex）；不跑就 sa_advance ' + id + ' blocked 写明原因。',
              enqueuedAt: at,
              sentAt: null,
              attempts: 0,
            })
            log('enqueue ' + dkey + ' session=' + shortSid(sid))
          }
        }
      }
      // 500 是折中值：每天几十条外部事件够去重好几天，又不让 state.json 无限长。
      // 淘汰按时间升序删最旧，且只在「本轮确实消费过」时 save，避免每 tick 都写盘。
      // seen 只保留最近 500 个，避免状态文件无限膨胀
      const keys = Object.keys(s.ingressSeen)
      if (keys.length > 500) {
        keys.sort((a, b) => String(s.ingressSeen[a]).localeCompare(String(s.ingressSeen[b])))
        for (const k of keys.slice(0, keys.length - 500)) delete s.ingressSeen[k]
      }
      s.ingressOffset += consumed
      if (consumed > 0 || created > 0) save(s)
      return { created }
    },

    // N3：失败策略巡检 —— running 超时 / 投递连续失败 → 自动置 blocked 并告警（会改状态，和只读的 watchdog 分开）
    async policyTick() {
      const events = await runExclusive(() => {
        const s = load()
        const tNow = now()
        const events = []
        // sa-207：本轮是否只改了「进度计数」而没有产生 block 事件（用于决定要不要落盘）
        let staleTracked = false
        const block = (t, reason, extra) => {
          const from = t.state
          t.state = 'blocked'
          t.blockedReason = reason
          t.updatedAt = iso(tNow)
          cancelPendingOutbox(s, t.id, iso(tNow))
          t.history.push({ at: iso(tNow), from, to: 'blocked', reason, ...(extra || {}) })
          events.push({ ticketId: t.id, from, to: 'blocked', reason, ...(extra || {}) })
        }
        for (const t of s.tickets) {
          if (t.state !== 'running') continue
          const age = tNow - Date.parse(t.updatedAt)
          if (age > eff().runningTimeoutMs) {
            // sa-207 B：超时不再「一次就 block」——连续 staleMisses 次 updatedAt 都没变化才 block。
            //   有变化（含 sa_progress / sa_report / sa_attach 等 touch）→ 计数归零。
            // 默认要「连续 2 次」看到 updatedAt 没变才 block（sa-207）：跑一轮测试十几分钟很正常，
            // 一次超时就杀单会把真在干活的人误判成挂掉；中间任何 touch 都会把计数重置回 1。
            const staleMisses = Number(eff().staleMisses)
            const needMisses = Number.isFinite(staleMisses) && staleMisses >= 1 ? Math.floor(staleMisses) : 2
            const lastSeen = t.lastSeenUpdatedAt
            if (lastSeen === undefined) {
              // 首次观察到这个超时单：它就是「已经 miss 了一次」——直接记 1。
              //   （记 0 会让 staleMisses=1 也永远差一轮才生效，语义错位）
              t.staleChecks = 1
            } else if (lastSeen === t.updatedAt) {
              t.staleChecks = Number(t.staleChecks || 0) + 1
            } else {
              // 中途被 touch 过（updatedAt 变了）→ 重新从 1 开始
              t.staleChecks = 1
            }
            t.lastSeenUpdatedAt = t.updatedAt
            staleTracked = true
            if (Number(t.staleChecks || 0) >= needMisses) {
              block(t, 'timeout', { ageMin: Math.round(age / 60000), staleChecks: Number(t.staleChecks || 0), staleMisses: needMisses })
            } else {
              // 未到阈值：只累加计数，**不碰 events**（events 的语义是「本轮要置 blocked 的单」，
              //   往里塞 running→running 会被后面的补证据逻辑当成已 block，反而把单杀掉）
              log('stale-check ' + t.id + ' ' + Number(t.staleChecks || 0) + '/' + needMisses + ' age=' + Math.round(age / 60000) + 'min')
            }
          }
        }
        // 投递失败到上限才判死：attempts 由投递端累加，这里只看「已不再重投」的项；
        // 只对 running/ready 下手，queued 单还没有投递语义，不能因 outbox 失败被 block。
        for (const o of s.outbox) {
          if (!isPendingOutbox(o)) continue
          if ((o.attempts || 0) < eff().maxDeliverAttempts) continue
          o.abandonedAt = iso(tNow)
          const t = s.tickets.find((x) => x.id === o.ticketId)
          if (t && (t.state === 'running' || t.state === 'ready')) block(t, 'deliver-failed', { attempts: o.attempts })
        }
        // 没到阈值就没有 events：这时只把计数落盘（staleTracked），不告警也不改状态；
        // 落盘是因为下一轮要靠 staleChecks 继续累加，不写就永远差一步。
        // sa-207：staleChecks / lastSeenUpdatedAt 也要落盘——否则没到阈值的那几轮计数白算
        if (!events.length) { if (staleTracked) save(s); return events }
        save(s)
        // lite45：超时/投递失败被置 blocked 的单也补一份错误证据（便于排查，不再静默）
        for (const e of events) {
          if (eff().errorEvidence === false) { log('policy block ' + e.ticketId + ' reason=' + e.reason + ' (evidence off)'); continue }
          log('policy block ' + e.ticketId + ' reason=' + e.reason + (e.ageMin ? ' ageMin=' + e.ageMin : '') + (e.attempts ? ' attempts=' + e.attempts : ''))
          try {
            this.attach(e.ticketId, {
              name: 'error-evidence.md',
              content: [
                '# 工单错误证据（策略置 blocked）',
                '',
                '- 时间：' + iso(now()),
                '- 工单：' + e.ticketId,
                '- 触发：' + e.reason,
                e.ageMin ? '- 无进展时长：' + e.ageMin + ' 分钟（阈值 ' + Math.round(eff().runningTimeoutMs / 60000) + ' 分钟）' : '',
                e.attempts ? '- 投递失败次数：' + e.attempts : '',
                '',
                '> 单子留在「错误」列，不会自动重派；排查后可用 sa_advance ' + e.ticketId + ' blocked→queued 手动复活。',
              ].filter(Boolean).join('\n'),
              by: 'agent',
            })
          } catch (err) { log('policy attach failed ' + e.ticketId + ' ' + (err && err.message ? err.message : String(err))) }
        }
        return events
      })
      if (!events.length) return { blocked: 0, events }
      if (alert) {
        const text = '【superagent 策略】' + events.map((e) => '\n- ' + e.ticketId + ' → blocked（' + e.reason + '）' + (e.ageMin ? '，' + e.ageMin + ' 分钟无进展' : '') + (e.attempts ? '，投递失败 ' + e.attempts + ' 次' : '')).join('') + '\n（自动处置；要复活用 sa_advance ' + events[0].ticketId + ' blocked→queued）'
        try { await alert(text) } catch (err) { log('policy alert failed ' + (err && err.message ? err.message : String(err))) }
      }
      return { blocked: events.length, events }
    },

    // N3：sa_run 派单失败计数，连续失败达到上限就把工单置 blocked
    recordRunFailure(id) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return null
      t.runAttempts = (t.runAttempts || 0) + 1
      t.updatedAt = iso(now())
      // 只处理还停在 queued 的单：running 的派单失败由 requeueDispatch 按 dispatchGen 处理，
      // 这里若无脑再判一次，会把已经跑起来的单连人带证据一起杀掉。
      let blocked = false
      if (t.runAttempts >= POLICY.maxRunAttempts && t.state === 'queued') {
        const from = t.state
        t.state = 'blocked'
        t.blockedReason = 'run-failed'
        cancelPendingOutbox(s, t.id, t.updatedAt)
        t.history.push({ at: iso(now()), from, to: 'blocked', reason: 'run-failed', attempts: t.runAttempts })
        blocked = true
        log('policy block ' + id + ' reason=run-failed attempts=' + t.runAttempts)
      }
      save(s)
      return { attempts: t.runAttempts, blocked }
    },

    // C（lite30）：自动派单 fanout 成功但 tell 失败 → 退回 queued 并记原因（t.dispatchFailed），下一轮重试
    requeueDispatch(id, reason, expectGen) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      // #58（lite36）：迟到失败只允许回退同一代且仍在运行的派单
      if (expectGen !== undefined && expectGen !== null) {
        const cur = Number(t.dispatchGen || 0)
        if (cur !== Number(expectGen) || t.state !== 'running') {
          log('requeue ' + id + ' stale-dispatch ignored gen=' + expectGen + ' cur=' + cur + ' state=' + t.state)
          return { ok: false, stale: true, error: 'stale-dispatch', state: t.state, dispatchGen: cur }
        }
      }
      const from = t.state
      t.dispatchFailures = (t.dispatchFailures || 0) + 1
      t.dispatchFailed = { reason: String(reason || '').slice(0, 500), at: iso(now()) }
      t.updatedAt = iso(now())
      // 阈值 4 是经验值：前几次多是宿主刚起、会话忙之类的瞬时问题，重试能救；
      // 连续 4 次仍失败基本是配置/权限坏了，再回 queued 只会无限空转刷屏，所以留证 blocked。
      // #56：到阈值不再回 queued，停止「退→重派」空转，置 blocked
      if (t.dispatchFailures >= 4) {
        t.state = 'blocked'
        t.blockedReason = 'dispatch-failed x4: ' + String(reason || '').slice(0, 500)
        cancelPendingOutbox(s, t.id, t.updatedAt)
        t.history.push({ at: iso(now()), from, to: 'blocked', reason: 'dispatch-failed-limit' })
        save(s)
        log('requeue ' + id + ' ' + from + ' -> blocked reason=dispatch-failed-limit failures=' + t.dispatchFailures)
        return { ok: true, blocked: true, ticket: t }
      }
      t.state = 'queued'
      t.history.push({ at: iso(now()), from, to: 'queued', reason: 'dispatch-failed' })
      save(s)
      log('requeue ' + id + ' ' + from + ' -> queued reason=dispatch-failed')
      return { ok: true, ticket: t }
    },

    // 手动结档：面板把命令写成 commands/<uuid>.json，这里按状态机安全收口
    tickCommands() {
      return runExclusive(() => {
        let names = []
        try { names = readdirSync(commandsDir).filter((n) => /\.json$/i.test(n)) } catch { return 0 }
        let done = 0
        for (const n of names) {
          const p = join(commandsDir, n)
          let cmd = null
          // 读完立刻删：命令文件是一次性的。解析失败也删，否则坏 JSON 每个 tick 都会重试、
          // 反复写日志，面板上看起来就是「队列永远卡着一条命令」。
          try { cmd = JSON.parse(readFileSync(p, 'utf8')) } catch {}
          try { unlinkSync(p) } catch {}
          const action = String((cmd && cmd.action) || '')
          if (!['close', 'restore', 'restore-all', 'archive', 'requeue'].includes(action)) {
            log('command skip unknown-action ' + JSON.stringify(action) + ' file=' + n)
            continue
          }
          const id = String((cmd && cmd.ticketId) || '')
          try {
            if (action === 'restore-all') {
              const s0 = load()
              const k = restoreAllImpl(s0)
              log('command restore-all tickets=' + k)
              done += k
              continue
            }
            if (action === 'requeue') {
              // v37：错误单「重跑」—— 只允许 blocked → queued（证据保留，blockedReason 留给下一轮覆盖）
              if (!ID_RE.test(id)) { log('command skip bad-ticket ' + n); continue }
              const t0 = this.find(id)
              if (!t0) { log('command skip no-such-ticket ' + id); continue }
              if (t0.state !== 'blocked') { log('command skip not-blocked ' + id + ' state=' + t0.state); continue }
              try { this.advance(id, 'queued', 'manual-requeue') } catch (e) { log('command requeue failed ' + id + ' ' + (e && e.message ? e.message : String(e))); continue }
              log('command requeue ' + id + ' -> queued')
              done++
              continue
            }
            if (action === 'archive') {
              if (!ID_RE.test(id)) { log('command skip bad-ticket ' + n); continue }
              const r = this.archiveOne(id)
              log('command archive ' + id + ' -> ' + (r.ok ? 'moved' : String(r.error || 'failed')))
              if (r.ok) done++
              continue
            }
            if (action === 'restore') {
              if (!ID_RE.test(id)) { log('command skip bad-ticket ' + n); continue }
              const s0 = load()
              const ok = restoreOneImpl(s0, id)
              log('command restore ' + id + ' -> ' + (ok ? 'back' : 'not-archived'))
              if (ok) done++
              continue
            }
            if (!ID_RE.test(id)) { log('command skip bad-ticket ' + n); continue }
            const t = this.find(id)
            if (!t) { log('command skip no-such-ticket ' + id); continue }
            if (t.state === 'done') { log('command skip already-done ' + id); continue }
            if (t.state === 'running' || t.state === 'queued') this.advance(id, 'blocked', 'manual-close')
            const cur = this.find(id)
            if (cur && cur.state !== 'done') this.advance(id, 'done')
            const after = this.find(id)
            if (after && after.state === 'done' && !(Array.isArray(after.artifacts) && after.artifacts.length)) {
              try { this.attach(id, { name: 'manual-close.md', content: '# 手动结档\n\n面板手动结档于 ' + iso(now()) + '；本单此前没有登记证据，自动补此说明。\n', by: 'human' }) } catch (err) { log('command attach failed ' + id + ' ' + (err && err.message ? err.message : String(err))) }
            }
            log('command close ' + id + ' -> done')
            done++
          } catch (err) { log('command error ' + id + ' ' + (err && err.message ? err.message : String(err))) }
        }
        return done
      })
    },

    // 归档：把 done/blocked 移出 state（keep=N 保留最近 N 张；before=ISO 只归档更早的；all=true 全归档）
    archive(opts = {}) {
      const s = load()
      const r = archiveInto(s, opts || {})
      if (r.archived && !opts.dryRun) save(s)
      if (!opts.dryRun) log('archive tickets=' + r.archived + ' files=' + (r.files || []).map((x) => String(x).split(/[\\/]/).pop()).join(','))
      return { ok: true, ...r }
    },

    restoreOne(id) { const s = load(); const ok = restoreOneImpl(s, id); return { ok, id } },

    // lite49：面板列表里的「归档」按钮 —— 只收 done/blocked 的单，单张搬进 archive（证据目录一起走）
    archiveOne(id) {
      const s = load()
      const t = (s.tickets || []).find((x) => x.id === String(id))
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      if (t.state !== 'done' && t.state !== 'blocked') return { ok: false, error: 'not-closed: ' + t.state }
      const r = archiveInto(s, { ids: [String(id)] })
      if (r.archived) save(s)
      if (r.archived) log('archive-one ' + id + ' files=' + (r.files || []).map((x) => String(x).split(/[\\/]/).pop()).join(','))
      return { ok: r.archived > 0, id, ...r }
    },
    restoreAll() { const s = load(); const k = restoreAllImpl(s); return { ok: true, restored: k } },

    // lite44：失败直接「留档」——置 blocked 并写一条错误证据，不再退回队列重复投递
    failTicket(id, reason) {
      const t = this.find(id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      if (t.state === 'done') return { ok: false, error: 'already-done' }
      const why = String(reason || 'error').slice(0, 300)
      if (t.state !== 'blocked') {
        const r = this.advance(id, 'blocked', why)
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'advance-failed' }
      }
      try {
        if (eff().errorEvidence === false) { log('fail-ticket ' + id + ' evidence off'); return { ok: true, id } }
        const cur = this.find(id) || t
        this.attach(id, {
          name: 'error-evidence.md',
          content: [
            '# 工单错误证据',
            '',
            '- 时间：' + iso(now()),
            '- 工单：' + id,
            '- 原状态：' + String(t.state),
            '- 后端：' + String(cur.backend || '(none)'),
            '- 归属会话：' + String(cur.sessionId || '(none)'),
            '- 失败次数：' + String(cur.dispatchFailures || cur.runAttempts || 0),
            '- 原因：' + why,
            '',
            '> lite44 起：失败单不再回队列重复投递，直接留在「错误」列，凭这条证据排查。',
          ].join('\n'),
          by: 'agent',
        })
      } catch (e) { log('fail-ticket attach failed ' + id + ' ' + (e && e.message ? e.message : String(e))) }
      log('fail-ticket ' + id + ' -> blocked reason=' + why.slice(0, 120))
      return { ok: true, id }
    },

    settings() { return eff() },

    policy() { return { ...POLICY } },

    find(id) { return load().tickets.find((x) => x.id === id) || null },

    // N5：改工单归属会话（换项目/移交别的会话处理时用）
    transfer(id, sessionId) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      const sid = String(sessionId || '')
      if (!sid) return { ok: false, error: 'empty-session' }
      if (t.sessionId === sid) return { ok: true, ticket: t, noop: true }
      const from = t.sessionId || '(none)'
      t.sessionId = sid
      t.updatedAt = iso(now())
      // 仅 pending outbox 跟着换目标；已投、放弃、取消项保持原样
      for (const o of s.outbox) {
        if (o.ticketId === t.id && isPendingOutbox(o)) o.sessionId = sid
      }
      save(s)
      log('transfer ' + id + ' ' + shortSid(from) + ' -> ' + shortSid(sid))
      return { ok: true, ticket: t, from, to: sid }
    },

    // N5：告警/兜底目标（配置默认优先，其次最近调用会话）
    fallbackSession,

    // N5.2：任何工具调用都能刷新「最近调用会话」，避免兜底指向已结束的会话
    touchCaller(sessionId) {
      const sid = String(sessionId || '')
      if (!sid) return false
      const s = load()
      if (s.lastCallerSession === sid) return false
      s.lastCallerSession = sid
      save(s)
      return true
    },

    // N7：把一张工单派给多个 worker（决策动作），工单转 running 并记 assignees
    fanout(id, sessionIds, brief) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      if (t.state !== 'queued') return { ok: false, error: 'not-queued: ' + t.state }
      const ids = (Array.isArray(sessionIds) ? sessionIds : []).map(String).filter(Boolean)
      if (!ids.length) return { ok: false, error: 'empty-assignees' }
      t.assignees = ids.map((sid) => ({ sessionId: sid, at: iso(now()), status: 'assigned' }))
      if (brief) t.brief = String(brief).slice(0, 2000)
      const from = t.state
      t.state = 'running'
      // #58（lite36）：每次成功派单递增代际，区分旧投递的失败回调
      bumpDispatchGen(t)
      t.updatedAt = iso(now())
      t.history.push({ at: iso(now()), from, to: 'running', kind: 'fanout', assignees: ids.length })
      save(s)
      log('fanout ' + id + ' -> ' + ids.length + ' worker(s)')
      return { ok: true, ticket: t, assignees: t.assignees }
    },

    // sa-194 F1：把「运行中追加需求」落进工单 —— 写 requirements、bump rev、touch updatedAt
    // （updatedAt 顺延同时把 policy 的超时窗口往后推，避免返工中被误杀）
    addRequirement(id, text, bySession) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      t.requirements = Array.isArray(t.requirements) ? t.requirements : []
      t.revision = Number(t.revision || 0) + 1
      t.requirements.push({ at: iso(now()), by: String(bySession || ''), text: String(text || '').slice(0, 2000), rev: t.revision })
      t.updatedAt = iso(now())
      save(s)
      log('requirement ' + id + ' v' + t.revision)
      return { ok: true, ticket: t, revision: t.revision, count: t.requirements.length }
    },

    // sa-207 A：心跳——刷新 updatedAt、记一条 progress、把 staleChecks 归零（防 policy 误杀）
    progress(id, note, bySession) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      const at = iso(now())
      t.updatedAt = at
      t.lastProgressAt = at
      t.progress = Array.isArray(t.progress) ? t.progress : []
      t.progress.push({ at, by: String(bySession || ''), note: String(note || '').slice(0, 200) })
      // 最多保留 20 条，溢出丢最旧
      while (t.progress.length > 20) t.progress.shift()
      t.staleChecks = 0
      t.lastSeenUpdatedAt = at
      save(s)
      log('progress ' + id + ' by=' + shortSid(bySession) + ' note=' + String(note || '').slice(0, 60))
      return { ok: true, ticket: t, count: t.progress.length }
    },

    // N7：worker 交活后自报（第一筛的一半：证据 + 自述），只作用于派给自己的单
    report(id, summary, bySession, opts) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      const sid = String(bySession || '')
      t.assignees = Array.isArray(t.assignees) ? t.assignees : []
      const a = t.assignees.find((x) => String(x.sessionId) === sid)
      const enforce = !(opts && opts.allowAny)
      // D（lite30）：空 sid 同样拦 —— 原来 sid 为空会绕过 assignee 校验，谁都能冒充「未知会话」自报
      if (enforce && (!sid || !a)) return { ok: false, error: 'not-assigned-to-you' }
      if (a) { a.status = 'reported'; a.reportedAt = iso(now()) }
      t.reports = Array.isArray(t.reports) ? t.reports : []
      t.reports.push({ sessionId: sid || '(unknown)', summary: String(summary || '').slice(0, 2000), at: iso(now()) })
      // sa-194 F4 + F7：final:true = worker 声明「我干完了」。
      //   running → 直接转 ready（history kind=worker-final，走 enterReady 的 outbox 通知），
      //   其它状态只记标记并提示（worker 仍不能置 done，双筛末端不松）。
      let transitioned = false
      if (opts && opts.final) {
        t.workerFinalAt = iso(now())
        if (a) a.status = 'reported'
        if (t.state === 'running') {
          const from = t.state
          t.state = 'ready'
          enterReady(s, t)
          t.history.push({ at: iso(now()), from, to: 'ready', kind: 'worker-final' })
          transitioned = true
        }
      }
      t.updatedAt = iso(now())
      // sa-207：report 也算「有进展」——显式归零（policy 的判定也看 updatedAt 变化，双保险）
      t.staleChecks = 0
      t.lastSeenUpdatedAt = t.updatedAt
      save(s)
      log('report ' + id + ' by=' + shortSid(sid) + (transitioned ? ' -> ready(worker-final)' : ''))
      return { ok: true, ticket: t, reports: t.reports.length, state: t.state, transitioned }
    },

    // sa-194 F8：记录「judge 已收到验收请求」——autoJudge 幂等依据（pending / notifiedAt 都不重投）
    // sa-195：给 owner 排一条自由文本提醒（失败不静默；不复用 ready/verdict 的键）
    ownerNotice(id, prompt) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      const key = 'notice:' + id + ':' + randomUUID()
      s.outbox.push({
        key, ticketId: id, revision: Number(t.revision || 0),
        sessionId: t.sessionId || DEFAULT_SESSION || '',
        prompt: String(prompt || '').slice(0, 1000),
        enqueuedAt: iso(now()), sentAt: null, attempts: 0,
      })
      save(s)
      log('enqueue ' + key)
      return { ok: true, key }
    },

    markJudgeNotified(id) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t || !t.judge) return { ok: false, error: 'no-judge: ' + id }
      t.judge.notifiedAt = iso(now())
      t.judge.status = 'pending'
      save(s)
      return { ok: true, ticket: t }
    },

    // N7：把工单交给 judge 会话独立验收（第二筛）
    assignJudge(id, judgeSessionId, criteria) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      t.judge = { sessionId: String(judgeSessionId || ''), criteria: String(criteria || '').slice(0, 2000), at: iso(now()), status: 'pending' }
      t.updatedAt = iso(now())
      save(s)
      log('judge-assign ' + id + ' -> ' + shortSid(judgeSessionId))
      return { ok: true, ticket: t }
    },

    // N7.2：把「坑在哪」记进工单（投递由 apply 层的 sa_escalate / verdict 负责，service 只存账）
    escalate(id, problem, bySession, targetSession) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      t.escalations = Array.isArray(t.escalations) ? t.escalations : []
      const rec = { problem: String(problem || '').slice(0, 2000), at: iso(now()), by: String(bySession || ''), to: String(targetSession || '') }
      t.escalations.push(rec)
      t.updatedAt = iso(now())
      save(s)
      log('escalate ' + id + ' by=' + shortSid(bySession) + ' to=' + shortSid(targetSession))
      return { ok: true, ticket: t, count: t.escalations.length, rec }
    },

    // N7：judge 出结论；通过 → ready（走既有投递通知决策人收口），不通过 → blocked
    verdict(id, pass, reason, bySession) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      t.verdict = { pass: !!pass, reason: String(reason || '').slice(0, 2000), at: iso(now()), by: String(bySession || '') }
      if (t.judge) t.judge.status = pass ? 'passed' : 'rejected'
      t.updatedAt = iso(now())
      save(s)
      const r = this.advance(id, pass ? 'ready' : 'blocked', pass ? undefined : ('judge-rejected: ' + String(reason || '')))
      // sa-202 B：judge 判 fail → 若还没到自动复活上限，就自动 blocked→queued 并复活一次
      //   reworkCount 默认 0；maxAutoRework 默认 1（只自动一次，防死循环）
      //   判词原文完整写进 requirements（type:'judge-feedback'），下一轮 worker 能看到
      if (!pass && r && r.ok !== false) {
        const maxRework = Number(typeof svc._maxAutoRework === 'function' ? svc._maxAutoRework() : (Number.isFinite(Number(maxAutoReworkOpt)) ? Number(maxAutoReworkOpt) : 1))
        const s3 = load()
        const t3 = s3.tickets.find((x) => x.id === id)
        if (t3) {
          // 默认只自动复活 1 次（maxAutoRework）。判 fail 往往是「需求没写清」，
          // 无限复活会让同一张单在 queued/blocked 之间空转；超限就留在 blocked，交 owner 决定。
          const doneCount = Number(t3.reworkCount || 0)
          if (doneCount < maxRework) {
            t3.reworkCount = doneCount + 1
            t3.requirements = Array.isArray(t3.requirements) ? t3.requirements : []
            t3.requirements.push({
              at: iso(now()),
              by: 'auto-rework',
              type: 'judge-feedback',
              text: String(reason || '').slice(0, 2000),
              rev: Number(t3.revision || 0),
            })
            t3.state = 'queued'
            t3.updatedAt = iso(now())
            // verdict 属于「上一轮验收」：单子回到 queued 后必须删掉，
            // 否则面板/工具读到 t.verdict 会以为已经通过，把在返工的单当成交付完成。
            // 复活时清掉旧判词，避免下一轮误读「已判过」
            delete t3.verdict
            // 2026-11-08 修：自动返工时同样作废旧 judge 指派（否则回修版不会再送审）
            if (t3.judge) { delete t3.judge; t3.history.push({ at: iso(now()), event: 'judge-cleared', reason: 'auto-rework' }) }
            // 保持 auto=true 才可能被自动派单；若原单没开 auto，这里不动它（尊重原设置）
            t3.history.push({ at: iso(now()), from: 'blocked', to: 'queued', kind: 'auto-rework', reworkCount: t3.reworkCount, reason: 'judge-failed-auto-rework' })
            save(s3)
            log('auto-rework ' + id + ' reworkCount=' + t3.reworkCount + '/' + maxRework + ' -> queued')
          } else {
            // 超限：保持 blocked，提醒 owner（不自动）
            log('auto-rework-limit ' + id + ' reworkCount=' + doneCount + '/' + maxRework + ' stays blocked')
          }
        }
      }
      // sa-194 §14③：autoJudge 模式下 owner 只在 verdict 之后被提醒一次（pass→收口 / fail→回修）
      const notifyV = typeof verdictOwnerNotify === 'function' ? verdictOwnerNotify(t) === true : false
      // 2026-11-08：judge 通过时的「请收口」通知可单独关 —— settings.notifyEvents.verdictPass = false
      const verdictPassNotifyOn = () => { try { const s0 = readSettings(); const ne = (s0 && s0.notifyEvents) || {}; return ne.verdictPass !== false } catch { return true } }
      if (notifyV && (pass ? verdictPassNotifyOn() : true)) {
        const s2 = load()
        const t2 = s2.tickets.find((x) => x.id === id) || t
        const key = 'verdict:' + id + ':' + String(t2.revision || 0)
        if (!s2.outbox.some((o) => o.key === key)) {
          s2.outbox.push({
            key,
            ticketId: id,
            revision: Number(t2.revision || 0),
            sessionId: t2.sessionId || DEFAULT_SESSION || '',
            prompt: pass
              ? '【superagent】工单 ' + id + ' judge 已通过：' + t2.title + '。请收口（sa_advance done）。'
              : '【superagent】工单 ' + id + ' judge 判不通过：' + String(reason || '').slice(0, 160) + '。请安排回修（可重新派活或 sa_advance queued）。',
            enqueuedAt: iso(now()),
            sentAt: null,
            attempts: 0,
          })
          save(s2)
          log('enqueue(verdict) ' + key + ' session=' + shortSid(t2.sessionId || DEFAULT_SESSION))
        }
      }
      log('verdict ' + id + ' pass=' + !!pass + ' by=' + shortSid(bySession))
      return { ok: r.ok, ticket: r.ticket || t, error: r.error, pass: !!pass, reason: String(reason || '') }
    },

    // N5：按会话汇总（面板/运维看“哪几张单归哪个会话”）
    bySession() {
      const s = load()
      const out = {}
      for (const t of s.tickets) {
        const k = t.sessionId || '(none)'
        out[k] = out[k] || { total: 0, byState: {} }
        out[k].total++
        out[k].byState[t.state] = (out[k].byState[t.state] || 0) + 1
      }
      return out
    },

    // N4：把产物登记进 evidence/<工单id>/（content 直接写、sourcePath 复制），清单写进 ticket.artifacts
    attach(id, opts = {}) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      const dir = ticketEvidenceDir(id)
      try { mkdirSync(dir, { recursive: true }) } catch (e) { return { ok: false, error: 'mkdir failed: ' + (e && e.message ? e.message : String(e)) } }
      const baseName = safeName(opts.name || (opts.sourcePath ? basename(String(opts.sourcePath)) : 'evidence.md'))
      // #35：多 assignee 工单里各 worker 常交同名文件（sa-023 两份 task-report.md 只剩 1 份、清单失真），
      // 按生产者加短 sid 前缀区分；单 assignee / 非 assignee（owner、judge）保持原名，向后兼容。
      const ass = Array.isArray(t.assignees) ? t.assignees : []
      const producer = String(opts.producer || '')
      const isMultiWorker = ass.length > 1 && !!producer && ass.some((a) => String(a.sessionId) === producer)
      const prefix = isMultiWorker ? producer.replace(/^session-/, '').slice(-6) + '-' : ''
      const name = prefix && !baseName.startsWith(prefix) ? prefix + baseName : baseName
      const target = join(dir, name)
      try {
        if (opts.sourcePath) {
          const src = String(opts.sourcePath)
          // #59（lite36）：先检查真实路径、敏感名、允许根与体积，拒绝时不落文件和清单。
          const deny = (reason) => {
            log('attach-deny ' + id + ' ' + reason)
            return { ok: false, error: reason }
          }
          const roots = (Array.isArray(cfg.attachRoots) ? cfg.attachRoots : []).map(String).filter(Boolean)
          if (!roots.length) roots.push(resolve(dirname(stateDir), '..'), tmpdir())
          const real = realOrResolve(src)
          if (real === null) return deny('source-not-found: ' + src)
          if (ATTACH_DENY.some((re) => re.test(real))) return deny('source-denied-sensitive: ' + real)
          const inRoot = roots.some((r) => {
            const rr = realOrResolve(r) || resolve(r)
            const rel = relative(rr, real)
            // #R5（lite39）：按父目录段拒绝越界，放行根内的双点前缀文件名
            if (rel === '') return true
            if (isAbsolute(rel)) return false
            if (rel === '..') return false
            if (rel.startsWith('..' + sep)) return false
            return true
          })
          if (!inRoot) return deny('source-outside-allowed-roots: ' + real + ' (roots: ' + roots.join('; ') + ')')
          const cap = Number(eff().attachMaxBytes || 8 * 1024 * 1024)
          // #64（lite48）：realpath 校验与复制之间不再按路径二次解析 —— 开句柄、用句柄读；
          // 开完立刻复核 realpath 仍等于校验值，被换成 junction/软链就拒（TOCTOU 窗口压到一次 open）
          const fd = openSync(real, 'r')
          try {
            let again = null
            try { again = realpathSync(real) } catch (e) { again = null }
            if (again !== real) return deny('source-changed: ' + real + ' -> ' + String(again))
            const size = fstatSync(fd).size
            if (size > cap) return deny('source-too-large: ' + size + ' > ' + cap)
            writeFileSync(target, readFileSync(fd))
          } finally {
            try { closeSync(fd) } catch (e) {}
          }
        } else {
          const content = String(opts.content == null ? '' : opts.content)
          const cap = Number(eff().attachMaxBytes || 8 * 1024 * 1024)
          const size = Buffer.byteLength(content, 'utf8')
          if (size > cap) {
            const reason = 'source-too-large: ' + size + ' > ' + cap
            log('attach-deny ' + id + ' ' + reason)
            return { ok: false, error: reason }
          }
          writeFileSync(target, content, 'utf8')
        }
      } catch (e) { return { ok: false, error: 'write failed: ' + (e && e.message ? e.message : String(e)) } }
      let bytes = 0
      try { bytes = statSync(target).size } catch {}
      const at = iso(now())
      const rel = id + '/' + name
      // 同一 rel/name 视为「重交同一份证据」：更新字节数与时间，不追加新条目，
      // 否则返工几次后清单里全是同名文件，统计和缺件判定都会失真。
      t.artifacts = Array.isArray(t.artifacts) ? t.artifacts : []
      const prev = t.artifacts.find((a) => a.rel === rel || a.name === name)
      if (prev) { prev.bytes = bytes; prev.at = at; prev.rel = rel; prev.name = name }
      else t.artifacts.push({ name, rel, bytes, at, by: String(opts.by || 'agent'), ...(producer ? { producer } : {}) })
      t.updatedAt = at
      // sa-207：attach 也算「有进展」——显式归零，防 policy 把「正在写证据」误判成超时
      t.staleChecks = 0
      t.lastSeenUpdatedAt = at
      save(s)
      log('attach ' + id + ' ' + rel + ' ' + bytes + 'B')
      return { ok: true, path: target, rel, bytes, count: t.artifacts.length }
    },

    // N4：证据详情（清单 vs 磁盘 diff，能看出缺件与孤儿文件）
    evidence(id) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      const dir = ticketEvidenceDir(id)
      const man = manifestOf(t)
      let onDisk = []
      try { onDisk = readdirSync(dir) } catch { onDisk = [] }
      // #63（lite48）：被裁剪挤出的旧条目在 manifest-overflow.json，算「登记过但不在当前清单」，不算孤儿
      const overflow = readOverflow(id)
      // sidecar 里登记过的旧条目也算「已知」，否则它们会被误报成孤儿（文件删了才报缺件）
      const listed = new Set(man.map((a) => a.name))
      for (const a of overflow) {
        const n = String((a && (a.rel || a.name)) || '')
        if (n) listed.add(n.includes('/') ? n.split('/').pop() : n)
      }
      // 返回结构刻意把「清单」和「磁盘」分开：missing = 登记了但盘上没有，
      // orphans = 盘上有但没登记（overflow 侧车登记过的旧条目不算孤儿），legacyOnly 兼容旧布局。
      const info = evidenceInfo(t)
      return {
        ok: true, id, state: t.state, dir,
        manifest: man,
        overflow,
        overflowFile: overflowPath(id),
        onDisk,
        missing: missingArtifacts(t).map((a) => a.rel || a.name),
        orphans: onDisk.filter((n) => !listed.has(n) && n !== MANIFEST_OVERFLOW),
        resolved: info,
        legacyOnly: !man.length && !!info && info.kind === 'legacy',
      }
    },

    // N4：统计（按状态/后端/来源/耗时/产物完整度）
    stats() {
      const s = load()
      const byState = {}, byBackend = {}, bySource = {}
      const durations = []
      let arts = 0, withArts = 0, legacyOnly = 0, noArtifact = 0, incomplete = 0
      for (const t of s.tickets) {
        byState[t.state] = (byState[t.state] || 0) + 1
        const b = t.backend || '(none)'
        byBackend[b] = (byBackend[b] || 0) + 1
        const src = t.source || '(local)'
        bySource[src] = (bySource[src] || 0) + 1
        const man = manifestOf(t)
        arts += man.length
        if (man.length) { withArts++; if (missingArtifacts(t).length) incomplete++ }
        else { const info = evidenceInfo(t); if (info && info.kind === 'legacy') legacyOnly++; else if (!info) noArtifact++ }
        const hist = t.history || []
        const reached = hist.find((h) => h.to === 'ready') || hist.find((h) => h.to === 'done')
        // #R4（lite39）：优先首次就绪时间，旧数据沿用历史回退
        if (t.firstReadyAt || reached) {
          const ms = Date.parse(t.firstReadyAt || reached.at) - Date.parse(t.createdAt)
          if (Number.isFinite(ms) && ms >= 0) durations.push({ id: t.id, backend: b, ms })
        }
      }
      // 简化分位数（floor 后夹到 len-1，不做插值）：样本少时 p50 偏小一侧无所谓，
      // 关键是不能越界成 NaN——面板显示 NaN 比数字略偏更容易被误判成统计坏了。
      const sorted = durations.map((d) => d.ms).sort((a, b) => a - b)
      const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null)
      const perBackend = {}
      for (const d of durations) {
        perBackend[d.backend] = perBackend[d.backend] || { n: 0, totalMs: 0 }
        perBackend[d.backend].n++
        perBackend[d.backend].totalMs += d.ms
      }
      for (const k of Object.keys(perBackend)) perBackend[k].avgMs = Math.round(perBackend[k].totalMs / perBackend[k].n)
      return {
        total: s.tickets.length,
        byState, byBackend, bySource,
        evidence: { root: evidenceRoot, artifacts: arts, ticketsWithArtifacts: withArts, legacyOnly, noArtifact, incomplete },
        durations: {
          n: sorted.length,
          avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
          p50Ms: q(0.5),
          maxMs: sorted.length ? sorted[sorted.length - 1] : null,
          byBackend: perBackend,
        },
      }
    },

    // #47：多模型扇出 —— 一张单挂多个孩子，全部记成 assignee，收口时统一回收
    attachChildren(id, ids) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean)
      if (!list.length) return { ok: false, error: 'no-children' }
      const previous = Array.isArray(t.childrenIds) ? t.childrenIds.map(String).filter(Boolean) : []
      if (t.childId && !previous.includes(String(t.childId))) previous.unshift(String(t.childId))
      t.childrenIds = [...new Set([...previous, ...list])]
      if (!t.childId) t.childId = t.childrenIds[0]
      t.assignees = Array.isArray(t.assignees) ? t.assignees : []
      for (const cid of t.childrenIds) {
        if (!t.assignees.some((a) => String(a.sessionId) === cid)) t.assignees.push({ sessionId: cid, at: iso(now()), status: 'assigned' })
      }
      t.updatedAt = iso(now())
      save(s)
      log('attach children ' + list.map((x) => String(x).slice(0, 8)).join(',') + ' -> ' + id)
      return { ok: true, ticket: t }
    },

    attachChild(id, childId) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      t.childId = String(childId)
      // #46A：孩子要能交证据，必须同时是 assignee（canSubmitEvidence 查的是 assignees）
      t.assignees = Array.isArray(t.assignees) ? t.assignees : []
      if (childId && !t.assignees.some((a) => String(a.sessionId) === String(childId))) {
        t.assignees.push({ sessionId: String(childId), at: iso(now()), status: 'assigned' })
      }
      t.updatedAt = iso(now())
      save(s)
      log('attach child ' + t.childId + ' -> ' + id + (childId ? ' as-assignee' : ''))
      return { ok: true, ticket: t }
    },

    delegate(id, backend) {
      const s = load()
      const t = s.tickets.find((x) => x.id === id)
      if (!t) return { ok: false, error: 'no-such-ticket: ' + id }
      if (t.state !== 'queued') return { ok: false, error: 'not-queued: ' + t.state }
      t.backend = String(backend)
      const from = t.state
      t.state = 'running'
      bumpDispatchGen(t)
      t.updatedAt = iso(now())
      t.history.push({ at: iso(now()), from, to: 'running' })
      save(s)
      log('delegate ' + id + ' backend=' + backend)
      return { ok: true, ticket: t }
    },

    tickCodex() {
      const s = load()
      s.codexOffset = s.codexOffset || 0
      let buf
      try { buf = readFileSync(eventsFile) } catch { return { matched: 0 } }
      if (buf.length < s.codexOffset) s.codexOffset = 0
      const slice = buf.subarray(s.codexOffset).toString('utf8')
      const lines = slice.split('\n')
      let consumed = 0
      let matched = 0
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]
        consumed += Buffer.byteLength(line, 'utf8') + 1
        try {
          const rec = JSON.parse(line)
          // 同时认 sa-123 与 s1-123：sa-999 用满后归档纪元会滚动成 s1-001，
          // 只匹配 sa- 会让滚动后的单永远匹配不上，表现是「Codex 跑完了工单不动」。
          const txt = readFileSync(rec.file, 'utf8')
          const m = txt.match(/sa-ticket:\s*((?:sa|s\d+)-\d+)/)
          if (!m) continue
          // 状态和后端都要对上才推进：Stop 事件可能延迟到达，期间单子已被手动改判/归档，
          // 这时再把它推到 ready 会制造一张「没人认领的待验收单」。
          const t = s.tickets.find((x) => x.id === m[1])
          if (!t || t.state !== 'running' || t.backend !== 'codex') continue
          const from = t.state
          t.state = 'ready'
          t.revision = (t.revision || 0) + 1
          t.updatedAt = iso(now())
          t.history.push({ at: iso(now()), from, to: 'ready' })
          const key = t.id + ':' + t.revision
          // 2026-11-06 用户要求：Codex 完成后**不再给决策人发「请验收」提醒**（改由 judge 审），
          // 需要时把 config.codexReadyNotify 设为 true 可恢复。
          if (notifyCodexReady && !s.outbox.some((o) => o.key === key)) {
            s.outbox.push({
              key,
              ticketId: t.id,
              revision: t.revision,
              sessionId: t.sessionId || DEFAULT_SESSION || '',
              prompt: '【superagent】工单 ' + t.id + ' 已就绪（Codex 回合结束）：' + t.title + '。请验收产物与证据：通过则置 done；不通过则置 blocked 并写明缺什么。' + judgeSummary(t),
              enqueuedAt: iso(now()),
              sentAt: null,
              attempts: 0,
            })
          }
          matched++
          log('codex done -> ready ' + t.id)
        } catch {}
      }
      s.codexOffset += consumed
      save(s)
      return { matched }
    },

/* ============================================================
 * 注释切片 # 3 / 4  —— 源文件 handoff/dist/dsh-plugin-superagent-lite/index.js
 * 原始行号：1731 – 2929（1199 行）
 * 任务：本文件内只新增「整行注释」，不改任何代码字符。整行注释 = 以双斜杠开头的整行，
 *       或独立成块的星号注释（首行仅含斜杠星号、末行仅含星号斜杠）。行内尾注也算，但别改代码本身。
 * 禁碰：handoff/annotate/slices（原始副本）｜handoff/dist（在跑的代码）｜~/.dsh（宿主配置）
 * 自检：node handoff/annotate/verify-slice.mjs 3   → 末行必须是 SLICE 3: PASS
 * ============================================================ */
    // 全局体检快照：面板顶部那排数字全部来自这里，只读不写盘。
    // 注意 backlog 用的 staleMs 与 watchdog 判「积压」是同一阈值——两处若各写各的，面板会和告警打架。
    // concurrency 由 CONC.maxConcurrent 拼字符串返回（如 "1/1"），是给人看的，不是给程序算的。
    status() {
      const s = load()
      const count = (st) => s.tickets.filter((t) => t.state === st).length
      // sa-202 C：积压 = queued 且超过 dispatchStaleMin 未派（与 watchdog 同一阈值）
      const staleMinRaw = Number(typeof svc._dispatchStaleMin === 'function' ? svc._dispatchStaleMin() : 15)
      const staleMs = (Number.isFinite(staleMinRaw) && staleMinRaw >= 0 ? staleMinRaw : 15) * 60000
      const tNow = now()
      const backlog = s.tickets.filter((t) => t.state === 'queued' && (tNow - Date.parse(t.updatedAt)) > staleMs).length
      const pending = s.outbox.filter(isPendingOutbox).length
      const last = s.outbox.filter((o) => o.sentAt).slice(-1)[0]
      const bySess = {}
      for (const t of s.tickets) { const k = t.sessionId || '(none)'; bySess[k] = (bySess[k] || 0) + 1 }
      return {
        ok: true,
        tickets: s.tickets.length,
        queued: count('queued'),
        running: count('running'),
        ready: count('ready'),
        done: count('done'),
        blocked: count('blocked'),
        backlog,
        pendingOutbox: pending,
        lastSent: last ? last.key + '@' + last.sentAt : null,
        concurrency: s.tickets.filter((t) => t.state === 'running').length + '/' + CONC.maxConcurrent,
        sessions: bySess,
        defaultSession: DEFAULT_SESSION || null,
        stateDir,
        stateFile,
      }
    },

    // M5：面板数据侧——给人看的队列明细（只读）
    // 排序键 order 的顺序是**故意**的：running 在最前（要盯活），done 最后（已无信息量）。
    // 同状态内按 updatedAt 倒序，所以刚动过的单浮上来；未知状态兜底 9 排最后，不占前排也不报错。
    list(opts = {}) {
      const s = load()
      const limit = Math.max(1, Number(opts.limit || 20))
      const order = { running: 0, ready: 1, queued: 2, blocked: 3, done: 4 }
      const rows = s.tickets.slice().sort((a, b) => {
        const d = (order[a.state] == null ? 9 : order[a.state]) - (order[b.state] == null ? 9 : order[b.state])
        return d !== 0 ? d : String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      }).slice(0, limit)
      const tNow = now()
      return rows.map((t) => ({
        id: t.id,
        state: t.state,
        title: String(t.title || '').slice(0, 80),
        backend: t.backend || null,
        revision: Number(t.revision || 0),
        updatedAt: t.updatedAt,
        workerFinal: !!t.workerFinalAt,
        requirements: Array.isArray(t.requirements) ? t.requirements.length : 0,
        ageMin: Math.max(0, Math.round((tNow - Date.parse(t.updatedAt)) / 60000)),
        childId: t.childId || null,
        sessionId: t.sessionId || null,
        session: shortSid(t.sessionId || DEFAULT_SESSION),
        evidence: evidenceFor(t),
        evidenceKind: (evidenceInfo(t) || {}).kind || null,
        artifacts: manifestOf(t).length,
      }))
    },
  }
  return svc
}

export function apply(ctx, config = {}) {
  const stateDir = config.stateDir || DEFAULT_STATE_DIR
  // 先建目录：全新目录首次启动时，后面 ensureRoles 写 owners.json 会 ENOENT 被 catch 吞掉 →
  // owners 永远空 → 所有写工具被拒（dist 版同样修复；生产因为目录早存在所以没暴露）
  try { mkdirSync(stateDir, { recursive: true }) } catch {}
  const logFile = join(stateDir, 'lite.log')
  const log = (m) => {
    try { mkdirSync(stateDir, { recursive: true }); appendFileSync(logFile, new Date().toISOString() + ' ' + m + '\n', 'utf8') } catch {}
  }

  let schedule = null
  try { ctx.inject(['schedule'], (c) => { schedule = c.schedule }) } catch { schedule = null }
  let subagents = null
  try { ctx.inject(['subagents'], (c) => { subagents = c.subagents }) } catch { subagents = null }
  // sa-201：sessionController 是**可选**注入 —— 拿不到时 sa_new_session 明确报错，其余工具不受影响
  let sessionController = null
  try { ctx.inject(['sessionController'], (c) => { sessionController = c.sessionController }) } catch { sessionController = null }
  // sa-209（lite2）：压缩另一个会话 —— /compact 是宿主命令插件，走 commands.execute(agent,'/compact')
  // 证据：@deepseek-ai/dsh-command-compact = ctx.compaction.compactNow(agent,signal,commandId)；
  //        @deepseek-ai/dsh-commands.execute(agent,line,attachments,signal) 不过模型，并留 command/run + command/done 日志
  let commandsSvc = null
  try { ctx.inject(['commands'], (c) => { commandsSvc = c.commands }) } catch { commandsSvc = null }
  let compactionSvc = null
  try { ctx.inject(['compaction'], (c) => { compactionSvc = c.compaction }) } catch { compactionSvc = null }
  // sa-205：workspaceRegistry 也是可选注入 —— 拿不到时会话仍能建，但**不会登记进工作区索引**（UI 侧栏不显示）
  let workspaceRegistry = null
  try { ctx.inject(['workspaceRegistry'], (c) => { workspaceRegistry = c.workspaceRegistry }) } catch { workspaceRegistry = null }
  // sa-206：sessions 用来取活会话 header（indexHeader 需要带 id 的 header 对象）
  let sessionsSvc = null
  try { ctx.inject(['sessions'], (c) => { sessionsSvc = c.sessions }) } catch { sessionsSvc = null }
  const subagentProvider = config.subagentProvider || 'spawn'
  const sessionId = config.sessionId || process.env.DSH_SESSION_ID || ''

  // ── sa-199：settings.json 覆盖 patch config（单向：settings 有值优先，否则 config，否则默认）──
  //   settings.json 是面板「设置」页写的运行期文件，按 mtime 热读；改了不用重启。
  //   未配置（两处都没有）= 旧行为，完全向后兼容。
  const settingsFilePath = join(stateDir, 'settings.json')
  let settingsCache = { at: -1, value: {} }
  const readSettingsHot = () => {
    let st = null
    try { st = statSync(settingsFilePath) } catch { return settingsCache.value || {} }
    if (settingsCache.at === st.mtimeMs) return settingsCache.value || {}
    let v = {}
    try { v = JSON.parse(readFileSync(settingsFilePath, 'utf8')) } catch { v = {} }
    settingsCache = { at: st.mtimeMs, value: v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
    return settingsCache.value
  }
  // 统一取值：settings 有值 → 用它；否则 config 有值 → 用它；否则 fallback。
  // opts.check(v) 返回 false 视为「非法类型/非法值」→ 忽略该来源、回退下一层，并记一条日志（不抛）。
  // 为什么非法值只记日志不抛：这里是热读路径，面板写坏一个值不该让整个插件启动失败；
  // 但也不能静默——日志里留下 settings-<k> invalid 便于面板上「保存没生效」时定位。
  // 顺序固定 settings > config > fallback：settings 是运行期文件（改完即生效），config 是启动参数（要重载）。
  const eff = (k, fallback, opts = {}) => {
    const check = typeof opts.check === 'function' ? opts.check : null
    const s = readSettingsHot()
    if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) {
      const sv = s[k]
      if (!check || check(sv)) return sv
      log('settings-' + k + ' invalid, fallback to config/default: ' + JSON.stringify(sv).slice(0, 120))
    }
    if (Object.prototype.hasOwnProperty.call(config, k) && config[k] !== undefined) {
      const cv = config[k]
      if (!check || check(cv)) return cv
      log('config-' + k + ' invalid, fallback to default: ' + JSON.stringify(cv).slice(0, 120))
    }
    return fallback
  }

  // ── sa-194 F8：autoJudge 配置（默认 off，向后兼容）────────────────────────────
  //   config.autoJudge = '<judge 会话 id>' | true（取 owners.json judges[0]）
  //   关闭时：行为不变——进入 ready 只给 owner 投「已就绪（请验收/请派审）」outbox
  // sa-199：autoJudge 改为 settings 优先（面板写 settings 也能生效）。合法值 = boolean | 非空字符串。
  // 三态语义坑：undefined=没配(走旧行为)、false=显式关、''=空串算关（autoJudgeSid 才是真指定）。
  // 所以 autoJudgeEnabled 必须同时判 ===true 与 sid 非空，漏判一边就会出现「配了 id 却不生效」。
  const autoJudgeCfg = eff('autoJudge', undefined, {
    check: (v) => typeof v === 'boolean' || (typeof v === 'string'),
  })
  const autoJudgeSid = typeof autoJudgeCfg === 'string' ? autoJudgeCfg.trim() : ''
  const autoJudgeEnabled = autoJudgeCfg === true || autoJudgeSid !== ''

  // judge 通知模板（sa_judge 与 autoJudge 共用；skipReqBlock 用于「判据里已含需求」时避免重复）
  const buildJudgePrompt = (t, criteria, opts = {}) => {
    const id = String((t && t.id) || '')
    const arts = Array.isArray(t.artifacts) ? t.artifacts : []
    const reps = Array.isArray(t.reports) ? t.reports : []
    // sa-194 F3：工单上追加过的需求自动并进判据（逐条核对）；没有追加需求时输出与旧版完全一致
    const reqs = Array.isArray(t.requirements) ? t.requirements : []
    const reqBlock = (reqs.length && !opts.skipReqBlock)
      ? ['', '## 追加需求清单（v1..v' + reqs.length + '，逐条核对，缺任一条即 fail）',
         reqs.map((r, i) => (i + 1) + '. [v' + (r.rev || (i + 1)) + '] ' + String(r.text || '')).join(NL)]
      : []
    return [
      '【superagent 验收请求 ' + id + '】' + (t.title || ''),
      '',
      '## 验收标准',
      criteria || '（未给标准：按"交付物是否真实存在、是否满足工单标题"判断）',
      ...reqBlock,
      '',
      '## 产物清单（工单登记）',
      arts.length ? arts.map((a) => '- ' + (a.rel || a.name) + ' (' + a.bytes + 'B, by ' + (a.by || '?') + ')').join(NL) : '（无产物登记）',
      '',
      '## worker 自报',
      reps.length ? reps.map((r) => '- [' + r.sessionId.slice(0, 12) + '…] ' + r.summary).join(NL) : '（无自报）',
      '',
      '## 你要做的',
      '1) 自己核查（读产物文件、必要时跑命令），不要只信自报；',
      '2) 用 sa_verdict 下结论：sa_verdict(id=' + id + ', pass=true|false, reason=证据化的理由)；',
      '3) 不要改工单其它字段，不要替 worker 补产物。',
    ].join(NL)
  }

  // 自动判据：brief + 全部追加需求 + 证据清单 + 固定尾句（brief §13 buildCriteria）
  const autoCriteria = (t) => {
    const lines = []
    // sa-195 D：文档类（type=doc）用轻判据——仍走 judge，只是不要求测试/行号那套
    // sa-199：docJudge 开关（默认 true=保持旧行为）与 docCriteria 自定义条目（默认 []）走 settings 覆盖
    const docJudgeOn = eff('docJudge', true, { check: (v) => typeof v === 'boolean' }) !== false
    if (t.type === 'doc' && docJudgeOn) {
      lines.push('【文档改稿轻判据】')
      const custom = eff('docCriteria', [], { check: (v) => Array.isArray(v) })
      if (Array.isArray(custom) && custom.length) {
        // 自定义条目：逐条列出（保持「仍走 judge、只是判据不同」的语义）
        custom.forEach((c, i) => lines.push((i + 1) + '. ' + String(c || '')))
      } else {
        lines.push('1. 用户的指令是否被完整满足（逐条对照 brief / 追加需求）')
        lines.push('2. 改动是否只动了该动的地方（不要大改无关内容）')
        lines.push('3. 原文件是否被破坏（能打开、结构完整、编码正确、无截断）')
        lines.push('4. 改动后的文件能否被打开/解析（.docx/.md/.xlsx 至少能被对应工具读出）')
      }
    }
    if (t.brief) lines.push('【任务说明】' + String(t.brief))
    const reqs = Array.isArray(t.requirements) ? t.requirements : []
    if (reqs.length) {
      lines.push('【追加需求（逐条核对）】')
      reqs.forEach((r, i) => lines.push((i + 1) + '. [v' + (r.rev || (i + 1)) + '] ' + String(r.text || '')))
    }
    const arts = Array.isArray(t.artifacts) ? t.artifacts : []
    lines.push('【证据清单】' + (arts.length ? arts.map((a) => (a.rel || a.name) + '(' + a.bytes + 'B)').join('；') : '（尚无产物登记）'))
    lines.push('缺任一条即 fail')
    // 截断到 2000 字符：判据整段会塞进 judge 的提示词，brief 本身可能几 KB，太长会挤爆 judge 上下文。
    // 先拼完再切（不是逐条丢），保证任务说明与追加需求优先保住，牺牲的只是证据清单尾部。
    return lines.join(NL).slice(0, 2000)
  }

  // ── sa-195 C：出站回传（deliverOut）辅助 ────────────────────────────────
  // sa-199：改成惰性读取（每次调用都走 eff），这样面板改 settings.deliverOut 立即生效
  const sendbackCfgNow = () => {
    const v = eff('deliverOut', null, { check: (x) => x === null || (typeof x === 'object' && !Array.isArray(x)) })
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null
  }
  const sendbackMaxBytes = () => Number((sendbackCfgNow() && sendbackCfgNow().maxBytes) || 8 * 1024 * 1024)
  const realOrResolveLocal = (x) => { try { return realpathSync(x) } catch { return null } }
  // 回传文件必须落在 attachRoots 内、且不是敏感路径
  const checkSendbackFile = (file) => {
    const real = realOrResolveLocal(file)
    if (!real) return { ok: false, error: 'file-not-found: ' + file }
    if (ATTACH_DENY.some((re) => re.test(real))) return { ok: false, error: 'file-denied-sensitive: ' + real }
    const roots = (Array.isArray(config.attachRoots) ? config.attachRoots : []).map(String).filter(Boolean)
    if (!roots.length) roots.push(resolve(dirname(stateDir), '..'), tmpdir())
    const inside = roots.some((r) => {
      const rr = realOrResolveLocal(r) || resolve(r)
      const rel = relative(rr, real)
      if (rel === '') return true
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return false
      return true
    })
    if (!inside) return { ok: false, error: 'outside-attachRoots: ' + real + ' (roots: ' + roots.join('; ') + ')' }
    let st = null
    try { st = statSync(real) } catch {}
    if (!st || !st.isFile()) return { ok: false, error: 'not-a-file: ' + real }
    if (st.size > sendbackMaxBytes()) return { ok: false, error: 'file-too-large: ' + st.size + ' > ' + sendbackMaxBytes() }
    return { ok: true, real, name: basename(real), bytes: st.size }
  }
  const pickSendbackFiles = (t, args) => {
    const want = Array.isArray(args && args.files) ? args.files.map(String).filter(Boolean) : []
    if (want.length) return want
    const arts = Array.isArray(t.artifacts) ? t.artifacts : []
    const latest = arts.length ? arts[arts.length - 1] : null
    return latest && latest.rel ? [join(stateDir, 'evidence', String(latest.rel))] : []
  }

  // B1（2026-11-07）：judgeRotate 以前是死开关（内核 0 处引用，面板却渲染开关）。
  // 语义定稿：autoJudge 显式给了会话 id → 永远用它（显式优先，不轮换）；
  //           autoJudge === true → 用 roles.judges，judgeRotate 开则轮询，关则固定 judges[0]。
  // 游标只在内存：进程重启回到 judges[0]，不影响正确性，只重置轮换起点。
  let judgeRotateIdx = 0
  const judgeRotateOn = () => eff('judgeRotate', false, { check: (v) => typeof v === 'boolean' }) === true
  const nextJudgeSid = () => {
    if (autoJudgeSid) return autoJudgeSid
    const judges = (readRoles().judges || []).map(String).filter(Boolean)
    if (!judges.length) return ''
    if (!judgeRotateOn()) return judges[0]
    const sid = judges[judgeRotateIdx % judges.length]
    judgeRotateIdx = (judgeRotateIdx + 1) % judges.length
    log('judge-rotate pick=' + shortSid(sid) + ' nextIdx=' + judgeRotateIdx + '/' + judges.length)
    return sid
  }

  // 任何进入 ready 的路径都调它：没配 autoJudge / 没有 judge 会话 → 什么都不做（保持原行为，owner 仍收到 ready 通知）
  const maybeAutoJudge = async (id) => {
    try {
      const t = svc.find(id)
      if (!t || t.state !== 'ready') return { ok: false, skipped: 'not-ready' }
      // 2026-11-08：终审/评测类单可标 noJudge=true，ready 时不自动送审（避免同一件事被判两遍）
      if (t.noJudge === true) { log('auto-judge skipped ' + id + ' reason=noJudge-flag'); return { ok: false, skipped: 'no-judge-flag' } }
      // 幂等：judge 已分配且仍 pending / 已通知过 → 不重投（ready→blocked→ready 也不重投）
      if (t.judge && (t.judge.status === 'pending' || t.judge.notifiedAt)) return { ok: true, skipped: 'already-notified' }
      // B2：notifyReadyTo=owner 时明确不送审（用户就是不要 judge 参与这一轮）
      if (notifyReadyMode() === 'owner') { log('auto-judge skipped ' + id + ' reason=notifyReadyTo-owner'); return { ok: false, skipped: 'notify-owner' } }
      if (!autoJudgeEnabled) { log('auto-judge skipped ' + id + ' reason=autoJudge-off'); return { ok: false, skipped: 'off' } }
      // B1：选人统一走 nextJudgeSid()（显式 id 优先 / 否则按 judgeRotate 决定是否轮换）
      const sid = nextJudgeSid()
      if (!sid) { log('auto-judge skipped ' + id + ' reason=no-judge-session'); return { ok: false, skipped: 'no-judge' } }
      const criteria = autoCriteria(t)
      const a = svc.assignJudge(id, sid, criteria)
      if (!a || !a.ok) { log('auto-judge assign failed ' + id + ' ' + ((a && a.error) || '')); return { ok: false, skipped: 'assign-failed' } }
      const text = buildJudgePrompt(a.ticket || t, criteria, { skipReqBlock: true })
      await tell(sid, text, 'superagent 验收 ' + id)
      svc.markJudgeNotified(id)
      log('auto-judge ' + id + ' -> ' + sid)
      return { ok: true, judge: sid }
    } catch (e) {
      log('auto-judge error ' + id + ' ' + (e && e.message ? e.message : String(e)))
      return { ok: false, error: e && e.message }
    }
  }

  // N5：投递目标 = outbox 冻结的 sessionId → 配置默认；都没有就显式失败（不静默丢消息）
  const deliver = async (o) => {
    if (!schedule || typeof schedule.create !== 'function') throw new Error('schedule service not ready')
    const target = o.sessionId || (svc && svc.fallbackSession ? svc.fallbackSession() : sessionId)
    if (!target) throw new Error('no-session: 工单未归属会话且没有可用兜底会话')
    await schedule.create(target, { title: 'superagent 工单就绪', prompt: o.prompt, at: new Date(Date.now() + 1000).toISOString() })
  }

  const alert = async (text, sessionIdForAlert) => {
    if (!schedule || typeof schedule.create !== 'function') throw new Error('schedule service not ready')
    let target = sessionIdForAlert || (svc && svc.fallbackSession ? svc.fallbackSession() : sessionId)
    // #55：目标是 sa_run 子会话（children）时宿主拒投（subagent routing 不收 reminder），告警会丢 → 回退
    if (target && (readRoles().children || []).includes(String(target))) {
      const rr2 = readRoles()
      let fb = sessionId
      if (!fb || (rr2.children || []).includes(String(fb))) fb = (rr2.owners || [])[0] || ''
      log('alert target is a child session, fallback to ' + (fb || 'none'))
      target = fb
    }
    if (!target) throw new Error('no-session: 告警没有目标会话')
    await schedule.create(target, { title: 'superagent watchdog 告警', prompt: text, at: new Date(Date.now() + 1000).toISOString() })
  }
  // N6：把一条任务投到指定会话（跨工作区给 worker/test/judgement 派活），走同一个 schedule 通道
  const tell = async (sessionId, prompt, title) => {
    if (!schedule || typeof schedule.create !== 'function') throw new Error('schedule service not ready')
    const target = String(sessionId || '')
    if (!target) throw new Error('empty sessionId')
    const r = await schedule.create(target, { title: String(title || 'superagent 派活'), prompt: String(prompt), at: new Date(Date.now() + 1000).toISOString() })
    return r
  }

  // N7.3：坑投递走「坑投递箱」文件（handoff/pitfalls-inbox/），**不发消息、不叫醒运维会话**
  const pitfallsDir = config.pitfallsInbox || join(stateDir, '..', 'pitfalls-inbox')
  const dropPitfall = (entry) => {
    // 约定（pitfalls-inbox/README.md §1）：一批一个文件，YYYYMMDD-<投递者>.md，必须署名
    const d = new Date()
    const ymd = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
    const file = join(pitfallsDir, ymd + '-superagent-judge.md')
    mkdirSync(pitfallsDir, { recursive: true })
    const head = existsSync(file) ? '' : [
      '# 坑投递 · superagent judge（自动投递）',
      '',
      '- 投递者：superagent-lite（judge 会话自动投递，署名见每条）',
      '- 时间：' + d.toISOString(),
      '- 来源通道：judge 验收不通过 / sa_escalate',
      '- 运维按自己的节奏收（移到 received/ 并在顶部标去向），**本投递不会叫醒运维会话**',
      '',
    ].join(String.fromCharCode(10))
    appendFileSync(file, head + entry + String.fromCharCode(10), 'utf8')
    return file
  }
  const inboxPath = config.inboxFile || join(stateDir, '..', 'inbox', 'latest.md')
  // 工具 sa_ingress 与 service 必须写同一个文件（这里曾出过 ReferenceError：变量只在 service 作用域里）
  const ingressFilePath = config.ingressFile || join(stateDir, 'ingress.jsonl')

  // ---- N7 角色化权限：owner（决策）/ worker（干活交证据）/ judge（独立验收）----
  // 名单仍放数据文件，改完即时生效，不用换插件包。
  const ownersFile = join(stateDir, 'owners.json')
  let rolesCache = { at: -1, data: null }
  const rolesNote = '角色名单：owners=决策(B可派活/改状态/收口)；workers=接活并提交证据（自动派单池只轮询这里）；judges=独立验收可写 verdict；children=sa_run 派出的子会话（roleOf 认作 worker，工单 done 时回收，不进自动派单池）。改完即时生效（按 mtime 重读）'
  // sa-207 C：kinds 记 worker 的能力标签（sessionId → 'code'|'test'|'doc'|...），供自动派单按工单 type 挑人
  const emptyRoles = () => ({ owners: [], workers: [], judges: [], ops: [], children: [], models: {}, kinds: {} })
  const ensureRoles = () => {
    if (existsSync(ownersFile)) return
    const seed = Array.isArray(config.ownerSessions) ? config.ownerSessions.map(String) : []
    try { writeFileSync(ownersFile, JSON.stringify({ ...emptyRoles(), owners: seed, updatedAt: new Date().toISOString(), note: rolesNote }, null, 1), 'utf8') } catch {}
    log('roles seeded owners=' + seed.length)
  }
  const normalizeRoles = (j) => {
    const d = emptyRoles()
    if (!j || typeof j !== 'object') return d
    // 兼容老格式 { sessions: [...] }
    if (Array.isArray(j.owners)) d.owners = j.owners.map(String)
    else if (Array.isArray(j.sessions)) d.owners = j.sessions.map(String)
    if (Array.isArray(j.workers)) d.workers = j.workers.map(String)
    if (Array.isArray(j.judges)) d.judges = j.judges.map(String)
    if (Array.isArray(j.ops)) d.ops = j.ops.map(String)
    if (Array.isArray(j.children)) d.children = j.children.map(String)
    if (j.models && typeof j.models === 'object') d.models = j.models
    // sa-207 C：kinds（能力标签）。缺键 → 空对象（老文件向后兼容：没有 kind 的 worker 视为 any）
    if (j.kinds && typeof j.kinds === 'object' && !Array.isArray(j.kinds)) {
      const k = {}
      for (const [sid, v] of Object.entries(j.kinds)) {
        if (typeof v === 'string' && v.trim()) k[String(sid)] = v.trim().toLowerCase()
      }
      d.kinds = k
    }
    // 缺键才开放；键存在但类型错误时按空集合拒绝，角色写回也保留策略。
    if (Object.prototype.hasOwnProperty.call(j, 'saRunAllow')) {
      d.saRunAllow = Array.isArray(j.saRunAllow) ? j.saRunAllow.filter((v) => typeof v === 'string') : []
    }
    return d
  }
  const readRoles = () => {
    try {
      const st = statSync(ownersFile)
      if (st.mtimeMs !== rolesCache.at) rolesCache = { at: st.mtimeMs, data: normalizeRoles(JSON.parse(readFileSync(ownersFile, 'utf8'))) }
    } catch { if (!rolesCache.data) rolesCache = { at: -1, data: emptyRoles() } }
    return rolesCache.data || emptyRoles()
  }
  const writeRoles = (data) => {
    writeFileSync(ownersFile, JSON.stringify({ ...data, updatedAt: new Date().toISOString(), note: rolesNote }, null, 1), 'utf8')
    rolesCache = { at: -1, data: null }
    return readRoles()
  }
  const callerOf = (exec) => (exec && exec.agent && exec.agent.id ? String(exec.agent.id) : '')
  const roleOf = (exec) => {
    const sid = callerOf(exec)
    if (!sid) return { sid: '', role: 'none' }
    const r = readRoles()
    if (r.owners.includes(sid)) return { sid, role: 'owner' }
    if (r.judges.includes(sid)) return { sid, role: 'judge' }
    if (r.workers.includes(sid) || (r.children || []).includes(sid)) return { sid, role: 'worker' }
    if (r.ops.includes(sid)) return { sid, role: 'ops' }
    return { sid, role: 'none' }
  }
  const isOwner = (exec) => roleOf(exec).role === 'owner'
  const isJudge = (exec) => { const r = roleOf(exec).role; return r === 'judge' || r === 'owner' }
  const canSubmitEvidence = (exec, ticketId) => {
    const { sid, role } = roleOf(exec)
    if (role === 'owner') return true
    if (role !== 'worker') return false
    const t = svc && svc.find ? svc.find(ticketId) : null
    if (!t) return false
    const ass = Array.isArray(t.assignees) ? t.assignees : []
    return ass.some((a) => String(a.sessionId) === sid)
  }
  const denyFor = (exec, tool) => {
    const { sid, role } = roleOf(exec)
    log('denied ' + tool + ' caller=' + (sid || '(none)') + ' role=' + role)
    return { ok: false, detail: 'forbidden: 本会话' + (sid ? '(' + sid.slice(0, 12) + '…)' : '(未知)') + ' 当前角色=' + role + ' 无此操作权限。只读工具可用。授权：把 id 原样交给 owner（别自己加 session- 前缀），由 owner 执行 sa_role sessionId=' + (sid || '<先调 sa_whoami 拿 id>') + ' role=worker|judge|owner' }
  }
  // A（lite30）：工单 done 时回收派出的孩子 —— children 只是身份来源（roleOf 认 worker），绝不进自动派单池
  // 回收必须重复校验「不在 children 里就 return」：onTicketDone 可能被多条路径重复触发，
  // 幂等写法让重复调用变成无操作，而不是把 children 数组写成空。
  const reclaimChild = (cid) => {
    try {
      const r = readRoles()
      if (!(r.children || []).includes(cid)) return
      writeRoles({ ...r, children: r.children.filter((x) => x !== cid) })
      log('reclaim child ' + String(cid).slice(0, 12) + '（ticket done）')
    } catch (e) { log('reclaimChild failed: ' + (e && e.message ? e.message : String(e))) }
  }
  ensureRoles()
  const rr = readRoles()
  log('roles owners=' + rr.owners.length + ' workers=' + rr.workers.length + ' judges=' + rr.judges.length + ' file=' + ownersFile)
  // sa-194 §14：autoJudge 生效时，ready 不打扰 owner、verdict 后提醒一次 owner
  const autoJudgeActive = () => autoJudgeEnabled && Boolean(autoJudgeSid || String((readRoles().judges || [])[0] || ''))
  // B2（2026-11-07）：notifyReadyTo 以前也是死开关（内核 0 引用；行为硬编码为「autoJudge 开 → 只叫 judge」）。
  // 现在真读：judge（只叫 judge）/ owner（只叫 owner，不送审）/ both；默认值沿用旧行为，保证向后兼容。
  const notifyReadyMode = () => {
    const dflt = autoJudgeActive() ? 'judge' : 'owner'
    const v = eff('notifyReadyTo', dflt, { check: (x) => ['judge', 'owner', 'both'].includes(String(x)) })
    return String(v || dflt)
  }
  // sa-199：quietSources / deliverOut 也走 settings 覆盖（面板改了热生效）
  const quietSourcesEff = () => {
    const v = eff('quietSources', [], { check: (x) => Array.isArray(x) })
    return Array.isArray(v) ? v.map(String).filter(Boolean) : []
  }
  const svc = createService({ stateDir, log, deliver, now: () => Date.now(), queueDir: config.queueDir || '', readyOwnerNotify: () => { const m = notifyReadyMode(); return m === 'owner' || m === 'both' }, verdictOwnerNotify: () => autoJudgeActive(), quietSources: quietSourcesEff(), deliverOut: sendbackCfgNow(), maxAutoRework: eff('maxAutoRework', 1, { check: (v) => Number.isFinite(Number(v)) && Number(v) >= 0 }), dispatchStaleMin: eff('dispatchStaleMin', 15, { check: (v) => Number.isFinite(Number(v)) && Number(v) >= 0 }), inboxFile: inboxPath, alert, policy: config.policy || null, concurrency: config.concurrency || null, defaultSessionId: sessionId, onTicketDone: (t) => { if (!t) return; const ids = Array.isArray(t.childrenIds) && t.childrenIds.length ? t.childrenIds : (t.childId ? [t.childId] : []); for (const cid of ids) reclaimChild(String(cid)) }, ingressFile: ingressFilePath, notifyCodexReady: config.codexReadyNotify === true, attachRoots: config.attachRoots, attachMaxBytes: config.attachMaxBytes, pruneCaps: config.pruneCaps, autoDispatchEnabled: config.autoDispatch === true, autoDispatchMsDefault: config.autoDispatchMs || 15000 })
  const baselineAt = svc.ensureBaseline()
  log('loaded(N5/lite) fixes=A-E,#55,#56,#47,#57,#58,#59,#60,R1,R4,R5,R2,R3,archiveOne,fastCommands,panel-close,epochIds,archive,restore,ticketType,failStay,timeout5m,settings,autoDispatchSetting,codexReadyNotify=' + (config.codexReadyNotify === true ? 'on' : 'off') + ' watchdogAlerts=' + (config.watchdogAlerts !== false ? 'on' : 'off') + ' stateDir=' + stateDir + ' defaultSession=' + (sessionId || '(none)') + ' watchdogMs=' + (config.watchdogMs || 60000) + ' sa_runModel=request.agentOptions childWorkerRole=on autoDispatch=' + (config.autoDispatch === true ? 'on' : 'off'))

  try {
    ctx.inject(['tools'], (injected) => {
      const reg = injected && injected.tools && injected.tools.register
      if (typeof reg !== 'function') { log('no tools service'); return }
      const registeredToolNames = []
      // 本地 facade，不覆盖宿主共享 tools.register；保留宿主方法的 this。
      const child = { tools: { register(definition) {
        const result = reg.call(injected.tools, definition)
        registeredToolNames.push(definition.name)
        return result
      } } }
      child.tools.register({
        name: 'sa_status',
        description: '查看 superagent-lite 工单概况（各状态数量、待投递 outbox、状态文件路径）',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args, exec) => {
          svc.touchCaller(callerOf(exec))
          const s = svc.status()
          const sess = Object.entries(s.sessions || {}).map(([k, v]) => (k === '(none)' ? 'none' : k.slice(0, 10) + '…') + '=' + v).join(',')
          return { ok: true, detail: 'tickets=' + s.tickets + ' queued=' + s.queued + ' running=' + s.running + ' ready=' + s.ready + ' done=' + s.done + ' blocked=' + s.blocked + ' backlog=' + (s.backlog || 0) + '（排队 ' + s.queued + ' / 积压 ' + (s.backlog || 0) + '）' + ' pendingOutbox=' + s.pendingOutbox + ' | sessions: ' + (sess || 'none') + ' | default=' + (s.defaultSession ? s.defaultSession.slice(0, 10) + '…' : '(none)') }
        },
      })
      child.tools.register({
        name: 'sa_submit',
        description: '提交一个 superagent 工单（初始为 queued），返回工单 id',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', description: '工单标题（一句话）' },
            priority: { type: 'number', description: '优先级 1-9（9 最急），默认 5' },
            sessionId: { type: 'string', description: 'N5：归属会话 id；省略则自动记当前调用会话（exec.agent.id）' },
            auto: { type: 'boolean', description: 'sa-202：true = 允许自动派单（插件 tick 把它扇出给已登记的 worker 会话）。**默认 true**（可由 config/settings 的 autoDispatchDefault 改）；显式传 false 可关单片' },
            noJudge: { type: 'boolean', description: '2026-11-08：true = 进入 ready 时不自动送审（用于终审/汇总这类不该再被判一遍的单）。默认 false' },
            type: { type: 'string', enum: ['test', 'code', 'office', 'doc'], description: '工单类型（面板筛选用）。test=测试/冒烟/验收，code=编码，office=文档表格演示图片这类轻活，doc=文档改稿类（sa-195：judge 用轻判据）；不填按标题推断' },
          },
          required: ['title'],
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_submit')
          const caller = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
          const sid = args && args.sessionId ? String(args.sessionId) : caller
          // sa-202：auto 缺省改为「跟 autoDispatchDefault（默认 true）」；显式传了就以显式值优先
          const autoDefault = eff('autoDispatchDefault', true, { check: (v) => typeof v === 'boolean' }) !== false
          const autoVal = typeof (args && args.auto) === 'boolean' ? args.auto : autoDefault
          const t = svc.submit(args && args.title, args && args.priority, sid, autoVal, args && args.type, args && args.noJudge === true)
          return { ok: true, detail: 'created ' + t.id + ' state=' + t.state + ' type=' + (t.type || 'code') + ' priority=' + t.priority + ' session=' + (sid ? sid.slice(0, 12) + '…' : '(none)') + (args && args.sessionId ? ' (explicit)' : ' (caller)') + (t.auto ? ' auto=true' : ' auto=false') + (t.noJudge ? ' noJudge=true' : '') }
        },
      })
      child.tools.register({
        name: 'sa_advance',
        description: '推进工单状态：queued→running→ready→done，任意态可→blocked；进入 ready 会入 outbox 等待投递',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id，如 sa-001' },
            to: { type: 'string', enum: ['queued', 'running', 'ready', 'done', 'blocked'] },
            reason: { type: 'string', description: '置 blocked 时写进 blockedReason，便于复盘' },
          },
          required: ['id', 'to'],
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_advance')
          const r = svc.advance(String(args && args.id), String(args && args.to), args && args.reason)
          if (!r.ok) return { ok: false, detail: r.error }
          const t = r.ticket
          // sa-194 F8：任何进入 ready 的路径都尝试自动送审（未配置时 autoJudge 内部直接跳过，行为不变）
          let auto = null
          if (t.state === 'ready') { try { auto = await maybeAutoJudge(t.id) } catch {} }
          return { ok: true, detail: t.id + ' state=' + t.state + (r.noop ? ' (noop)' : '') + (auto && auto.ok ? '（已自动送审 ' + String(auto.judge).slice(0, 12) + '…）' : '') }
        },
      })
      child.tools.register({
        name: 'sa_run',
        description: '把 queued 工单派给一个 DSH 子代理执行（执行体=subagents 的 spawn provider）；成功后工单转 running 并记录 childId',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id（省略则自动挑 queued 里优先级最高的）' },
            provider: { type: 'string', description: '可选：子会话的 provider（如 qodercn / trae）；给了 model 才生效' },
            model: { type: 'string', description: '可选：子会话的 model（如 qfmodel / kimi-k3）；父会话必须先有模型策略（新会话），否则报 child model selection is disabled' },
            reasoning_effort: { type: 'string', description: '可选：推理强度（low/medium/high）；与 provider+model 一起给' },
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_run')
          let id = args && args.id ? String(args.id) : ''
          if (!id) {
            const next = svc.pickNext()
            if (!next) return { ok: false, detail: 'no queued ticket' }
            id = next.id
          }
          const conc = svc.concurrency()
          if (conc.full) return { ok: false, detail: 'concurrency full (' + conc.running + '/' + conc.max + ')，等当前工单收口再派' }
          const ticket = svc.find ? svc.find(id) : null
          const cur = ticket || { id }
          if (!subagents || typeof subagents.startActivation !== 'function') return { ok: false, detail: 'subagents service unavailable' }
          if (!exec || !exec.agent) return { ok: false, detail: 'no calling agent (exec.agent)' }
          const promptText = '【superagent 工单 ' + id + '】' + (cur.title || '') + '\n\n请完成这张工单并在结束时给出：做了什么、证据（命令/文件/行号）、未决项。完成后由 router 验收。'
          try {
            // 2026-11-06：模型路由必须放 request.agentOptions（camelCase reasoningEffort）。
            // 依据：宿主 app.asar @91809xxx 里官方 subagent 工具就是这么传的——
            //   request = { prompt, parent, ...(agentOptions ? { agentOptions } : {}) }
            // lite26 曾把 provider/model 直接塞 request 顶层，实测被静默忽略
            // （子会话 descriptor 仍是父级 deepseek-flash），故此处改正。
            const wantProvider = args && args.provider != null ? String(args.provider).trim() : ''
            const wantModel = args && args.model != null ? String(args.model).trim() : ''
            const wantEffort = args && args.reasoning_effort != null ? String(args.reasoning_effort).trim() : ''
            if (Boolean(wantProvider) !== Boolean(wantModel)) return { ok: false, detail: 'provider 与 model 必须成对给（只给一个会被宿主忽略）' }
            const runRoles = readRoles()
            if (!Object.prototype.hasOwnProperty.call(runRoles, 'saRunAllow')) {
              log('sa-run open (saRunAllow absent)')
            } else if (!wantProvider || !wantModel || !runRoles.saRunAllow.some((v) => v === wantProvider + '/' + wantModel || v === wantModel)) {
              return { ok: false, detail: 'sa-run-denied: ' + wantProvider + '/' + wantModel + ' 不在 owners.json saRunAllow' }
            }
            const childAgentOptions = {}
            if (wantProvider && wantModel) { childAgentOptions.provider = wantProvider; childAgentOptions.model = wantModel }
            if (wantEffort) childAgentOptions.reasoningEffort = wantEffort
            const hasChildRoute = Boolean(childAgentOptions.provider || childAgentOptions.reasoningEffort)
            const r = await subagents.startActivation({
              provider: subagentProvider,
              label: 'superagent ' + id,
              request: Object.assign({ prompt: [{ type: 'text', text: promptText }], parent: exec.agent }, hasChildRoute ? { agentOptions: childAgentOptions } : {}),
              signal: exec.signal,
              delivery: 'parent',
            })
            const childId = r && (r.childId || r.subagentId)
            // E（lite30）：host 没回 childId → 不把 "undefined" 写进工单，不继续 advance；记一次失败
            if (!childId) {
              log('sa_run ' + id + ' no childId from host')
              const att0 = svc.recordRunFailure(id)
              return { ok: false, detail: 'no childId from host（第 ' + (att0 ? att0.attempts : '?') + ' 次失败，工单仍是 queued）' }
            }
            const a = svc.attachChild(id, String(childId))
            if (!a.ok) return { ok: false, detail: a.error }
            // #46A（lite30/A）：孩子要有 worker 身份才能 attach/report —— 但登记进独立的 children 字段，
            // 绝不进 workers：workers 是自动派单池（autoDispatchTick 只轮询 workers），
            // 死孩子留在池里会占住 concurrency=1 把整条队列堵到 20 分钟超时。
            let granted = false
            try {
              const cid = String(childId)
              const rr = readRoles()
              if (!(rr.children || []).includes(cid)) { writeRoles({ ...rr, children: [...(rr.children || []), cid] }); granted = true }
            } catch (e) { log('grant child role failed: ' + (e && e.message ? e.message : String(e))) }
            if (granted) log('grant-child ' + String(childId).slice(0, 12) + ' for ' + id)
            svc.advance(id, 'running')
            return { ok: true, detail: id + ' running child=' + childId + (granted ? ' (+child)' : '') }
          } catch (e) {
            log('sa_run failed ' + (e && e.message ? e.message : String(e)))
            const base = 'startActivation failed: ' + (e && e.message ? e.message : String(e))
            // lite44：失败单直接留在「错误」列并留证据，不再重试/重派
            const fr = svc.failTicket(id, base)
            if (fr && fr.ok) return { ok: false, detail: base + '（工单已置 blocked 并留下 error-evidence.md，不自动重试）' }
            return { ok: false, detail: base + '（置 blocked 失败：' + ((fr && fr.error) || 'unknown') + '）' }
          }
        },
      })
            child.tools.register({
        name: 'sa_delegate_codex',
        description: '把 queued 工单转给 Codex：写 handoff/inbox/latest.md（含 sa-ticket 标记），工单转 running(backend=codex)；Codex 回合结束的 Stop 事件会自动把它推 ready',
        parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: '工单 id' } }, required: ['id'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_delegate_codex')
          const id = String(args && args.id)
          const t = svc.find(id)
          if (!t) return { ok: false, detail: 'no-such-ticket: ' + id }
          if (t.state !== 'queued') return { ok: false, detail: 'not-queued: ' + t.state }
          const md = [
            '# Handoff: superagent 工单 ' + id + ' — ' + t.title,
            '',
            '- sa-ticket: ' + id,
            '- backend: codex',
            '- 状态: running',
            '',
            '## 任务',
            t.title,
            '',
            '## 完成要求',
            '1. 完成上面这件事；把结论/改动/证据写进 handoff/superagent/codex-' + id + '.md。',
            '2. **不要改本文件**（Stop 钩子靠它通知 router）。',
            '3. 不要自行把工单置 done；router 验收后收口。',
            ''
          ].join('\n')
          try {
            mkdirSync(dirname(inboxPath), { recursive: true })
            writeFileSync(inboxPath, md, 'utf8')
          } catch (e) { return { ok: false, detail: 'write handoff failed: ' + (e && e.message ? e.message : String(e)) } }
          const d = svc.delegate(id, 'codex')
          if (!d.ok) return { ok: false, detail: d.error }
          return { ok: true, detail: id + ' running(backend=codex) handoff=' + inboxPath }
        },
      })
      child.tools.register({
        name: 'sa_watchdog',
        description: '立刻跑一次 watchdog 巡检，返回问题清单：running 超 20 分钟无变更 / ready 无证据文件 / done 无产物。默认只检查不告警；dryRun=false 才真的发一条告警',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { dryRun: { type: 'boolean', description: 'true（默认）=只检查不告警；false=检查并发告警（同一问题只发一次）' } },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args, exec) => {
          // sa_watchdog 的 dryRun 语义是「默认只读」：只有显式 dryRun===false 才算要真发告警。
          // 写操作才查权限，只读巡检人人可跑——否则 worker 连自检都要惊动 owner。
          const dry = !(args && args.dryRun === false)
          // 只读巡检人人可用；真发告警算写操作（会打扰别人）
          if (!dry && !isOwner(exec)) return denyFor(exec, 'sa_watchdog(dryRun=false)')
          const r = await svc.watchdogTick({ dryRun: dry })
          const list = r.findings.map((f) => f.ticketId + ':' + f.reason).join(',') || 'none'
          return { ok: true, detail: 'findings=' + r.findings.length + ' [' + list + '] fresh=' + r.fresh.length + ' alerted=' + r.alerted + ' baseline=' + r.baselineAt }
        },
      })
      child.tools.register({
        name: 'sa_list',
        description: '列出工单明细（running→ready→queued→blocked→done 顺序，同状态按最近变更排）：id/状态/后端/距上次变更分钟/证据有无/标题',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { limit: { type: 'number', description: '最多返回几条，默认 20' } },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args) => {
          const rows = svc.list({ limit: args && args.limit })
          if (!rows.length) return { ok: true, detail: 'no tickets' }
          const lines = rows.map((r) => r.id + '  ' + r.state + (r.backend ? '(' + r.backend + ')' : '') + '  ' + r.ageMin + 'm  rev=' + r.revision + '  art=' + r.artifacts + (r.evidenceKind ? '(' + r.evidenceKind + ')' : '') + '  sess=' + r.session + '  ' + r.title + (r.workerFinal ? '  已自报' : ''))
          return { ok: true, detail: rows.length + ' ticket(s):\n' + lines.join('\n') }
        },
      })
      child.tools.register({
        name: 'sa_ingress',
        description: '往 ingress 队列投一条外部事件（source/key/title/body），插件会在 2s 内按 key 去重后建工单；用于验收与手工触发',
        parameters: { type: 'object', additionalProperties: false, properties: { source: { type: 'string', description: '来源，如 qq / cron / github' }, key: { type: 'string', description: '去重键，如同一事件重复投只建一单' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['source', 'key', 'title'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_ingress')
          try {
            const caller = callerOf(exec)
            const rec = { at: new Date().toISOString(), source: String(args.source), key: String(args.key), title: String(args.title), body: String(args.body || '') }
            if (caller) rec.sessionId = caller
            appendFileSync(ingressFilePath, JSON.stringify(rec) + '\n', 'utf8')
            return { ok: true, detail: 'queued ingress ' + rec.source + '/' + rec.key }
          } catch (e) { return { ok: false, detail: 'write ingress failed: ' + (e && e.message ? e.message : String(e)) } }
        },
      })
      child.tools.register({
        name: 'sa_next',
        description: '只读：看下一张会被派出去的工单（priority 高者优先，同优先级先来先跑），以及当前并发占用',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async () => {
          const next = svc.pickNext()
          const c = svc.concurrency()
          if (!next) return { ok: true, detail: 'no queued ticket; running=' + c.running + '/' + c.max }
          return { ok: true, detail: 'next=' + next.id + ' priority=' + next.priority + ' title=' + String(next.title || '').slice(0, 60) + ' | running=' + c.running + '/' + c.max }
        },
      })
      child.tools.register({
        name: 'sa_role',
        description: 'N7 决策：给会话分配角色 —— owner(决策) / worker(接活交证据) / judge(独立验收) / none(收回)。仅 owner 可调',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: '目标会话 id（原样，别加 session- 前缀）' },
            role: { type: 'string', enum: ['owner', 'worker', 'judge', 'ops', 'none'], description: '要设的角色：owner 决策 / worker 接活交证据 / judge 独立验收 / ops 运维（收坑报告）' },
            model: { type: 'string', description: '可选：该会话当前跑的模型标记（如 qfmodel=Qwen3.8-Flash 免费档、deepseek-flash），便于按任务挑人' },
            kind: { type: 'string', description: 'sa-207 C：可选能力标签（code/test/doc…），autoDispatch 按工单 type 挑人；不填=any（向后兼容）' },
          },
          required: ['sessionId', 'role'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_role')
          const sid = String((args && args.sessionId) || '').trim()
          const role = String((args && args.role) || '')
          if (!/^(session-)?[0-9a-zA-Z][0-9a-zA-Z-]{7,}$/.test(sid)) return { ok: false, detail: 'bad sessionId: ' + sid }
          if (!['owner', 'worker', 'judge', 'ops', 'none'].includes(role)) return { ok: false, detail: 'bad role: ' + role }
          const r = readRoles()
          const without = { owners: r.owners.filter((x) => x !== sid), workers: r.workers.filter((x) => x !== sid), judges: r.judges.filter((x) => x !== sid), ops: r.ops.filter((x) => x !== sid), children: (r.children || []).filter((x) => x !== sid) }
          if (role === 'owner' && r.owners.length === 1 && r.owners[0] === sid) return { ok: false, detail: '拒绝：这是最后一个 owner' }
          // 字段名映射：ops 的复数字段就是 ops（不能靠 role+'s'，会拼成 opss）
          const FIELD = { owner: 'owners', worker: 'workers', judge: 'judges', ops: 'ops' }
          const field = FIELD[role]
          const next = role === 'none' ? without : { ...without, [field]: [...without[field], sid] }
          next.models = { ...(r.models || {}) }
          const model = String((args && args.model) || '').trim()
          if (model) next.models[sid] = model
          else if (role === 'none') delete next.models[sid]
          // sa-207 C：可选 kind（能力标签，供自动派单按工单 type 挑人）
          // 「不传 kind」与「role=none」是两种意图：前者保留原 kind（方便临时调角色），
          // 后者才删 kind —— 否则一次误传 role 就把能力标签冲掉，自动派单会把它当 any 乱派。
          next.kinds = { ...(r.kinds || {}) }
          const kind = String((args && args.kind) || '').trim().toLowerCase()
          if (kind && role !== 'none') {
            if (!/^[a-z0-9_-]{1,20}$/.test(kind)) return { ok: false, detail: 'bad kind: ' + kind }
            next.kinds[sid] = kind
          } else if (role === 'none' || !kind) {
            if (role === 'none') delete next.kinds[sid]
          }
          writeRoles(next)
          log('role ' + role + ' ' + sid + (next.kinds[sid] ? ' kind=' + next.kinds[sid] : '') + ' by=' + callerOf(exec).slice(0, 12))
          return { ok: true, detail: sid + ' -> ' + role + (next.kinds[sid] ? ' (kind=' + next.kinds[sid] + ')' : '') + ' | owners=' + next.owners.length + ' workers=' + next.workers.length + ' judges=' + next.judges.length }
        },
      })
      child.tools.register({
        name: 'sa_agents',
        description: 'N7 只读：列出 owner/worker/judge 各是谁、各自登记的模型，用来按任务挑人（机械活派免费档、重活派强模型）',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async () => {
          const r = readRoles()
          const models = r.models || {}
          const kinds = r.kinds || {}
          const fmt = (arr, tag) => arr.length ? arr.map((s) => {
            const mo = models[s] ? '(' + models[s] + ')' : ''
            const kd = kinds[s] ? '[' + kinds[s] + ']' : '[any]'
            return tag + ':' + s.slice(0, 14) + '…' + kd + mo
          }).join('  ') : '(空)'
          return { ok: true, detail: 'owners  ' + fmt(r.owners, 'o') + ' | workers ' + fmt(r.workers, 'w') + ' | judges ' + fmt(r.judges, 'j') + ' | ops ' + fmt(r.ops || [], 'p') + ' | （[kind]=能力标签，[any]=未设=可接任意类型）' }
        },
      })
      child.tools.register({
        name: 'sa_fanout',
        description: 'N7 决策：把 queued 工单派给一个或多个 worker 会话（我决定派给哪几个 AI），工单转 running 并记录 assignees。仅 owner',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id' },
            sessionIds: { type: 'array', items: { type: 'string' }, description: 'worker 会话 id 列表（与 models 二选一）' },
            brief: { type: 'string', description: '任务说明（会给每个 worker 发）' },
            models: {
              type: 'array',
              description: '#47 多模型扇出：每个模型起一个子会话干这单（与 sessionIds 二选一）。例 [{provider:qodercn, model:qfmodel, reasoning_effort:low}, {provider:trae, model:glm-5.3}]',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  provider: { type: 'string' }, model: { type: 'string' },
                  reasoning_effort: { type: 'string' }, label: { type: 'string' }
                },
              },
            },
          },
          required: ['id'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_fanout')
          const id = String((args && args.id) || '')
          const brief = String((args && args.brief) || '')
          // #47 多模型扇出：给了 models 就每个模型起一个子会话（走 request.agentOptions），否则走原 sessionIds 路径
          const models = Array.isArray(args && args.models) ? args.models.filter((m) => m && (m.provider || m.model)) : []
          if (models.length) {
            if (!subagents || typeof subagents.startActivation !== 'function') return { ok: false, detail: 'subagents service unavailable（多模型扇出需要它）' }
            if (!exec || !exec.agent) return { ok: false, detail: 'no calling agent (exec.agent)' }
            const tk = svc.find ? svc.find(id) : null
            if (!tk) return { ok: false, detail: 'no-such-ticket: ' + id }
            if (tk.state !== 'queued') return { ok: false, detail: 'not-queued: ' + tk.state }
            const conc0 = svc.concurrency()
            if (conc0.full) return { ok: false, detail: 'concurrency full (' + conc0.running + '/' + conc0.max + ')，等当前工单收口再派' }
            const nl0 = String.fromCharCode(10)
            const text = '【多模型扇出 ' + id + '】' + (tk.title || '') + nl0 + nl0 + (brief || '（无附加说明）') + nl0 + nl0 + '交付：做完调 sa_attach（id=' + id + '）交证据 + sa_report 自报；工单状态与验收由 owner/judge 负责。'
            const spawned = []
            const failed = []
            for (const m of models) {
              const ao = {}
              if (m.provider && m.model) { ao.provider = String(m.provider); ao.model = String(m.model) }
              if (m.reasoning_effort) ao.reasoningEffort = String(m.reasoning_effort)
              try {
                const rr0 = await subagents.startActivation({ provider: subagentProvider, label: 'fanout ' + id + ' ' + String(m.label || m.model || m.provider || ''), request: Object.assign({ prompt: [{ type: 'text', text }], parent: exec.agent }, Object.keys(ao).length ? { agentOptions: ao } : {}), signal: exec.signal, delivery: 'parent' })
                const cid = rr0 && (rr0.childId || rr0.subagentId)
                if (cid) {
                  spawned.push(String(cid))
                  const registered = svc.attachChildren(id, [String(cid)])
                  if (!registered.ok) failed.push(String(m.model || m.provider || '?') + ':register:' + registered.error)
                } else failed.push(String(m.model || m.provider || '?') + ':no-childId')
              } catch (e) { failed.push(String(m.model || m.provider || '?') + ':' + (e && e.message ? e.message : String(e))) }
            }
            if (!spawned.length) return { ok: false, detail: 'multi-model spawn failed: ' + failed.join('; ') }
            const fr = svc.attachChildren(id, spawned)
            if (!fr.ok) return { ok: false, detail: 'attachChildren failed: ' + fr.error + (failed.length ? ' | failed=' + failed.join('; ') : '') }
            try {
              const rr1 = readRoles()
              const nextChildren = [...(rr1.children || [])]
              for (const cid of spawned) if (!nextChildren.includes(cid)) nextChildren.push(cid)
              writeRoles({ ...rr1, children: nextChildren })
            } catch (e) { log('grant children failed: ' + (e && e.message ? e.message : String(e))) }
            svc.advance(id, 'running')
            const registeredCount = new Set(spawned.filter((cid) => (fr.ticket.childrenIds || []).includes(cid))).size
            log('fanout-models ' + id + ' models=' + models.length + ' children=' + spawned.map((s) => s.slice(0, 8)).join(',') + ' registered=' + registeredCount)
            return { ok: true, detail: id + ' multi-model ' + spawned.length + '/' + models.length + ' children=' + spawned.map((s) => s.slice(0, 8)).join(',') + (failed.length ? ' | failed=' + failed.join('; ') : '') }
          }
          const list = Array.isArray(args && args.sessionIds) ? args.sessionIds.map(String) : []
          const r = svc.fanout(id, list, brief)
          if (!r.ok) return { ok: false, detail: r.error }
          const lines = []
          for (const sid of list) {
            const nl = String.fromCharCode(10)
            const text = '【superagent 工单 ' + id + '】' + (r.ticket.title || '') + nl + nl + (brief || '（无附加说明）') + nl + nl + '交付要求：' + nl + '1) 做完后调 sa_attach（id=' + id + '）把你的产物/证据写进工单；' + nl + '2) 再调 sa_report（id=' + id + '，summary=你做了什么、证据在哪）自报；' + nl + '3) 不要自己改工单状态、不要自己判通过 —— 验收由 judge 会话独立做。'
            try { await tell(sid, text, 'superagent 派活 ' + id); lines.push('sent->' + sid.slice(0, 12) + '…') }
            catch (e) { lines.push('FAIL->' + sid.slice(0, 12) + '… ' + (e && e.message)) }
          }
          log('fanout-notify ' + id + ' ' + lines.join(' '))
          return { ok: true, detail: id + ' assigned=' + list.length + ' | ' + lines.join(' | ') }
        },
      })
      child.tools.register({
        name: 'sa_progress',
        description: 'sa-207：心跳——刷新工单 updatedAt、记一条 progress、把刚计数归零。owner / 该单 assignee / judge 可调。长活（改代码、跑测试超过 10 分钟）每 5~10 分钟调一次，防 policy 把 running 误判成超时。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id，如 sa-014' },
            note: { type: 'string', description: '可选：这一轮在干什么（截断 200 字，供人看）' },
          },
          required: ['id'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          const id = String((args && args.id) || '')
          const { sid, role } = roleOf(exec)
          // RBAC：owner / judge / 该单 assignee（含 child）可调；其它人拒
          let allowed = role === 'owner' || role === 'judge'
          if (!allowed && role === 'worker') {
            const t = svc.find(id)
            const ass = Array.isArray(t && t.assignees) ? t.assignees : []
            allowed = ass.some((a) => String(a.sessionId) === sid)
          }
          if (!allowed) return denyFor(exec, 'sa_progress')
          const r = svc.progress(id, String((args && args.note) || ''), sid)
          if (!r.ok) return { ok: false, detail: r.error }
          return { ok: true, detail: id + ' progress #' + r.count + '（updatedAt 已刷新，staleChecks 归零）' }
        },
      })
      child.tools.register({
        name: 'sa_compact',
        description: 'sa-209：压缩指定会话的上下文（等价于在该会话里手打 /compact，不经过模型）。owner-only。要求目标会话空闲（无进行中的回合）；冷会话会被宿主 resume。压缩完返回 Compacted N items (~M tokens)。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: '目标会话 id（session-…）；与 id 二选一' },
            id: { type: 'string', description: '工单 id：自动取该单第一个 assignee 的会话' },
          },
          required: [],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) =>
          [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          const { sid, role } = roleOf(exec)
          if (role !== 'owner') return denyFor(exec, 'sa_compact')
          if (!sessionController || typeof sessionController.resolveAgent !== 'function') {
            return { ok: false, detail: '宿主未提供 sessionController.resolveAgent（无法定位目标会话的 Agent）' }
          }
          if (!commandsSvc && !compactionSvc) return { ok: false, detail: '宿主既无 commands 也无 compaction 服务，无法压缩' }
          const ticketId = String((args && args.id) || '')
          let target = String((args && args.sessionId) || '')
          if (!target && ticketId) {
            const t = svc.find(ticketId)
            if (!t) return { ok: false, detail: '工单不存在: ' + ticketId }
            const ass = Array.isArray(t.assignees) ? t.assignees : []
            if (!ass.length || !ass[0].sessionId) return { ok: false, detail: ticketId + ' 没有 assignee，无法确定压缩哪个会话' }
            target = String(ass[0].sessionId)
          }
          if (!target) return { ok: false, detail: '需要 sessionId 或 id' }
          if (target === sid) return { ok: false, detail: '拒绝压缩自己（owner 会话）：请在 UI 手打 /compact' }
          let found
          try { found = await sessionController.resolveAgent(target) } catch (e) { return { ok: false, detail: 'resolveAgent 失败: ' + ((e && e.message) || e) } }
          if (found && found.error) return { ok: false, detail: 'resolveAgent 报错: ' + JSON.stringify(found.error).slice(0, 200) }
          const agent = found && found.agent ? found.agent : found
          if (!agent || !agent.session) return { ok: false, detail: '拿不到目标 Agent（宿主版本可能不支持）' }
          const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
            ? AbortSignal.timeout(600000)
            : new AbortController().signal
          try {
            if (commandsSvc && typeof commandsSvc.execute === 'function') {
              const out = await commandsSvc.execute(agent, '/compact', [], signal)
              if (!out) return { ok: false, detail: '宿主未注册 /compact 命令（command-compact 未挂载）' }
              const text = String((out.result && out.result.text) || '')
              const okc = !!(out.result && out.result.kind === 'success')
              log('compact ' + target.slice(0, 12) + '… by=' + sid.slice(0, 12) + '… ' + (okc ? 'ok' : 'fail') + ' ' + text.slice(0, 90))
              return { ok: okc, detail: text || (okc ? '已压缩' : '压缩未成功') }
            }
            const result = await compactionSvc.compactNow(agent, signal, 'sa-compact-' + Date.now())
            if (result === null) return { ok: false, detail: '没有可压缩的历史（新会话）' }
            return { ok: true, detail: 'Compacted ' + result.shadowedSeqs.length + ' items (~' + result.shadowedTokenCount + ' tokens)' }
          } catch (e) {
            return { ok: false, detail: '压缩失败: ' + String((e && (e.code || e.message)) || e) }
          }
        },
      })
      child.tools.register({
        name: 'sa_report',
        description: 'N7 worker：交活自报（做过什么、证据在哪）。只有被派到这张单的 worker（或 owner）能调',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id' },
            summary: { type: 'string', description: '做了什么 + 证据位置' },
            final: { type: 'boolean', description: '可选：true = 声明收尾（记 workerFinalAt 并刷新 updatedAt；不改状态，仍由 owner 判断转 ready）' },
          },
          required: ['id', 'summary'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          const id = String((args && args.id) || '')
          const { sid, role } = roleOf(exec)
          if (role !== 'owner' && role !== 'worker') return denyFor(exec, 'sa_report')
          const final = !!(args && args.final)
          const r = svc.report(id, String((args && args.summary) || ''), sid, { allowAny: role === 'owner', final })
          if (!r.ok) return { ok: false, detail: r.error }
          // sa-194 F8：worker final 把单推进 ready 后自动送审（未配置 autoJudge 时跳过）
          let auto = null
          if (final && r.state === 'ready') { try { auto = await maybeAutoJudge(id) } catch {} }
          const tail = final
            ? (r.state === 'ready'
                ? '，已声明收尾 → ready' + (auto && auto.ok ? '（已自动送审 ' + String(auto.judge).slice(0, 12) + '…）' : '（等 owner 派审）')
                : '，已声明收尾（当前状态 ' + r.state + '，需 owner 处理）')
            : ''
          return { ok: true, detail: id + ' 已自报（累计 ' + r.reports + ' 条）' + tail }
        },
      })
      child.tools.register({
        name: 'sa_judge',
        description: 'N7 决策：把工单交给 judge 会话做独立验收（第二筛），并把产物清单+worker 自报一并投过去。仅 owner',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id' },
            judgeSessionId: { type: 'string', description: 'judge 会话 id' },
            criteria: { type: 'string', description: '验收标准（判据）' },
          },
          required: ['id', 'judgeSessionId'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_judge')
          const id = String((args && args.id) || '')
          const judgeSid = String((args && args.judgeSessionId) || '')
          const criteria = String((args && args.criteria) || '')
          const t = svc.find(id)
          if (!t) return { ok: false, detail: 'no-such-ticket: ' + id }
          const arts = Array.isArray(t.artifacts) ? t.artifacts : []
          const reps = Array.isArray(t.reports) ? t.reports : []
          const text = buildJudgePrompt(t, criteria)
          const a = svc.assignJudge(id, judgeSid, criteria)
          if (!a.ok) return { ok: false, detail: a.error }
          try { await tell(judgeSid, text, 'superagent 验收 ' + id) } catch (e) { return { ok: false, detail: 'judge notify failed: ' + (e && e.message) } }
          log('judge-notify ' + id + ' arts=' + arts.length + ' reports=' + reps.length)
          return { ok: true, detail: id + ' 已交给 judge ' + judgeSid.slice(0, 12) + '…（产物 ' + arts.length + ' 条 / 自报 ' + reps.length + ' 条）' }
        },
      })
      child.tools.register({
        name: 'sa_escalate',
        description: 'N7.3 judge/owner：把「坑在哪」写进坑投递箱 handoff/pitfalls-inbox/（发消息会叫醒运维、费它上下文，所以不叫），并记进工单 escalations',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id' },
            problem: { type: 'string', description: '坑在哪：现象 + 猜测根因 + 复现线索（越具体越好）' },
            target: { type: 'string', description: '可选：指定运维会话 id（默认用 roles.ops 第一个）' },
          },
          required: ['id', 'problem'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          const { sid, role } = roleOf(exec)
          if (role !== 'judge' && role !== 'owner') return denyFor(exec, 'sa_escalate')
          const id = String((args && args.id) || '')
          const problem = String((args && args.problem) || '')
          if (!problem.trim()) return { ok: false, detail: 'problem 不能为空' }
          const t = svc.find(id)
          if (!t) return { ok: false, detail: 'no-such-ticket: ' + id }
          const nl = String.fromCharCode(10)
          const arts = Array.isArray(t.artifacts) ? t.artifacts : []
          const text = [
            '【superagent 坑报告 ' + id + '】' + (t.title || ''),
            '',
            '## 坑在哪（判者原话）',
            problem,
            '',
            '## 复现线索',
            '- 工单：' + id + '（state=' + t.state + '，来源 ' + (t.source || 'local') + '）',
            '- 产物：' + (arts.length ? arts.map((a) => a.rel || a.name).join(', ') : '无登记'),
            '- 证据目录：handoff/superagent/evidence/' + id + '/',
            '- 判者：' + sid.slice(0, 14) + '…',
            '',
            '## 请你做的',
            '定位根因 → 给修法或止损建议；如需我改插件/配置，找本工区的 owner 会话。',
          ].join(nl)
          let file = ''
          try { file = dropPitfall('## 坑 ' + id + '：' + String((t && t.title) || '').slice(0, 60) + nl + nl + text + nl) } catch (e) { return { ok: false, detail: '写投递箱失败: ' + (e && e.message ? e.message : String(e)) } }
          const r = svc.escalate(id, problem, sid, 'pitfalls-inbox')
          if (!r.ok) return { ok: false, detail: r.error }
          return { ok: true, detail: '已投进坑投递箱（不叫醒运维）：' + file + '（本单累计 ' + r.count + ' 条）' }
        },
      })
      child.tools.register({
        name: 'sa_verdict',
        description: 'N7 judge：对工单下验收结论。pass=true → 工单转 ready 并通知决策人收口；pass=false → blocked 并写明缺什么。仅 judge/owner',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string', description: '工单 id' }, pass: { type: 'boolean', description: '是否通过' }, reason: { type: 'string', description: '证据化理由（不通过必须写缺什么）' } },
          required: ['id', 'pass'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          const { sid, role } = roleOf(exec)
          if (role !== 'judge' && role !== 'owner') return denyFor(exec, 'sa_verdict')
          const id = String((args && args.id) || '')
          const pass = !!(args && args.pass)
          const reason = String((args && args.reason) || '')
          if (!pass && !reason) return { ok: false, detail: '不通过必须写 reason（缺什么）' }
          const r = svc.verdict(id, pass, reason, sid)
          if (!r.ok) return { ok: false, detail: r.error || 'verdict failed' }
          if (pass) return { ok: true, detail: id + ' 验收通过 → ready（决策人将收到收口通知）' }
          // 不通过：自动把「坑在哪」投给运维会话（用户要求 judge 不只判，还要把坑自动递出去）
          const t2 = svc.find(id)
          const nl = String.fromCharCode(10)
          const arts = t2 && Array.isArray(t2.artifacts) ? t2.artifacts : []
          const text = [
            '【superagent 坑报告 ' + id + '】' + ((t2 && t2.title) || ''),
            '',
            '## 验收不通过（判者原话）',
            reason,
            '',
            '## 复现线索',
            '- 工单：' + id + '（已置 blocked）',
            '- 产物：' + (arts.length ? arts.map((a) => a.rel || a.name).join(', ') : '无登记'),
            '- 证据目录：handoff/superagent/evidence/' + id + '/',
            '- 判者：' + sid.slice(0, 14) + '…',
            '',
            '## 请你做的',
            '定位根因 → 给修法或止损建议；如需我改插件/配置，找本工区的 owner 会话。',
          ].join(nl)
          let file = ''
          let ok2 = false
          try { file = dropPitfall('## 坑 ' + id + '：' + String((t2 && t2.title) || '').slice(0, 60) + nl + nl + text + nl); ok2 = true } catch (e) { ok2 = false }
          if (ok2) svc.escalate(id, 'judge 判不通过：' + reason, sid, 'pitfalls-inbox')
          return { ok: true, detail: id + ' 验收不通过 → blocked：' + reason.slice(0, 50) + (ok2 ? '（已自动投坑投递箱，不叫醒运维：' + file + '）' : '（⚠ 写投递箱失败）') }
        },
      })
      child.tools.register({
        name: 'sa_archive',
        description: '把已收口（done/blocked）的工单移出 state.json，落到 stateDir/archive/<纪元前缀>.json；工单号按纪元滚动（sa-001…sa-999 → s1-001…）。参数：keep=N 只保留最近 N 张、before=ISO 只归档更早的、all=true 全归档、dryRun=true 先看数量',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            keep: { type: 'integer', description: '保留最近 N 张已收口工单（按 updatedAt）' },
            before: { type: 'string', description: '只归档 updatedAt 早于该 ISO 时间的' },
            all: { type: 'boolean', description: 'true = 归档所有已收口工单' },
            dryRun: { type: 'boolean', description: 'true = 只算数量不落盘' },
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_archive')
          const a = args || {}
          if (!a.keep && !a.before && a.all !== true && a.dryRun !== true) return { ok: false, detail: '没给范围：用 keep=N / before=ISO / all=true' }
          const r = svc.archive({ keep: a.keep, before: a.before, all: a.all === true, dryRun: a.dryRun === true })
          const files = (r.files || []).map((x) => String(x).split(/[\\/]/).pop()).join(', ')
          return { ok: true, detail: (a.dryRun ? '（dryRun）将归档 ' : '已归档 ') + r.archived + ' 张' + (files ? ' → ' + files : '') }
        },
      })
      // sa_steer —— 中间插话：给「正在跑」的会话插一条指令，不必等它整轮结束。
      // 参数：sessionId（目标会话）、text（要插入的指令）、mode（auto/steer/followup）。
      // 实现：宿主 typert.lookups.get('agent').resolve(sessionId) 取 Agent，
      //       running → agent.steer()（插到下一步）；idle → agent.followup()（起新回合）。
      // 失败时明确报不可用，不静默丢；不会写账本、不改工单状态。
      child.tools.register({
        name: 'sa_steer',
        description: '给指定会话插话：目标正在跑（running）→ 插到下一步，不必等它整轮结束；空闲（idle）→ 起新回合。用于纠偏 / 加约束。仅 owner 可用。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: '目标会话 id（session-<uuid>）' },
            text: { type: 'string', description: '要插入的指令（越具体越好）' },
            mode: { type: 'string', enum: ['auto', 'steer', 'followup'], description: 'auto=按目标状态自动选；steer=强制插下一步；followup=强制新回合' },
          },
          required: ['sessionId', 'text'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_steer')
          // Direct callers must obey the same contract as schema-validated tool calls.
          if (!args || typeof args !== 'object' || Array.isArray(args) ||
              Object.keys(args).some((k) => !['sessionId', 'text', 'mode'].includes(k)) ||
              typeof args.sessionId !== 'string' || typeof args.text !== 'string' ||
              (args.mode !== undefined && !['auto', 'steer', 'followup'].includes(args.mode))) {
            return { ok: false, detail: 'sa_steer: 参数必须为 sessionId/text 字符串和可选 mode=auto|steer|followup，禁止额外字段' }
          }
          const sid = args.sessionId.trim()
          const text = args.text
          const mode = args.mode === undefined ? 'auto' : args.mode
          if (!sid) return { ok: false, detail: 'sa_steer: sessionId 不能为空' }
          if (!text.trim()) return { ok: false, detail: 'sa_steer: text 不能为空' }
          let provider = null
          try {
            const tp = typeof ctx.get === 'function' ? ctx.get('typert') : null
            provider = tp && tp.lookups && typeof tp.lookups.get === 'function' ? tp.lookups.get('agent') : null
          } catch (e) { return { ok: false, detail: 'sa_steer: 获取 agent 解析器失败 → ' + ((e && e.message) || String(e)) } }
          if (!provider || typeof provider.resolve !== 'function') return { ok: false, detail: 'sa_steer: 宿主 typert.lookups 没有 agent 解析器（宿主版本变化？）；可退回 sa_tell（只排新回合）' }
          let agent = null
          try { agent = await provider.resolve(sid) } catch (e) { return { ok: false, detail: 'sa_steer: 解析会话失败 ' + sid + ' → ' + ((e && e.message) || String(e)) } }
          if (!agent) return { ok: false, detail: 'sa_steer: 会话 ' + sid + ' 解析到空 Agent' }
          const status = String(agent.status || 'unknown')
          const useSteer = mode === 'steer' || (mode === 'auto' && status === 'running')
          const msg = deepFreeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(text) }], source: { kind: 'user' } })
          try { if (useSteer) await agent.steer(msg); else await agent.followup(msg) } catch (e) { return { ok: false, detail: 'sa_steer: 投递失败 → ' + ((e && e.message) || String(e)) } }
          return { ok: true, detail: 'sa_steer → ' + sid + ' via ' + (useSteer ? 'steer(下一步插入)' : 'followup(新回合)') + ' · status=' + status }
        },
      })
      child.tools.register({
        name: 'sa_tell',
        description: 'N6：把一条任务/消息投到指定会话（跨工作区派活给 worker/test/judgement 等）。仅 owner 可用；不建工单，直接唤醒目标会话',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: '目标会话 id（session-<uuid> 或子代理裸 uuid）' },
            prompt: { type: 'string', description: '要对方做什么（尽量给可验证的交付物，比如写哪个文件）' },
            title: { type: 'string', description: '提醒标题，默认「superagent 派活」' },
            ticketId: { type: 'string', description: '可选：把这条件当成该工单的「追加需求」——写 requirements、rev+1、touch updatedAt，投递文本自动加需求头（不传 = 行为完全不变）' },
          },
          required: ['sessionId', 'prompt'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_tell')
          const sid = String((args && args.sessionId) || '')
          const ticketId = String((args && args.ticketId) || '').trim()
          const promptText = String((args && args.prompt) || '')
          // sa-194 F1：带 ticketId = 把这条当成对已存在工单的「追加需求」先落账，再投递。
          // 非法 id 直接拒（不写 state、不发消息）；不传 ticketId = 老行为（纯投递，不碰任何工单）。
          let req = null
          if (ticketId) {
            const t = svc.find(ticketId)
            if (!t) return { ok: false, detail: 'no-such-ticket: ' + ticketId + '（需求未记录、消息未发出）' }
            const rr = svc.addRequirement(ticketId, promptText, callerOf(exec))
            if (!rr || !rr.ok) return { ok: false, detail: (rr && rr.error) || 'addRequirement failed' }
            req = rr
          }
          // #33：日志要素必须在“发之前”算好。旧写法把 shortSid()/callerOf() 放在 await tell() 之后，
          // 那两句一抛错，catch 就把「消息其实已经发出」报成失败，调用方会重复派活。
          // 现在：只有 tell 本身在 try 里；发出去之后的任何事都不许改结果。
          let tag = '(target)'
          let who = ''
          try { tag = shortSid(sid); who = String(callerOf(exec) || '').slice(0, 12) } catch {}
          // 需求头（只有带 ticketId 时才有）：告诉收到的会话「这是第几版、共几条」
          const head = req ? '【' + ticketId + ' 需求 v' + req.revision + '（共 ' + req.count + ' 条，以最新一条为准）】\n\n' : ''
          const title = req ? ('superagent 需求 ' + ticketId + ' v' + req.revision) : (args && args.title)
          let r
          try {
            r = await tell(sid, head + promptText, title)
          } catch (e) {
            return { ok: false, detail: 'tell failed（未发出）: ' + (e && e.message ? e.message : String(e)) + (req ? '（需求 v' + req.revision + ' 已记入工单）' : '') }
          }
          // 已发出：日志写成什么样都不影响结果（log 自身也吞异常，这层 try 是双保险）
          try { log('tell ' + tag + ' by=' + who + (req ? ' requirement=' + ticketId + ' v' + req.revision : '')) } catch {}
          return { ok: true, detail: 'queued to ' + tag + (r && r.id ? ' schedule=' + r.id : '') + '（已发出）' + (req ? '，需求 v' + req.revision + ' 已记入 ' + ticketId : '') }
        },
      })
      child.tools.register({
        name: 'sa_new_session',
        description: 'sa-201：程序化创建一个新会话（owner-only）。给定工作区目录 cwd，返回新 sessionId。cwd 必须落在 config.sessionCreateRoots 白名单内（默认 [] = 全拒，不配就建不了）。宿主需提供 sessionController 服务，否则报错。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            cwd: { type: 'string', description: '新会话的工作目录（绝对路径）；必须存在且落在 sessionCreateRoots 内' },
            sessionId: { type: 'string', description: '可选：指定 sessionId；缺省自动生成 session-<uuid>' },
            title: { type: 'string', description: '可选：仅记入返回文案与日志，便于人认（宿主不一定用它当标题）' },
          },
          required: ['cwd'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_new_session')
          if (!sessionController || typeof sessionController.create !== 'function') {
            return { ok: false, detail: '宿主未提供 sessionController（无法建会话）；请确认宿主版本或改用手动 UI 新建' }
          }
          const raw = String((args && args.cwd) || '').trim()
          if (!raw) return { ok: false, detail: 'cwd 必填（绝对路径）' }
          if (!isAbsolute(raw)) return { ok: false, detail: 'cwd 必须是绝对路径：' + raw }
          const dir = resolve(raw)
          // 目录必须真实存在（先 existsSync，再尝试验证它是目录）
          if (!existsSync(dir)) return { ok: false, detail: 'cwd 不存在：' + dir }
          try { if (!statSync(dir).isDirectory()) return { ok: false, detail: 'cwd 不是目录：' + dir } } catch { return { ok: false, detail: 'cwd 无法读取：' + dir } }
          // 白名单：默认 [] = 全拒（红线，绝不做成任意路径可写）
          const roots = (Array.isArray(config.sessionCreateRoots) ? config.sessionCreateRoots : []).map(String).filter(Boolean)
          if (!roots.length) return { ok: false, detail: 'sessionCreateRoots 未配置（默认全拒）；请在 config.sessionCreateRoots 里显式加入允许的工作区根目录' }
          const real = realOrResolveLocal(dir) || dir
          const inside = roots.some((r) => {
            const rr = realOrResolveLocal(r) || resolve(r)
            const rel = relative(rr, real)
            if (rel === '') return true
            if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return false
            return true
          })
          if (!inside) return { ok: false, detail: 'cwd 不在 sessionCreateRoots 内：' + real + '（roots: ' + roots.join('; ') + '）' }
          const wantId = String((args && args.sessionId) || '').trim()
          const sid = wantId || ('session-' + randomUUID())
          try {
            await sessionController.create({ sessionId: sid, cwd: real })
          } catch (e) {
            const msg = e && e.message ? e.message : String(e)
            // 同 id 已存在会抛错：按契约返回 exists，不崩
            const already = /exist|duplicate|already/i.test(msg)
            log('new-session-failed ' + sid + ' cwd=' + real + ' ' + msg)
            return { ok: false, detail: (already ? 'session exists: ' : 'create-failed: ') + msg }
          }
          log('new-session ' + sid + ' cwd=' + real + (args && args.title ? ' title=' + String(args.title) : ''))
          // ── sa-206：**只做增量登记**（读 header → 备份 → indexHeader → 复查文件）──
          //   红线：绝不调用 rebuildEntities / bootstrap / replaceHeaderIndex / setState，
          //   那些会清空运行中的内存索引（probe v3 实测：UI 全变「未分组」，已回滚）。
          const wantTitle = String((args && args.title) || '').trim()
          const notes = []

/* ============================================================
 * 注释切片 # 4 / 4  —— 源文件 handoff/dist/dsh-plugin-superagent-lite/index.js
 * 原始行号：2930 – 3410（481 行）
 * 任务：本文件内只新增「整行注释」，不改任何代码字符。整行注释 = 以双斜杠开头的整行，
 *       或独立成块的星号注释（首行仅含斜杠星号、末行仅含星号斜杠）。行内尾注也算，但别改代码本身。
 * 禁碰：handoff/annotate/slices（原始副本）｜handoff/dist（在跑的代码）｜~/.dsh（宿主配置）
 * 自检：node handoff/annotate/verify-slice.mjs 4   → 末行必须是 SLICE 4: PASS
 * ============================================================ */
          // 1) 拿 header（indexHeader 要「带 id 的 header 对象」，传字符串会报 Cannot read properties of undefined (reading 'id'))
          let header = null
          let headerSrc = ''
          if (sessionsSvc && typeof sessionsSvc.get === 'function') {
            try {
              const entry = sessionsSvc.get(sid)
              const h = (entry && entry.session && entry.session.header) || (entry && entry.header) || (entry && entry.session) || null
              if (h && typeof h === 'object') { header = h; headerSrc = 'sessions.get' }
            } catch (e) {
              log('new-session ' + sid + ' sessions.get failed ' + (e && e.message ? e.message : String(e)))
            }
          }
          if (!header && workspaceRegistry && typeof workspaceRegistry.readSessionHeader === 'function') {
            try {
              const h = workspaceRegistry.readSessionHeader(sid)
              if (h && typeof h === 'object') { header = h; headerSrc = 'readSessionHeader' }
            } catch (e) {
              log('new-session ' + sid + ' readSessionHeader failed ' + (e && e.message ? e.message : String(e)))
            }
          }

          let registered = false
          let indexErr = ''
          if (!header) {
            notes.push('未登记（拿不到 header）：UI 侧栏可能不显示')
            log('new-session ' + sid + ' no header → skip indexHeader')
          } else if (!workspaceRegistry || typeof workspaceRegistry.indexHeader !== 'function') {
            notes.push('未登记（缺 workspaceRegistry.indexHeader）')
            log('new-session ' + sid + ' no indexHeader → skip')
          } else {
            // 2) 备份 workspace.json（只备份，**不直接改内容**）
            let bakPath = ''
            try {
              const wsFile = join(homedir(), '.dsh', 'storages', 'workspace.json')
              if (existsSync(wsFile)) {
                const ts = new Date().toISOString().replace(/[:.]/g, '-')
                bakPath = wsFile + '.bak-pre-indexHeader-' + ts
                copyFileSync(wsFile, bakPath)
              }
            } catch (e) {
              log('new-session ' + sid + ' workspace.json backup failed ' + (e && e.message ? e.message : String(e)))
            }
            // 3) 增量登记（唯一允许的方法）
            try {
              await workspaceRegistry.indexHeader(header)
            } catch (e) {
              indexErr = e && e.message ? e.message : String(e)
              log('indexHeader failed ' + sid + ' ' + indexErr)
            }
            // 4) 复查：重新读 workspace.json，确认该 id 写进去了
            //    **真实形状（2026-11-06 实测真机）**：顶层 { unit, global, tables }，
            //    真正的工作区表在 `tables.workspaces`，是「以 workspaceId 为键的对象」，
            //    每个工作区含 { path, title, sessionIds, createdAt, updatedAt }。
            //    旧版我猜的 workspaces[]/顶层 sessionIds **都不存在**，已验证并改正。
            try {
              const wsFile = join(homedir(), '.dsh', 'storages', 'workspace.json')
              if (existsSync(wsFile)) {
                const j = JSON.parse(readFileSync(wsFile, 'utf8'))
                const hit = (arr) => Array.isArray(arr) && arr.map(String).includes(sid)
                const scanObj = (obj) => {
                  if (!obj || typeof obj !== 'object') return false
                  if (hit(obj.sessionIds)) return true
                  for (const k of Object.keys(obj)) {
                    const v = obj[k]
                    if (v && typeof v === 'object' && hit(v.sessionIds)) return true
                  }
                  return false
                }
                let found = false
                if (j && typeof j === 'object') {
                  // 主路径（真实形状）：tables.workspaces
                  if (j.tables && typeof j.tables === 'object' && scanObj(j.tables.workspaces)) found = true
                  // 兜底（不同版本可能的形状）：顶层 workspaces / workspaces 数组 / 顶层 sessionIds
                  if (!found && scanObj(j.workspaces)) found = true
                  if (!found && Array.isArray(j.workspaces) && j.workspaces.some((w) => w && hit(w.sessionIds))) found = true
                  if (!found && hit(j.sessionIds)) found = true
                }
                registered = found
              }
            } catch (e) {
              log('new-session ' + sid + ' verify workspace.json failed ' + (e && e.message ? e.message : String(e)))
            }
            if (!registered) {
              notes.push('未登记（indexHeader 后 workspace.json 里仍没有该 id' + (indexErr ? '；错误：' + indexErr : '') + '）')
            } else {
              log('indexHeader ok ' + sid + ' via ' + headerSrc + (bakPath ? ' bak=' + basename(bakPath) : ''))
            }
          }

          // 5) 设标题：三种签名依次尝试，任一成功即停（失败只记日志，不影响 ok）
          let titleOk = null
          if (wantTitle) {
            if (!sessionController || typeof sessionController.rename !== 'function') {
              titleOk = false
              notes.push('标题未设置（sessionController 无 rename）')
              log('new-session ' + sid + ' no rename → title skipped')
            } else {
              const attempts = [
                { label: 'rename({sessionId,title})', args: [{ sessionId: sid, title: wantTitle }] },
                { label: 'rename({id,title})', args: [{ id: sid, title: wantTitle }] },
                { label: 'rename(id,title)', args: [sid, wantTitle] },
              ]
              for (const a of attempts) {
                try {
                  await sessionController.rename(...a.args)
                  titleOk = true
                  log('new-session ' + sid + ' title via ' + a.label)
                  break
                } catch (e) {
                  const msg = e && e.message ? e.message : String(e)
                  log('rename attempt failed ' + sid + ' ' + a.label + ' ' + msg)
                }
              }
              if (titleOk !== true) {
                titleOk = false
                notes.push('标题未设置（三种 rename 签名都失败）')
              }
            }
          }

          const parts = []
          parts.push(sid)
          parts.push('（registered=' + (registered ? 'true' : 'false') +
            (headerSrc ? ',via=' + headerSrc : '') +
            (wantTitle ? ',title=' + (titleOk === true ? 'set' : 'failed') : '') + '）')
          if (notes.length) parts.push('\n⚠ ' + notes.join('；'))
          return { ok: true, detail: parts.join('') }
        },
      })
      // sa_whoami —— 新会话/新成员接手工单体系的第一入口。
      // 干什么：只读回本会话的 sessionId、角色（owner/worker/judge/none）与白名单概况。
      // 为什么需要：owner 加白名单（sa_owner_add）必须拿到完整会话 id，而子代理看到的是裸 uuid；
      //   新会话先调它拿到 sid 交给 owner，是接入工单体系的固定第一步。
      // 副作用：svc.touchCaller(sid) 顺手刷新该会话的活跃心跳；无写权限也能调（role=none 也照回）。
      child.tools.register({
        name: 'sa_whoami',
        description: '只读：返回本会话的 sessionId 与是否有工单写权限（新团队/新会话接手时先调它，把 id 给 owner 加白名单）',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          const sid = callerOf(exec)
          svc.touchCaller(sid)
          const { role } = roleOf(exec)
          const r = readRoles()
          return { ok: true, detail: 'sessionId=' + (sid || '(unknown)') + ' | role=' + role + ' | owners=' + r.owners.length + ' workers=' + r.workers.length + ' judges=' + r.judges.length + ' | file=' + ownersFile }
        },
      })
      child.tools.register({
        name: 'sa_owners',
        description: '只读：列出工单写操作白名单（谁能 submit/advance/run/attach/transfer/ingress/发告警）',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async () => {
          const r = readRoles()
          const fmt = (arr) => (arr.length ? arr.join(', ') : '(空)')
          return { ok: true, detail: 'owners=' + fmt(r.owners) + ' | workers=' + fmt(r.workers) + ' | judges=' + fmt(r.judges) + ' | file=' + ownersFile }
        },
      })
      child.tools.register({
        name: 'sa_owner_add',
        description: '写：把一个会话加进工单写白名单（只有 owner 能调）。新团队会话先 sa_whoami 拿 id 交给 owner',
        parameters: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', description: '完整会话 id，形如 session-xxxxxxxx-…' } }, required: ['sessionId'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_owner_add')
          const sid = String((args && args.sessionId) || '').trim()
          // 主会话是 session-<uuid>，子代理/成员会话是裸 <uuid>：两种都得收
          if (!/^(session-)?[0-9a-zA-Z][0-9a-zA-Z-]{7,}$/.test(sid)) return { ok: false, detail: 'bad sessionId: ' + sid }
          const r = readRoles()
          if (r.owners.includes(sid)) return { ok: true, detail: sid + ' 已在白名单（noop）' }
          const next = writeRoles({ ...r, owners: [...r.owners, sid] })
          log('owner add ' + sid + ' by=' + callerOf(exec).slice(0, 12))
          return { ok: true, detail: 'added ' + sid + ' | owners=' + next.owners.length }
        },
      })
      child.tools.register({
        name: 'sa_owner_remove',
        description: '写：把一个会话移出工单写白名单（只有 owner 能调；不允许把最后一个 owner 删掉，避免锁死）',
        parameters: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', description: '完整会话 id' } }, required: ['sessionId'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_owner_remove')
          const sid = String((args && args.sessionId) || '')
          const r = readRoles()
          if (!r.owners.includes(sid)) return { ok: false, detail: '不在 white-list: ' + sid }
          if (r.owners.length <= 1) return { ok: false, detail: '拒绝：不能删掉最后一个 owner（会锁死写操作）' }
          const next = writeRoles({ ...r, owners: r.owners.filter((x) => x !== sid) })
          log('owner remove ' + sid + ' by=' + callerOf(exec).slice(0, 12))
          return { ok: true, detail: 'removed ' + sid + ' | owners=' + next.owners.length }
        },
      })
      child.tools.register({
        name: 'sa_transfer',
        description: 'N5：改工单归属会话（多会话/多项目路由）。未投递的 outbox 跟着改目标，已投的保持原样',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string', description: '工单 id，如 sa-016' }, sessionId: { type: 'string', description: '目标会话 id（完整 id，形如 session-xxxx-…）' } },
          required: ['id', 'sessionId'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_transfer')
          const r = svc.transfer(String(args && args.id), String(args && args.sessionId))
          if (!r.ok) return { ok: false, detail: r.error }
          if (r.noop) return { ok: true, detail: r.ticket.id + ' 已经是 ' + r.to + '（noop）' }
          return { ok: true, detail: r.ticket.id + ' session ' + r.from + ' -> ' + r.to }
        },
      })
      // sa_attach —— 把产物登记进证据目录（evidence/<工单id>/），是「交活」的落盘动作。
      // 两条路：content 直接写新文件；sourcePath 复制已有文件（二选一，都走 svc.attach）。
      // 关键约定：登进 state 的 ticket.artifacts 清单后，watchdog 只认清单、不再靠文件名猜产物，
      //   所以交活必须走它而不是手动拷文件，否则验收会判「无产物」。
      // 边界：sourcePath 受 attachRoots 白名单 + attachMaxBytes（默认 8MB）限制，防越权读敏感文件。
      // 权限：canSubmitEvidence 门控——owner 全可，worker 只能附到自己被派的单上。
      child.tools.register({
        name: 'sa_attach',
        description: 'N4：把产物登记进 handoff/superagent/evidence/<工单id>/ —— content 直接写文件、sourcePath 复制已有文件；同时写进 state 的 ticket.artifacts 清单（watchdog 按清单核对，不再猜文件名）。`sourcePath` 只允许 host 允许根内的非敏感文件（默认=项目根+临时目录，可用 `attachRoots` 扩展），单文件上限 `attachMaxBytes`（默认 8MB）。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id，如 sa-014' },
            name: { type: 'string', description: '产物文件名，默认 evidence.md（给 sourcePath 时取源文件名）' },
            content: { type: 'string', description: '文件内容（与 sourcePath 二选一）' },
            sourcePath: { type: 'string', description: '已有文件的绝对路径，复制进证据目录' },
            by: { type: 'string', description: '谁产出的：agent / codex / subagent / human' },
          },
          required: ['id'],
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] },
          render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }],
        },
        execute: async (args, exec) => {
          if (!canSubmitEvidence(exec, String(args && args.id))) return denyFor(exec, 'sa_attach')
          const r = svc.attach(String(args && args.id), { name: args && args.name, content: args && args.content, sourcePath: args && args.sourcePath, by: args && args.by, producer: callerOf(exec) })
          if (!r.ok) return { ok: false, detail: r.error }
          return { ok: true, detail: r.rel + ' ' + r.bytes + 'B（清单 ' + r.count + ' 条）-> ' + r.path }
        },
      })
      child.tools.register({
        name: 'sa_evidence',
        description: 'N4：看一张工单的证据详情 —— 清单登记了什么、磁盘上有什么、缺件、孤儿文件、当前解析到哪个文件（manifest/dir/legacy）',
        parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: '工单 id' } }, required: ['id'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async (args) => {
          const r = svc.evidence(String(args && args.id))
          if (!r.ok) return { ok: false, detail: r.error }
          const parts = []
          parts.push(r.id + ' ' + r.state + ' dir=' + r.dir)
          parts.push('清单=' + (r.manifest.length ? r.manifest.map((a) => a.name + '(' + a.bytes + 'B)').join(',') : '空'))
          parts.push('磁盘=' + (r.onDisk.length ? r.onDisk.join(',') : '空'))
          if (r.missing.length) parts.push('缺件=' + r.missing.join(','))
          if (r.orphans.length) parts.push('孤儿=' + r.orphans.join(','))
          parts.push('解析=' + (r.resolved ? r.resolved.kind + ':' + r.resolved.path : '无'))
          if (r.legacyOnly) parts.push('（仍是历史文件名命中，建议 sa_attach 收编）')
          return { ok: true, detail: parts.join(' | ') }
        },
      })
      // sa-194 F2：只读查看追加需求（owner / worker / judge 都可以读；ops/none 不给）
      child.tools.register({
        name: 'sa_requirements',
        description: '只读：查看某张工单的追加需求清单（v1..vN）、当前 revision、brief 与最近一次自报时间；owner/worker/judge 均可读',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string', description: '工单 id（sa-001 / s1-001 形式）' } },
          required: ['id'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          const role = roleOf(exec).role
          if (role !== 'owner' && role !== 'worker' && role !== 'judge') return denyFor(exec, 'sa_requirements')
          const id = String((args && args.id) || '')
          if (!ID_RE.test(id)) return { ok: false, detail: 'invalid-ticket-id: ' + id }
          const t = svc.find(id)
          if (!t) return { ok: false, detail: 'no-such-ticket: ' + id }
          const reqs = Array.isArray(t.requirements) ? t.requirements : []
          const reps = Array.isArray(t.reports) ? t.reports : []
          return {
            ok: true,
            detail: JSON.stringify({
              id: t.id,
              revision: Number(t.revision || 0),
              requirements: reqs,
              brief: t.brief || '',
              latestReportAt: reps.length ? (reps[reps.length - 1].at || null) : null,
            }, null, 1),
          }
        },
      })
      child.tools.register({
        name: 'sa_stats',
        description: 'N4：按状态/后端/来源/耗时/产物完整度出统计 —— 各状态张数、后端分布、平均与 p50/max 耗时、有清单/仅历史文件/完全无产物',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || v || '') }] },
        execute: async () => {
          const r = svc.stats()
          const fmt = (ms) => (ms == null ? '-' : ms < 60000 ? ms + 'ms' : (ms / 60000).toFixed(1) + 'min')
          const ss = Object.entries(r.byState).map(([k, v]) => k + '=' + v).join(',')
          const bk = Object.entries(r.byBackend).map(([k, v]) => k + '=' + v).join(',')
          const du = Object.entries(r.durations.byBackend).map(([k, v]) => k + ':' + v.n + ' 张/avg ' + fmt(v.avgMs)).join('; ')
          return { ok: true, detail: [
            'total=' + r.total + ' | byState: ' + ss,
            'byBackend: ' + bk,
            'evidence: artifacts=' + r.evidence.artifacts + ' 有清单=' + r.evidence.ticketsWithArtifacts + ' 仅历史=' + r.evidence.legacyOnly + ' 无产物=' + r.evidence.noArtifact + ' 缺件=' + r.evidence.incomplete + ' root=' + r.evidence.root,
            'duration: n=' + r.durations.n + ' avg=' + fmt(r.durations.avgMs) + ' p50=' + fmt(r.durations.p50Ms) + ' max=' + fmt(r.durations.maxMs) + (du ? ' | ' + du : ''),
          ].join('\n') }
        },
      })
      // sa-195 C：把工单产物发回来源 QQ（OneBot 上传接口；deliverOut 未配置时明确报错）
      child.tools.register({
        name: 'sa_sendback',
        description: 'sa-195：把工单产物回传到来源 QQ（群/私聊）。默认 dry-run 只打印计划；需要 config.deliverOut 且 dryRun:false 才真发。仅 owner',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: '工单 id' },
            files: { type: 'array', items: { type: 'string' }, description: '可选：要回传的绝对路径列表；默认取该单最新登记的产物' },
            dryRun: { type: 'boolean', description: '可选：true=只打印上传计划（默认取 config.deliverOut.dryRun，未配置时默认 true）' },
          },
          required: ['id'],
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok', 'detail'] }, render: (_a, v) => [{ type: 'text', text: String((v && v.detail) || '') }] },
        execute: async (args, exec) => {
          if (!isOwner(exec)) return denyFor(exec, 'sa_sendback')
          const sb = sendbackCfgNow()
          if (!sb) return { ok: false, detail: 'deliverOut 未配置（config.deliverOut = null，出站回传关闭）' }
          if (String(sb.mode || 'onebot') !== 'onebot') return { ok: false, detail: 'unsupported deliverOut.mode: ' + String(sb.mode) }
          const id = String((args && args.id) || '')
          const t = svc.find(id)
          if (!t) return { ok: false, detail: 'no-such-ticket: ' + id }
          const meta = t.sourceMeta || null
          if (!meta || !meta.chat || !meta.id) return { ok: false, detail: 'no-source-meta: 该单没有 QQ 来源信息（chat/id），无法回传' }
          const wanted = pickSendbackFiles(t, args)
          if (!wanted.length) return { ok: false, detail: 'no-files: 该单没有登记产物；请用 files 显式指定' }
          const checked = []
          for (const f of wanted) {
            const c = checkSendbackFile(f)
            if (!c.ok) return { ok: false, detail: c.error }
            checked.push(c)
          }
          const apiBase = String(sb.apiBase || 'http://127.0.0.1:3001').replace(/\/+$/, '')
          const isGroup = meta.chat === 'g'
          const action = isGroup ? 'upload_group_file' : 'upload_private_file'
          const plans = checked.map((c) => ({
            url: apiBase + '/' + action,
            body: isGroup ? { group_id: String(meta.id), file: c.real, name: c.name } : { user_id: String(meta.id), file: c.real, name: c.name },
          }))
          const dryRun = (args && typeof args.dryRun === 'boolean') ? args.dryRun : sb.dryRun !== false
          if (dryRun) {
            log('sendback-dryrun ' + id + ' files=' + checked.length)
            return { ok: true, detail: 'dry-run（未发送）· 计划：\n' + JSON.stringify(plans, null, 1) }
          }
          for (const plan of plans) {
            try {
              const res = await fetch(plan.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan.body) })
              const txt = await res.text()
              if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 160))
            } catch (e) {
              const msg = e && e.message ? e.message : String(e)
              log('sendback failed ' + id + ' ' + msg)
              try { svc.ownerNotice(id, '【superagent】回传失败（' + id + '）：' + msg + '\n请检查 deliverOut.apiBase / NapCat 是否在线，或手动把产物发给来源。') } catch {}
              return { ok: false, detail: 'sendback failed（已给 owner 排提醒，不静默）: ' + msg }
            }
          }
          log('sendback ' + id + ' files=' + checked.length)
          return { ok: true, detail: '已回传 ' + checked.length + ' 个文件 → ' + (isGroup ? '群 ' : '私聊 ') + meta.id }
        },
      })
      log('tools registered: ' + registeredToolNames.join(', '))
    })
  } catch (e) {
    log('tools inject failed: ' + (e && e.message ? e.message : String(e)))
  }

  // 核心心跳（2s）—— 插件的「泵」，驱动四条独立轮询。
  // 每条 tick 各自 try/catch：一条抛错不能带崩其余三条，否则一个坏单会卡停整个工单泵。
  //   svc.tick()            推进工单状态机 + 归档
  //   svc.tickCodex()       收 Codex 后端的回合结束事件（Stop → 推 ready）
  //   svc.tickIngress()     吃 ingress 队列的外部事件建单（按 key 去重）
  //   svc.tickCommands()    执行面板/指令队列（下面另有 500ms 专轮，见 cmdTimer）
  const timer = setInterval(() => {
    svc.tick().catch((e) => log('tick error ' + (e && e.message ? e.message : String(e))))
    try { svc.tickCodex() } catch (e) { log('tickCodex error ' + (e && e.message ? e.message : String(e))) }
    try { svc.tickIngress() } catch (e) { log('tickIngress error ' + (e && e.message ? e.message : String(e))) }
    svc.tickCommands().catch((e) => log('tickCommands error ' + (e && e.message ? e.message : String(e))))
  }, 2000)
  // lite50：commands 队列单独 500ms 轮询 —— 归档/结档/回滚不用等整轮 tick（原来最长 2s，面板上就是"点了半天才动"）
  const cmdTimer = setInterval(() => {
    svc.tickCommands()
      .then((k) => { if (k) log('commands done ' + k) })
      .catch((e) => log('tickCommands error ' + (e && e.message ? e.message : String(e))))
  }, 500)
  const wdTimer = setInterval(async () => {
    try { await svc.policyTick() } catch (e) { log('policy error ' + (e && e.message ? e.message : String(e))) }
    // 2026-11-06 用户定：定时 watchdog 关掉（工单本身会查）；sa_watchdog 工具仍可手动调。
    if (svc.settings().watchdogAlerts !== false) { try { await svc.watchdogTick() } catch (e) { log('watchdog error ' + (e && e.message ? e.message : String(e))) } }
  }, config.watchdogMs || 60000)

  // #27 自动派单：只有 config.autoDispatch === true 才开；只吃显式 auto:true 的 queued 单；
  // 派法走 fanout→已登记 worker 会话（这条不需要 exec.agent，所以 tick 里能干，
  // 而 sa_run 那条子代理后端离不开 exec.agent，见 PENDING #27 原阻塞点）。
  // lite47：自动派单的开关与间隔改由 settings.json 控制（面板「设置」页可改，热生效）
  let autoCursor = 0
  let autoLastAt = 0
  // 自动派单状态机——在 runExclusive 锁内一次性完成「选人 → 派单」。
  // 选人规则：池子只认 roles.workers（sa_run 的 children 绝不进，done 时由 reclaimChild 回收）；
  //   按工单 type 映射 wantKind（test→test / office|doc→doc / 其余→code），worker 无 kind 视为 any（向后兼容）。
  // 边界：无匹配执行体 → 不派、绝不塞给别的角色，改在锁外给 owner 投「无匹配」提醒；
  //   派单失败（tell 抛错）→ 不回队列重派，直接 failTicket 留在「错误」列并留证据。
  // 为什么整段锁住：autoCursor 轮转 + 满载判断必须是原子，否则并发 tick 会把同一单派两次。
  const autoDispatchTick = async () => {
    try {
      const dispatch = await runExclusive(() => {
        if (svc.settings().autoDispatch === false) return
        const roles = readRoles()
        // A（lite30）：池子只认 roles.workers —— children（sa_run 的孩子）绝不进这里，done 时由 reclaimChild 回收
        const workers = (roles.workers || []).map(String).filter(Boolean)
        if (!workers.length) return
        const conc = svc.concurrency()
        if (conc && conc.full) return
        const cand = svc.autoNext ? svc.autoNext() : null
        if (!cand) return
        // sa-207 C：按工单 type 匹配 worker 的 kind 挑人
        //   type=code→code / test→test / office|doc→doc；没有 kind 的老 worker 视为 any（向后兼容）
        const kinds = roles.kinds || {}
        const wantKind = (() => {
          const ty = String(cand.type || '').toLowerCase()
          if (ty === 'test') return 'test'
          if (ty === 'office' || ty === 'doc') return 'doc'
          return 'code'
        })()
        const matches = workers.filter((w) => {
          const k = String(kinds[w] || '').toLowerCase()
          if (!k) return true                 // 无 kind = any（向后兼容）
          return k === wantKind
        })
        if (!matches.length) {
          // 无匹配执行体 → 不自动派（绝不随便塞给别的角色）；投递放到锁外做（runExclusive 回调是同步的）
          log('auto-dispatch no-match ' + cand.id + ' want=' + wantKind)
          return { noMatch: { ticketId: cand.id, type: cand.type || 'code', wantKind, workers: workers.map((w) => shortSid(w) + '=' + (kinds[w] || 'any')) } }
        }
        const wid = matches[autoCursor++ % matches.length]
        const brief = '【自动派单 ' + cand.id + '】' + cand.title + '\n\n完成标准：产物用 sa_attach 交到 evidence（文件名自定），再用 sa_report 自报「做了什么 + 证据在哪」。不要动别的工单。'
        const r = svc.fanout(cand.id, [wid], brief)
        const gen = r && r.ticket ? (r.ticket.dispatchGen || 0) : null
        if (!r || !r.ok) { log('auto-dispatch skip ' + cand.id + ' ' + (r && r.error)) ; return }
        log('auto-dispatch ' + cand.id + ' -> ' + shortSid(wid))
        return { cand, wid, brief, gen }
      })
      if (!dispatch) return
      // sa-207 C：无匹配执行体 → 不派，给 owner 投提醒（在锁外做，tell 是 async）
      if (dispatch.noMatch) {
        const nm = dispatch.noMatch
        log('auto-dispatch no-match-notify ' + nm.ticketId)
        try {
          const roles = readRoles()
          const ownerSid = String((roles.owners || [])[0] || svc.fallbackSession() || '')
          await tell(ownerSid,
            '【superagent 自动派单跳过】工单 ' + nm.ticketId + ' 需要 kind=' + nm.wantKind + '（type=' + nm.type + '），' +
            '但没有匹配的 worker。已登记 workers：' + (nm.workers.join(', ') || '(空)') + '。请用 sa_fanout 手动派，或给某个 worker 设 kind（sa_role … kind=…）',
            '自动派单无匹配 ' + nm.ticketId)
        } catch (e) { log('auto-dispatch no-match notify failed ' + (e && e.message ? e.message : String(e))) }
        return
      }
      // 多个 worker 都匹配时按 autoCursor 轮转（自增取模），把负载摊匀。
      // matches[autoCursor++ % matches.length]：每派一次游标前移，下次从上次停的位置接着轮；
      // worker 数变化时取模会自动收敛，不会跳人。
      const { cand, wid, brief, gen } = dispatch
      try {
        await tell(wid, brief, 'superagent 自动派单 ' + cand.id)
      } catch (e) {
        const msg = e && e.message ? e.message : String(e)
        log('auto-dispatch notify failed: ' + msg)
        // lite44：失败不再回队列重派（用户 2026-11-06 定：错误单直接留在「错误」列并留证据）
        const fr = await runExclusive(() => svc.failTicket(cand.id, 'dispatch-failed: tell ' + msg + (gen != null ? ' (gen=' + gen + ')' : '')))
        if (!fr || !fr.ok) log('auto-dispatch failTicket failed ' + cand.id + ' ' + (fr && fr.error))
        return
      }
    } catch (e) { log('autoDispatch error ' + (e && e.message ? e.message : String(e))) }
  }
  // 1 秒心跳，按设置里的间隔决定是否真的派（<= 关闭时直接跳过）
  // sa-207 C：把「跑一次自动派单」暴露到 svc，便于测试确定性触发（不依赖定时器时序）
  try { svc.runAutoDispatchOnce = () => autoDispatchTick() } catch {}
  const autoTimer = setInterval(() => {
    const st = svc.settings()
    if (st.autoDispatch === false) return
    const nowMs = Date.now()
    if (nowMs - autoLastAt < st.autoDispatchMs) return
    autoLastAt = nowMs
    autoDispatchTick()
  }, 250)
  // 卸载清理：插件 dispose 时必须清掉全部四个定时器（timer/wdTimer/cmdTimer/autoTimer）。
  // 漏清任何一个 → 插件卸载后定时器仍在跑，svc 已销毁会持续报 tick error 并泄漏。
  // ctx.effect 返回的函数就是 dispose 回调；effect 不可用时只记日志、不抛（降级不致命）。
  try { ctx.effect(() => () => { clearInterval(timer); clearInterval(wdTimer); clearInterval(cmdTimer); if (autoTimer) clearInterval(autoTimer); log('disposed') }) } catch { log('effect unavailable') }
  // sa-202：把「自动复活上限」的读取器挂到 svc 上（verdict 在 createService 内，拿不到 apply 作用域的 eff）
  // 把两个调参项的「读取器」挂到 svc 上，供 verdict / 派单超时判定用。
  // 为什么要存取器：verdict 在 createService 内部，拿不到外层 apply 作用域的 eff，
  //   只能靠这个间接层在调用时才去读 settings（热改配置立即生效，不用重启）。
  // _maxAutoRework：工单允许「自动复活重做」的次数上限，默认 1。
  //   check 校验必须是有限非负数，否则回退默认值——防止配置写成负数/NaN 导致工单无限复活。
  try {
    svc._maxAutoRework = () => {
      const v = eff('maxAutoRework', 1, { check: (x) => Number.isFinite(Number(x)) && Number(x) >= 0 })
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 1
    }
    svc._dispatchStaleMin = () => {
      const v = eff('dispatchStaleMin', 15, { check: (x) => Number.isFinite(Number(x)) && Number(x) >= 0 })
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 15
    }
  } catch {}
  return svc
}
