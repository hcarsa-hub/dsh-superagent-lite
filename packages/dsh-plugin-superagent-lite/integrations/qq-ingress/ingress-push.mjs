#!/usr/bin/env node
/**
 * ingress 队列最小写入器 —— 往 kernel 的 ingress.jsonl 追加一条外部事件。
 *
 * 契约（详见 contract.md）：
 *   行 = {at?, source, key, title, body?, sessionId?}；**key 必填**（kernel 按它去重）
 *
 * 显式路径：本脚本**不猜任何路径**。目标文件来自
 *   --file <path>   →   环境变量 INGRESS_FILE   →   否则直接报错退出
 * （它必须等于 kernel config 里的 ingressFile；两边不一致 = 事件永远没人消费。）
 *
 * 用法：
 *   node ingress-push.mjs --file <ingress.jsonl> --source qq --key <去重键> --title <标题> [--body <正文>] [--session <会话 id>]
 *   INGRESS_FILE=<ingress.jsonl> node ingress-push.mjs --source ... --key ... --title ...
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const MISSING_FILE_MSG = '未指定 ingress 文件：请用 --file <path> 或环境变量 INGRESS_FILE 指定，并且与 dsh-plugin-superagent-lite 的 config.ingressFile 保持一致（本脚本不会替你猜路径）。'

/** 解析目标文件：参数 → 环境变量 → 报错（不猜） */
export function resolveIngressFile(explicit) {
  const file = String(explicit || process.env.INGRESS_FILE || '').trim()
  if (!file) throw new Error(MISSING_FILE_MSG)
  return file
}

/** 追加一条 ingress 事件（file 必须显式给，或从 INGRESS_FILE 读） */
export function pushIngress({ source, key, title, body = '', file, sessionId = '' }) {
  if (!source || !key || !title) throw new Error('source/key/title 必填')
  const target = resolveIngressFile(file)
  const rec = { at: new Date().toISOString(), source: String(source), key: String(key), title: String(title).slice(0, 200), body: String(body).slice(0, 4000) }
  // 通道可以指定归属会话（QQ 工单归决策会话），不填就走 kernel 的兜底链
  if (sessionId) rec.sessionId = String(sessionId)
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, JSON.stringify(rec) + '\n', 'utf8')
  return rec
}

// 只有「被 node 直接跑」时才执行 CLI；被 import 时什么都不做
const isEntry = (() => {
  try { return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url } catch { return false }
})()
if (isEntry) {
  const args = process.argv.slice(2)
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
  const source = get('--source', '')
  const key = get('--key', '')
  const title = get('--title', '')
  const body = get('--body', '')
  const sessionId = get('--session', '')
  let file = ''
  try { file = resolveIngressFile(get('--file', '')) } catch (e) {
    console.error('[ingress-push] ' + e.message)
    console.error('用法: node ingress-push.mjs --file <ingress.jsonl> --source qq --key <去重键> --title <标题> [--body <正文>] [--session <会话 id>]')
    process.exit(2)
  }
  if (!source || !key || !title) {
    console.error('用法: node ingress-push.mjs --file <ingress.jsonl> --source qq --key <去重键> --title <标题> [--body <正文>] [--session <会话 id>]')
    process.exit(2)
  }
  const rec = pushIngress({ source, key, title, body, file, sessionId })
  console.log(JSON.stringify({ ok: true, file, ...rec }, null, 1))
}
