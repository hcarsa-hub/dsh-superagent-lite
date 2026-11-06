# 已知限制（v0.1.3）

> 这一页只写「已经用真机证明做不到 / 做不全」的事，避免使用者把期望建在沙子上。
> 每条都标明：现象 → 为什么 → 该怎么办。

## 1. 程序化创建会话：宿主认得，但侧栏永远看不到

- **现象**：`sa_new_session {cwd, sessionId?, title?}` 能建出一个可派活的会话（`sessionController.create` 成功、`rename` 设标题成功、`prompt` 能投递），但**侧栏不显示**、`workspace.json` 里也没有它。
- **为什么**：DSH 的侧栏数据源是 `~/.dsh/storages/workspace.json`。我们实测过两条登记路径：
  - `workspaceRegistry.indexLiveSessions()` / `indexHeader()`：返回 `registered=true`，但**文件字节不变**（宿主只改了内存索引）；
  - `workspaceRegistry.rebuildEntities()`：会**打散现有工作区分组**（所有会话变「未分组」），文件本身没坏，重启后恢复 —— 这是事故级副作用，**不要再调**。
- **该怎么办**：
  - 长期团队位（coder/judge/test 这种要长住的）→ **在 UI 里新建会话**，然后用 `sa_role {sessionId, role, model, kind}` 登记；
  - 一次性执行体 → `sa_run {id, provider, model}`（子代理，不占侧栏）；
  - 临时验证 → `sa_new_session` 仍可用，只是别指望 UI 里能找到。

## 2. 压缩（`sa_compact`）：要求目标空闲，且水位不会立刻变

- **要求空闲**：宿主 `compaction.compactNow` 在目标有进行中的回合时会报 `busy`。等它这一轮结束再压。
- **水位滞后**：压缩完立刻看 `ctx-monitor` / `ctx-self` 还是旧值 —— projcache 在下一次请求时才重算。**验证要等目标跑完一轮**（本书实测：judge_1 压完 63.1% 没动，等它回一条消息后变 3.5%）。
- **owner 不能压自己**：`sa_compact` 是 owner-only 且拒绝 owner 自己的会话（避免把正在跑的决策上下文抽掉）。owner 要压得在 UI 手打 `/compact` 或直接换会话接班。

## 3. 按 kind 挑人：标签在，但匹配只在自动派单路径生效

- `sa_role {kind:'code'|'test'|'doc'}` 打标签后，`autoDispatch` 派 `auto:true` 的单时会按工单 `type` 匹配；**没打标签 = `any` = 什么都能接**。
- 手动 `sa_fanout` / `sa_tell` **不看 kind**（这是有意的：人工指定优先）。
- 匹配不上时**不会乱派**，会提醒 owner 自己挑人。

## 4. 面板设置页：需要冷启动才生效，且宿主 webServer 对外一律 403

- 面板 host 半部（`index.js`）改动要**重启 DSH** 才加载；client 半部（`client.js`）要冷启动。
- 从进程外（curl / 脚本）访问 `/superagent/*` 会得到 **403**，所以「设置页保存是否落盘、诊断项数量对不对」只能**人在 UI 里看**，或直接读 `settings.json` 验证落盘。

## 5. `sync-dist.mjs` 的两个模式（v0.1.3 起）

- `node tools/sync-dist.mjs` = 真同步：脱敏 → 写 `dist/index.js` → `node --check` → 跑包内 smoke。
- `node tools/sync-dist.mjs --check` = **只读**：脱敏结果算在内存里与 dist 逐字节比对，一致 `UP-TO-DATE` exit 0，不一致 `DRIFT` exit 1（**不写盘**）。
- 旧版（≤0.1.2）的 `--check` 也会覆盖 dist 并固定打印 OK，属于假绿灯（已修）。

## 6. 上下文监测（`tools/ctx-monitor.mjs`）的边界

- 默认只扫 `--root`（默认 `$DSH_CTX_ROOT` 或 cwd）下的 `subagent/**`，**owner 会话不在范围内**（用 `ctx-self.mjs` / `self-ctx-watch.mjs` 看自己）。
- 阈值默认「官方直连 65% / 其它渠道 85%」，可按 provider 覆盖（`ctxMonitor.thresholds`）。
- 启动参数与 `settings.json.ctxMonitor` 的关系：**参数热读**，但**进程本身**要用新参数重拉才轮到（每轮读的是 settings，不是命令行）。
