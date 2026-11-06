#!/usr/bin/env node
/**
 * OneBot v11（NapCat）→ ingress 的最小适配器（**脚本，不是插件**）。
 *
 * 定位：只做「白名单里的 QQ 消息 → ingress 事件」这一件事，**不接 agent、不挂工具、不读 token**。
 *   NapCat(ws://127.0.0.1:3001) → 本脚本 → ingress.jsonl → dsh-plugin-subagent-lite 的 tickIngress → 建单
 *
 * 安全设计（参考 Derpyu520/qq-bridge 的 RULES 思路，不引入它的 agent 面）：
 *  - fail-closed：allow.groups / allow.users 全空 → 一条都不接受，直接拒绝启动（空白名单 != 放行）
 *  - 群消息默认要 @ 机器人（requireMention，可按群关）
 *  - 只认控制前缀（默认 !），其余消息只记日志、不建单
 *  - 只连 127.0.0.1，不发任何外网请求
 *
 * 环境变量：
 *  - ONEBOT_ROOT         工作区根，默认 process.cwd()
 *  - ONEBOT_CONFIG       配置文件，默认 <ONEBOT_ROOT>/handoff/superagent/onebot.json
 *  - ONEBOT_BRIDGE_LOG   日志文件，默认 <ONEBOT_ROOT>/handoff/superagent/onebot-bridge.log
 *  - INGRESS_FILE        队列文件；也可写在配置里（ingressFile）。**不猜路径，没配就拒绝启动**
 *
 * 用法：
 *   node onebot-bridge.mjs            # 前台跑（Ctrl+C 停）
 *   node onebot-bridge.mjs --selftest # 只跑解析/过滤自测，不连网、不写任何生产文件
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pushIngress } from './ingress-push.mjs'

const ROOT = process.env.ONEBOT_ROOT || process.cwd()
const CONFIG_FILE = process.env.ONEBOT_CONFIG || join(ROOT, 'handoff', 'superagent', 'onebot.json')
const LOG_FILE = join(ROOT, 'handoff', 'superagent', 'onebot-bridge.log')
// #28：日志路径运行时解析——测试在进程内把 ONEBOT_BRIDGE_LOG 指到临时文件，
// 就不会再把「skip/ingress」测试行写进生产 onebot-bridge.log（曾害我误判有真实消息进来）。
const logFile = () => process.env.ONEBOT_BRIDGE_LOG || LOG_FILE

export const DEFAULT_CONFIG = {
  wsUrl: 'ws://127.0.0.1:3001', // NapCat 的 WS 服务默认只监听回环地址
  selfId: '', // NapCat 登录的机器人 QQ 号（用于 @ 门控）；留空 = 任意 @ 都算
  ingressFile: '', // 必填：与 kernel config.ingressFile 同一个文件
  sessionId: '', // 可选：工单归属会话；留空走 kernel 兜底
  prefix: '!', // 控制前缀：只有 !工单 / !help 才会建单
  requireMention: true, // 群里默认必须 @ 机器人
  allow: { groups: [], users: [] }, // 白名单，默认全空 = fail-closed
  replyOnAccept: true, // 白名单会话里回执一条（走 bridge 自己，不经过任何出站插件）
  logRaw: false, // 调成 true 会把原始事件（含文本）写进日志，敏感场景别开
}

export function loadConfig(file = CONFIG_FILE) {
  if (!existsSync(file)) return { ...DEFAULT_CONFIG, _missing: true }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    allow: { groups: [], users: [], ...(raw.allow || {}) },
  }
}

/** 取出消息里的纯文本（OneBot v11 段格式） */
export function extractText(ev) {
  const msg = ev && ev.message
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) {
    return msg.map((seg) => (seg && seg.type === 'text' && seg.data && typeof seg.data.text === 'string' ? seg.data.text : '')).join('')
  }
  if (ev && typeof ev.raw_message === 'string') return ev.raw_message
  return ''
}

/** 这条消息是否 @ 了机器人（含 @全体 不算） */
export function mentionsSelf(ev, selfId) {
  const msg = ev && ev.message
  if (!Array.isArray(msg)) return false
  return msg.some((seg) => {
    if (!seg || seg.type !== 'at' || !seg.data) return false
    const qq = String(seg.data.qq || '')
    if (!qq || qq === 'all') return false
    return !selfId || qq === String(selfId)
  })
}

/** 白名单 + @ 门控 */
export function shouldAccept(ev, cfg) {
  if (!ev || ev.post_type !== 'message') return { ok: false, reason: 'not-message' }
  const groups = (cfg.allow && cfg.allow.groups) || []
  const users = (cfg.allow && cfg.allow.users) || []
  if (!groups.length && !users.length) return { ok: false, reason: 'empty-whitelist' }
  const isGroup = ev.message_type === 'group'
  const sender = String(ev.user_id || '')
  const group = String(ev.group_id || '')
  if (isGroup) {
    if (!groups.length) return { ok: false, reason: 'group-not-allowed' }
    if (!groups.map(String).includes(group)) return { ok: false, reason: 'group-not-in-whitelist' }
    if (users.length && !users.map(String).includes(sender)) return { ok: false, reason: 'sender-not-in-whitelist' }
    if (cfg.requireMention && !mentionsSelf(ev, cfg.selfId)) return { ok: false, reason: 'no-mention' }
  } else {
    if (!users.length) return { ok: false, reason: 'user-not-allowed' }
    if (!users.map(String).includes(sender)) return { ok: false, reason: 'sender-not-in-whitelist' }
  }
  return { ok: true }
}

/** 去重键：一条消息一个 key，重复上报不会重复建单 */
export function makeKey(ev) {
  const kind = ev.message_type === 'group' ? 'g' : 'u'
  const chat = ev.message_type === 'group' ? String(ev.group_id || '0') : String(ev.user_id || '0')
  const mid = String(ev.message_id || '')
  if (!mid) return ''
  return 'qq:' + kind + ':' + chat + ':' + mid
}

/** 解析控制指令：!工单 <标题> / !task <标题> / !help */
export function parseCommand(text, cfg) {
  const prefix = (cfg && cfg.prefix) || '!'
  const t = String(text || '').trim()
  if (!t.startsWith(prefix)) return { kind: 'none' }
  const rest = t.slice(prefix.length).trim()
  if (!rest) return { kind: 'none' }
  const [head, ...tail] = rest.split(/\s+/)
  const arg = tail.join(' ').trim()
  const cmd = head.toLowerCase()
  if (cmd === '工单' || cmd === 'task' || cmd === 'ticket') {
    return { kind: 'ticket', title: arg || '来自 QQ 的工单（未写标题）' }
  }
  if (cmd === 'help' || cmd === '帮助') return { kind: 'help' }
  return { kind: 'unknown', head }
}

function log(line) {
  try {
    const file = logFile()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {}
}

/** 处理一条事件（纯逻辑，便于单测）：返回 { accepted, action, key, reason } */
export function handleEvent(ev, cfg, push = pushIngress) {
  const accept = shouldAccept(ev, cfg)
  if (!accept.ok) {
    log('skip ' + accept.reason + ' user=' + (ev && ev.user_id) + ' group=' + (ev && ev.group_id))
    return { accepted: false, reason: accept.reason }
  }
  const text = extractText(ev)
  const cmd = parseCommand(text, cfg)
  if (cmd.kind === 'none') {
    log('skip no-command text=' + text.slice(0, 60))
    return { accepted: false, reason: 'no-command' }
  }
  if (cmd.kind === 'help') {
    log('help requested by ' + ev.user_id)
    return { accepted: true, action: 'help' }
  }
  if (cmd.kind === 'unknown') {
    log('skip unknown-command ' + cmd.head)
    return { accepted: false, reason: 'unknown-command' }
  }
  const key = makeKey(ev)
  if (!key) return { accepted: false, reason: 'no-message-id' }
  const title = cmd.title
  const body = '来自 QQ：' + (ev.message_type === 'group' ? '群 ' + ev.group_id : '私聊') + ' / 发送者 ' + ev.user_id + '\n原文：' + text
  // 归属会话：QQ 通道有自己的负责人（决策会话），不靠「最近调用会话」碰运气
  const rec = { source: 'qq', key, title, body, file: cfg.ingressFile }
  if (cfg.sessionId) rec.sessionId = String(cfg.sessionId)
  // push 默认是 pushIngress：它要求显式 file（不猜路径），所以这里把配置里的 ingressFile 传下去
  push(rec)
  log('ingress ' + key + ' title=' + title.slice(0, 60))
  return { accepted: true, action: 'ticket', key, title }
}

// ---------------------------------------------------------------- 运行时
async function main() {
  const cfg = loadConfig()
  if (cfg._missing) log('config missing, using fail-closed defaults: ' + CONFIG_FILE)
  if (!String(cfg.ingressFile || '').trim()) {
    log('REFUSE START: ingressFile 未配置')
    console.error('ingressFile 未配置：请在 ' + CONFIG_FILE + ' 里填 ingressFile（或设环境变量 INGRESS_FILE），且与 kernel 的 ingressFile 是同一个文件。本桥不猜路径。')
    process.exit(3)
  }
  const noWhitelist = !cfg.allow.groups.length && !cfg.allow.users.length
  if (noWhitelist) {
    log('REFUSE START: 白名单为空（fail-closed）。先编辑 ' + CONFIG_FILE + ' 填 allow.groups / allow.users')
    console.error('白名单为空，拒绝启动。请先编辑 ' + CONFIG_FILE)
    process.exit(3)
  }
  if (typeof WebSocket !== 'function') {
    console.error('当前 Node 没有内置 WebSocket（需要 Node 22+）')
    process.exit(4)
  }
  log('start ws=' + cfg.wsUrl + ' groups=' + cfg.allow.groups.length + ' users=' + cfg.allow.users.length + ' requireMention=' + cfg.requireMention)

  let backoff = 1000
  const connect = () => {
    const ws = new WebSocket(cfg.wsUrl)
    ws.addEventListener('open', () => { backoff = 1000; log('ws open') })
    ws.addEventListener('message', (e) => {
      let ev = null
      try { ev = JSON.parse(String(e.data)) } catch { return }
      if (!ev || ev.post_type !== 'message') return
      if (cfg.logRaw) log('raw ' + JSON.stringify(ev).slice(0, 400))
      const r = handleEvent(ev, cfg)
      if (r.accepted && r.action === 'help' && cfg.replyOnAccept) sendReply(ws, ev, '指令：' + cfg.prefix + '工单 <标题>；其余消息不处理')
      if (r.accepted && r.action === 'ticket' && cfg.replyOnAccept) sendReply(ws, ev, '已投递工单：' + r.title + '（2 秒内入库）')
    })
    ws.addEventListener('close', () => { log('ws close, retry in ' + backoff + 'ms'); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000) })
    ws.addEventListener('error', () => { log('ws error') })
  }
  connect()
}

/** 通过 OneBot 发回执（只有白名单内的会话会收到） */
function sendReply(ws, ev, text) {
  try {
    const action = ev.message_type === 'group'
      ? { action: 'send_group_msg', params: { group_id: ev.group_id, message: text } }
      : { action: 'send_private_msg', params: { user_id: ev.user_id, message: text } }
    ws.send(JSON.stringify({ ...action, echo: 'superagent-bridge' }))
  } catch { log('sendReply failed') }
}

if (process.argv.includes('--selftest')) runSelftest()
else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { log('fatal ' + (e && e.message ? e.message : String(e))); console.error(e); process.exit(1) })
}

/** --selftest：纯逻辑自测（不连网、不写任何生产文件；日志落临时目录） */
function runSelftest() {
  const testLog = join(tmpdir(), 'onebot-selftest-' + process.pid + '.log')
  process.env.ONEBOT_BRIDGE_LOG = testLog
  const ok = (c, m) => { if (c) console.log('ok   ' + m); else { console.error('FAIL ' + m); process.exitCode = 1 } }
  const cfg = { ...DEFAULT_CONFIG, selfId: '999', allow: { groups: ['111'], users: ['222'] }, requireMention: true, ingressFile: '' }
  const groupMsg = (text, { at = true, group = '111', user = '222', mid = 1 } = {}) => ({
    post_type: 'message', message_type: 'group', group_id: group, user_id: user, message_id: mid,
    message: [ ...(at ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text } } ],
  })

  ok(shouldAccept(groupMsg('!工单 修个 bug'), cfg).ok === true, '白名单群 + @ + 前缀 → 接受')
  ok(shouldAccept(groupMsg('!工单 x', { at: false }), cfg).reason === 'no-mention', '群里没 @ → 拒绝(no-mention)')
  ok(shouldAccept(groupMsg('!工单 x', { group: '333' }), cfg).reason === 'group-not-in-whitelist', '非白名单群 → 拒绝')
  ok(shouldAccept(groupMsg('!工单 x', { user: '444' }), cfg).reason === 'sender-not-in-whitelist', '非白名单人 → 拒绝')
  ok(shouldAccept(groupMsg('!工单 x'), { ...cfg, allow: { groups: [], users: [] } }).reason === 'empty-whitelist', '空白名单 fail-closed')
  ok(shouldAccept({ post_type: 'message', message_type: 'private', user_id: '222', message_id: 9, message: [{ type: 'text', data: { text: '!工单 私聊' } }] }, cfg).ok === true, '白名单私聊不需要 @')

  ok(parseCommand('!工单 修个 bug', cfg).kind === 'ticket', '解析 !工单')
  ok(parseCommand('!工单 修个 bug', cfg).title === '修个 bug', '标题提取正确')
  ok(parseCommand('!help', cfg).kind === 'help', '解析 !help')
  ok(parseCommand('随便聊聊', cfg).kind === 'none', '无前缀 → none')
  ok(parseCommand('!foo bar', cfg).kind === 'unknown', '未知指令 → unknown')

  ok(makeKey(groupMsg('x')) === 'qq:g:111:1', '去重键格式：' + makeKey(groupMsg('x')))
  ok(extractText(groupMsg('!工单 abc')) === '!工单 abc', '文本拼接去掉了 @ 段')
  ok(mentionsSelf(groupMsg('x'), '999') === true, '@ 自己识别')
  ok(mentionsSelf({ message: [{ type: 'at', data: { qq: 'all' } }] }, '999') === false, '@全体 不算')

  const pushed = []
  const r1 = handleEvent(groupMsg('!工单 真机触发', { mid: 77 }), cfg, (o) => pushed.push(o))
  ok(r1.accepted === true && r1.action === 'ticket' && r1.key === 'qq:g:111:77', 'handleEvent 接受并投递')
  ok(pushed.length === 1 && pushed[0].source === 'qq' && pushed[0].title === '真机触发', '投递内容正确（source=qq）')
  const r2 = handleEvent(groupMsg('聊两句'), cfg, (o) => pushed.push(o))
  ok(r2.accepted === false && pushed.length === 1, '不带指令的群消息不建单')

  try { rmSync(testLog, { force: true }) } catch {}
  console.log(process.exitCode ? 'SELFTEST: FAIL' : 'SELFTEST: ALL PASS')
}
