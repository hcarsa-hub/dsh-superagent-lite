// sa-196：设置契约 v2（新键校验 / 缺键默认 / 生效值合并 / 写后回读）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { apply, normalizeSettings, effectiveSettings, readSettingsFile, writeSettingsQuiet, SETTINGS_DEFAULTS, APPLY_MODES } from './index.js'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); fails++ } else console.log('ok   ' + m) }
const throws = (fn, re, m) => { try { fn(); ok(false, m + '（没抛）') } catch (e) { ok(re.test(String(e && e.message)), m + '：' + String(e && e.message).slice(0, 60)) } }
const dir = fs.mkdtempSync(join(os.tmpdir(), 'sa-set2-'))
function routes(stateDir) {
  let handler
  apply({ inject: (_n, cb) => cb({ effect: (fn) => fn(), webServer: { register: (r) => { handler = r.handler; return () => {} } } }) }, { stateDir })
  return (path, body, method = body === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const events = {}
    const timer = setTimeout(() => reject(new Error('timeout ' + path)), 3000)
    const req = { url: '/superagent' + path, method, headers: { 'content-type': 'application/json' }, on: (ev, fn) => { (events[ev] ||= []).push(fn); return req }, destroy: () => {} }
    const res = { statusCode: 0, setHeader: () => {}, end: (text) => { clearTimeout(timer); try { resolve({ status: res.statusCode, json: JSON.parse(text) }) } catch (e) { reject(e) } } }
    Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e) })
    if (method === 'POST') { const raw = JSON.stringify(body === undefined ? {} : body); for (const fn of events.data || []) fn(Buffer.from(raw)); for (const fn of events.end || []) fn() }
  })
}
const call = routes(dir)

// ---- 1. 合法值 ----
const good = normalizeSettings({
  autoJudge: 'session-judge-1',
  judgeRotate: false,
  notifyReadyTo: 'owner',
  quietSources: ['qq', 'cron', 'qq'],
  deliverOut: { mode: 'onebot', apiBase: 'http://127.0.0.1:3001', onlyWhenDone: true, maxBytes: 1024 * 1024 },
  docJudge: true,
  docCriteria: ['改动是否最小', '原文件是否完整'],
  notifyEvents: { verdictFail: false, docDone: true },
  refreshMs: 2000,
  defaultTab: 'stats',
  theme: 'dark',
  ctxMonitor: { enabled: true, intervalSec: 30, thresholdOfficial: 70, thresholdOther: 80, thresholds: [{ provider: 'trae', pct: 75 }], alertIngress: false },
})
ok(good.autoJudge === 'session-judge-1', 'autoJudge 字符串通过')
ok(good.judgeRotate === false, 'judgeRotate 布尔')
ok(good.notifyReadyTo === 'owner', 'notifyReadyTo 枚举')
ok(Array.isArray(good.quietSources) && good.quietSources.length === 2 && good.quietSources[0] === 'qq', 'quietSources 去重（' + good.quietSources.join(',') + '）')
ok(good.deliverOut.mode === 'onebot' && good.deliverOut.apiBase === 'http://127.0.0.1:3001', 'deliverOut onebot')
ok(good.docCriteria.length === 2, 'docCriteria 数组')
ok(good.notifyEvents.verdictFail === false && good.notifyEvents.docDone === true, 'notifyEvents 部分覆盖')
ok(good.ctxMonitor.intervalSec === 30 && good.ctxMonitor.thresholds[0].provider === 'trae', 'ctxMonitor 嵌套')
ok(good.autoJudge === true ? false : true, 'autoJudge 不是 true（示例字符串）')

// ---- 2. 非法值 ----
throws(() => normalizeSettings({ notifyReadyTo: 'nobody' }), /notifyReadyTo/, 'notifyReadyTo 非法枚举')
throws(() => normalizeSettings({ deliverOut: { mode: 'onebot', apiBase: 'http://evil.example.com:3001' } }), /apiBase/, 'deliverOut 非本机地址')
throws(() => normalizeSettings({ deliverOut: { mode: 'hostTool' } }), /deliverOut\.tool/, 'hostTool 缺 tool')
throws(() => normalizeSettings({ quietSources: 'qq' }), /数组/, 'quietSources 非数组')
throws(() => normalizeSettings({ autoJudge: 123 }), /autoJudge/, 'autoJudge 非布尔非字符串')
throws(() => normalizeSettings({ refreshMs: 10 }), /refreshMs/, 'refreshMs 过小')
throws(() => normalizeSettings({ theme: 'pink' }), /theme/, 'theme 非法')
throws(() => normalizeSettings({ ctxMonitor: { intervalSec: 5 } }), /intervalSec/, 'ctxMonitor.intervalSec 过小')
throws(() => normalizeSettings({ ctxMonitor: { thresholds: [{ provider: 'x', pct: 120 }] } }), /pct/, 'thresholds.pct 越界')
throws(() => normalizeSettings({ runningTimeoutMs: 10 }), /runningTimeoutMs/, '旧键仍校验')

// ---- 3. 缺键默认 ----
ok(JSON.stringify(normalizeSettings({})) === '{}', '空对象 → 不产生任何键（缺键用默认）')
const eff0 = effectiveSettings(join(dir, 'empty-state'))
ok(eff0.autoJudge === false && eff0.notifyReadyTo === 'judge', 'effective 默认：autoJudge=false / notifyReadyTo=judge')
ok(eff0.ctxMonitor.enabled === false && eff0.ctxMonitor.thresholdOfficial === 65, 'effective 默认 ctxMonitor 关闭 + 65/85')
ok(SETTINGS_DEFAULTS.autoJudge === false, 'SETTINGS_DEFAULTS 含 autoJudge')
for (const k of ['autoJudge', 'judgeRotate', 'notifyReadyTo', 'quietSources', 'deliverOut', 'docJudge', 'docCriteria', 'notifyEvents', 'refreshMs', 'defaultTab', 'theme', 'ctxMonitor']) {
  ok(APPLY_MODES[k] === 'hot', 'applyModes[' + k + '] = hot')
}

// ---- 4. GET /settings：默认值 + 生效值两列 ----
let r = await call('/settings')
ok(r.status === 200 && r.json.ok === true, 'GET /settings 200')
ok(r.json.defaults && r.json.defaults.autoJudge === false, 'GET 返回 defaults（含新键）')
ok(r.json.effective && r.json.effective.ctxMonitor.intervalSec === 60, 'GET 返回 effective（嵌套默认）')
ok(r.json.applyModes && r.json.applyModes.ctxMonitor === 'hot', 'GET 返回 applyModes')

// ---- 5. POST 合法 → 写盘 + 回读；非法 → 400 且文件不变 ----
r = await call('/settings', { autoJudge: 'session-judge-1', quietSources: ['qq'], ctxMonitor: { intervalSec: 30 } })
ok(r.status === 200 && r.json.ok === true, 'POST 合法设置 200')
const file = join(dir, 'settings.json')
const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
ok(disk.autoJudge === 'session-judge-1' && disk.quietSources[0] === 'qq', '写盘内容正确')
ok(disk.ctxMonitor.intervalSec === 30 && disk.ctxMonitor.enabled === undefined, '嵌套部分写入只落该键')
r = await call('/settings')
ok(r.json.settings.autoJudge === 'session-judge-1', 'GET 回读文件值')
ok(r.json.effective.ctxMonitor.intervalSec === 30 && r.json.effective.ctxMonitor.thresholdOfficial === 65, '生效值 = 文件值深合并默认')
const before = fs.readFileSync(file, 'utf8')
r = await call('/settings', { notifyReadyTo: 'nobody' })
ok(r.status === 400 && /notifyReadyTo/.test(String(r.json.error)), '非法值 → 400')
ok(fs.readFileSync(file, 'utf8') === before, '非法值不写盘（文件字节不变）')

// ---- 6. writeSettingsQuiet 深合并 ----
writeSettingsQuiet(dir, { ctxMonitor: { enabled: true }, notifyEvents: { watchdog: false } })
const cur = readSettingsFile(dir)
ok(cur.ctxMonitor.enabled === true && cur.ctxMonitor.intervalSec === 30, 'writeSettingsQuiet 深合并 ctxMonitor')
ok(cur.notifyEvents.watchdog === false, 'writeSettingsQuiet 深合并 notifyEvents（写入的键生效）')
ok(effectiveSettings(dir).notifyEvents.verdictFail === true, '未写的 notifyEvents 键由默认值补齐（有效值仍完整）')

fs.rmSync(dir, { recursive: true, force: true })
console.log('')
console.log(fails === 0 ? 'settings-v2: ALL PASS' : 'settings-v2: FAIL ' + fails)
process.exit(fails ? 1 : 0)
