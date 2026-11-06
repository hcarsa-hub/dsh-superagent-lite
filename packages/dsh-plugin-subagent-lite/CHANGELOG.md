## 0.1.8 — 2026-11-07

- **judgeRotate 真落地**：以前是死开关（内核 0 引用，面板却渲染开关）。现在 `autoJudge` 显式给会话 id → 永远用它；`autoJudge: true` → 用 `roles.judges`，`judgeRotate` 开则轮询（内存游标），关则固定 `judges[0]`。
- **notifyReadyTo 真落地**：`judge` / `owner` / `both`，默认沿用旧行为（autoJudge 开→judge，关→owner）；`owner` 时明确不送审。
- **tickIngress 坏行留痕**：以前 `catch { continue }` 且 offset 已推进 → 坏行被永久静默丢弃。现在留 `ingress bad-line offset=… head=…` 日志（offset 仍前进，坏行不卡队列）。
- **prefixFor(seq=0)**：新 state 首单不再误触一次 epoch rotate（`Math.max(1, seq)`）。
- **归档快照不再覆盖**：`archiveStamp` 加秒；撞名再加 `-2/-3` 后缀（快照是事后唯一能取回的东西，不许静默覆盖）。
- **watchdog 遇非法 `updatedAt`**：不再静默 skip，记 `watchdog skip <id> reason=bad-updatedAt`。
- **全量注释**：index.js 从 3,410 行增至 3,6xx 行，净增 ~25KB 注释（代码逐行未改，由 4 个 worker 分片标注 + owner 机械校验）。
- 测试：36 个 `_test-*.mjs` 全通过 + 新增 `_test-batch-20261107.mjs`（17 断言覆盖本批 6 项修复）。

## 0.1.1 — 2026-11-06

- 内核同步：194（`sa_report final:true` 自动 ready / `autoJudge` 自动送审 / `sa_tell {ticketId}` 追加需求 / `sa_requirements`）、195（`sa_sendback` 回传 / `quietSources` / `type=doc` 轻判据）、201（`sa_new_session` 程序化建会话，`sessionCreateRoots` 默认全拒）、199（settings 覆盖 config）、202（默认自动派单 / judge fail 自动复活一次 / 积压提醒）。
- 工具数 26 → **29**；`autoJudge` 默认 **关闭**，需显式配置。

- 同步内核：加入 194（`sa_report final:true` 自动转 ready / `autoJudge` 自动送审 / 追加需求 `sa_tell {ticketId}` / `sa_requirements`）与 195（`sa_run` 后 `sa_sendback` 回传 / `quietSources` 静默来源 / `type=doc` 轻判据）。
- 注：`autoJudge` 默认 **关闭**，需在 config 或 settings 里显式开启。

# Changelog

## 0.1.0 (2026-11-06)

首个可分发包 `dsh-plugin-subagent-lite`（从内部工单内核泛化而来；包名/仓库名均查重无冲突）：

- 命名：npm/GitHub 定名 `dsh-plugin-subagent-lite`；插件 id 仍是 `subagent-lite`；README 首句与 description 明确「工单/派活/双筛内核，不是 subagent provider」
- 新增可选的 `integrations/codex-bridge/`（Stop/PermissionRequest hook、`contract.md`、`hooks.json.example`、可选 watcher 插件）
- 新增 `docs/models.md`（三条模型路由写法、`saRunAllow` 白名单语义）
- README 新增「本插件会/不会创建什么」；`docs/config.md` 增加「副作用」列

- 数据目录可移植：默认 `~/.dsh/subagent`，可用 `stateDir` 覆盖（原实现写死了一个本机绝对路径）。
- `subagents`（delegation）改为**可选**：宿主未提供时插件照常加载，26 个工具里只有 `sa_run` / `sa_fanout` 返回明确错误。
- 外部通路默认关闭：`queueDir` / `inboxFile` / `ingressFile` 默认空字符串，空即不读不写。
- 安全默认值：`ownerSessions` 默认空（空则所有写工具拒绝并提示先配置）、`autoDispatch` 默认 false、`watchdogAlerts` 默认 false。
- 新增离线冒烟测试 `test/smoke.mjs`（零依赖、临时目录、末尾打印 `SMOKE: ALL PASS`）。
- 新增 `scripts/install.mjs` / `scripts/uninstall.mjs`（建/删 link，不自动改宿主文件）。
- 全量脱敏：不含任何本机路径、会话 id、人名或内部工区名。
