# 分层验收：内核必验，配套按需选验

先用 [快速开始](getting-started.md) 完成纯 DSH 首单；所有 `sa_*` 都在会话内请求调用，参数用 JSON。以下为使用者验收方法，本次文档修订未执行安装、重启或宿主验证。

## 内核必验

| 项目 | 操作 | 预期 |
|---|---|---|
| 注册 | 检查 `<stateDir>/lite.log` 的 `tools registered:` 及宿主工具列表 | 32 个 `sa_*`，包含 `sa_steer`、`sa_compact`、`sa_new_session`，无 import 错误 |
| 授权 | owner 调 `sa_whoami {}` | 返回真实 id 与 `role=owner`；否则按 [授权恢复](install-operations.md) 处理 |
| 角色 | owner 调 `sa_agents {}` | owner、worker、judge 为三个独立会话，模型标签与 kind 符合计划 |
| 工单 | 首单显式 `auto:false`，手工 `sa_fanout` | 建单 queued，派活 running；核对投递返回和 worker 接收，不能只看状态 |
| 证据与交活 | 允许根内产物 `sa_attach`，worker `sa_report` 带 `final:true` | manifest 与实际文件一致，单到 ready |
| 送审 | owner `sa_judge`，或已启用 autoJudge 且有 judge 时核对自动投递 | judge 实际收到判据和证据，不因仅登记角色而假定被叫醒 |
| 判词与收口 | judge `sa_verdict` 后 owner 查证据并 `sa_advance` 到 done | pass 仍为 ready，owner 完成收口；done 不能回退 blocked |

内核 README 用途表按工具名去重为 32，与 FACTS 的注册数一致；本副本无 `index.js`，全部 schema 与现场注册结果仍需目标宿主核对，不把静态文本检查当作运行验证。

自动派单另验三个条件：全局 `autoDispatch:true`、单张 `auto:true`（省略默认 true）、已登记且 `kind` 匹配并可接单的 worker。为了避免首单意外被自动派出，首单教程显式关闭自动派单。

`sa_steer` 可在隔离 DSH 测试会话验证：owner 请求调用 `sa_steer {"sessionId":"<测试 Agent id>","text":"<测试约束>","mode":"auto"}`；running 应走 steer，idle/unknown 走 followup。它等待投递结果，同步/异步失败都返回 `{ok:false}`；不修改工单或账本。只用于 DSH Agent，Codex 执行体不支持。授权与失败路径的自动化断言见补丁事实记录，勿对正式任务试投测试消息。

## 面板选验

未安装面板时跳过。冷启动后在宿主 UI 打开「工单」，检查看板、归档、判词和设置/诊断入口；设置保存后核对 `<stateDir>/settings.json`，不要把仅能打开页面当作保存成功。进程外请求可能被宿主拦截，不能据此代替 UI 验收。Windows 才有 `explorer.exe` 定位能力；非 Windows 对应按钮不作为通过条件。

## Codex / hook / watcher 选验

未启用对应桥或 watcher 时分别跳过。先用独立测试 profile 与三个新目录：`<隔离 stateDir>`、`<隔离 queueDir>`、`<隔离 handoff 目录>`；内核和 watcher 指向隔离目录，hook 的 `HANDOFF_QUEUE` 也显式指向隔离队列，投递目标使用测试会话。核对解析后的绝对路径均落在测试根下，绝不向正式队列追加样例。

日志与状态的**实际绝对位置**按下表取得，不使用文档作者的机器路径：

| 记录 | 定位 |
|---|---|
| 内核日志/游标 | 先调用 `sa_status {}` 取得状态文件位置；日志为该目录下 `lite.log`，游标在 `state.json` 的 `codexOffset` |
| hook 日志/事件 | 显式 `HANDOFF_QUEUE` 解析后的绝对目录下 `hook.log`、`events.jsonl`、`last.json`；hook 是否使用此日志位置需按所带脚本确认，本副本未带脚本，未验证 |
| watcher 日志 | 从 watcher 启动日志/配置核对实际 `watch.log` 路径；此副本未带 watcher 源码，默认日志位置未验证，不能假定与 stateDir 相同 |
| 隔离队列路径 | PowerShell 用 `Resolve-Path -LiteralPath '<隔离 queueDir>'`；Bash 在该目录内 `pwd -P`，将实际值记录进验收报告 |

以下 PowerShell 仅在**已确认的隔离测试根**内构造普通 handoff 事件；先将占位符替换为已有测试根的绝对路径：

```powershell
$labDir = (Resolve-Path -LiteralPath '<隔离测试根绝对路径>').Path
$labQueue = Join-Path $labDir 'queue'
$labHandoff = Join-Path $labDir 'handoff'
New-Item -ItemType Directory -Path $labQueue,$labHandoff -Force | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$sampleFile = Join-Path $labHandoff 'ordinary-handoff.md'
[System.IO.File]::WriteAllText($sampleFile, "# 隔离投递样例`n普通 handoff，无工单标记。`n", $utf8NoBom)
$sampleInfo = Get-Item -LiteralPath $sampleFile
$eventLine = [ordered]@{
  ts = [DateTimeOffset]::UtcNow.ToString('o')
  sessionId = '<测试来源 id>'
  turnId = '<本轮唯一测试 id>'
  cwd = $labDir
  file = $sampleFile
  mtimeMs = ([DateTimeOffset]$sampleInfo.LastWriteTimeUtc).ToUnixTimeMilliseconds()
  size = $sampleInfo.Length
} | ConvertTo-Json -Compress
[System.IO.File]::AppendAllText((Join-Path $labQueue 'events.jsonl'), $eventLine + "`n", $utf8NoBom)
```

这是文件消费样例，只能验证读取/投递分支；它没有执行 Codex 或 hook。测试前将 watcher 配到 `$labQueue` 并设置测试接收会话，样例使用唯一文件与 turnId，避免去重。预期为 `watcher started: ... session=...` 目标非空，随后出现 `delivered: <样例文件>` 且测试会话实际收到消息。只有 skipped 不能证明投递成功；投递失败先查目标与服务，不能直接重放到正式队列。

内核 `tickCodex` 另用隔离工单测试：先配置隔离 `inboxFile` 并正常 `sa_delegate_codex` 得到 running、backend=codex 的测试单；handoff 内容需带对应 `sa-ticket: <测试单号>`。随后按所带桥的契约产生完整事件行。预期为该测试单进入 ready、`codexOffset` 随已消费字节增长；watcher 启用 `skipSuperagentHandoff:true` 时跳过该票是正常分工。普通 handoff 样例不能证明内核工单收口成功。

要验证 hook 本身，还需在测试环境真实完成一次 Codex 回合，检查 hook 新日志与队列新事件，再检查消费端。事件字段沿用 [Codex 桥契约说明](prompts/codex.md)，目标 Codex 版本与 hook 兼容性**未验证**。游标不增长也可能是 hook 没运行、无新事件、半行、重复/陈旧 handoff 或配置错误，应逐层检查。

judge 轮换属于额外策略检查：在隔离环境启用 `autoJudge:true`、`judgeRotate:true` 并登记两个独立 judge，再让两张单 ready，核对指派与日志；只有一个 judge 时固定指派正常，不要求安装者额外开第二个才能完成首单。

## 维护者闸门与证据边界

发布仓/捆绑包未必包含开发工具，使用者不要照抄不存在的根 `tools/audit.mjs` 或 `tools/isolate-test.mjs`。维护者应在包含工具源码的开发交付中按其实际脚本入口执行审计、模拟和 smoke，不从本页推断路径。

补丁后的 FACTS 记录：bundle-audit H 组按 manifest 比对 dir/name/version，拒绝缺失、空、重复和非法条目；bundle-simulate 有 11 条业务断言，子命令非零会使整体失败；kernel smoke 有 195 条断言，覆盖 `sa_steer` running/idle/异步/错误/账本不变路径。这些是上游补丁事实，**不是本次文档工单重新运行的结果**。
