# CHANGELOG

## 0.1.4 — 2026-11-07

- 安装模板默认开启 `autoJudge: true` + `judgeRotate: true`：工单到 `ready` 自动送审，多 judge 时轮流派（此前默认不送审 / 全进第一个 judge）。
- README 新增「judge 分流」验收项。
- 自证脚本新增 2 条回归（模板两项必须为 true、README 必须有该验收项）。

## 0.1.3 — 2026-11-07

- 内核 **0.1.8**：全量注释（代码逐行未改）+ 六项修复：
  - `judgeRotate` 从「死开关」变成真轮换（显式 judge id 优先；`autoJudge: true` 时按 `owners.json` 的 judges 轮询）
  - `notifyReadyTo` 真落地（`judge` / `owner` / `both`）
  - `tickIngress` 坏行留痕（此前静默丢弃，offset 却已前进）
  - 新 state 首单不再误触一次 epoch rotate
  - 归档快照加秒 + 撞名 `-N` 后缀（此前同分钟会互相覆盖）
  - watchdog 对非法 `updatedAt` 留痕，不再静默跳过
- 测试：内核侧 36 套离线用例 + 包内 smoke 全绿；新增本批 17 条断言。

## 0.1.2 — 2026-11-07

- 修 `queueDir` 默认值不一致：内核读 `<stateDir>/../queue`、watcher 读 `<home>/.dsh/queue` → 照默认装完 Codex 事件进不了内核。包内 watcher 默认已对齐，README 说明「自定义 `stateDir` 时两处必须逐字相同」。

## 0.1.1 — 2026-11-07

- 修 watcher 模板缺 `sessionId`（默认装完投递必失败）；README 验收从「有 skipped 记录」改成「必须有 `delivered:`」。

## 0.1.0 — 2026-11-06

- 首个可分发版本：内核 31 工具 + 面板 + watcher 三件套；install/uninstall、manifest sha256、脱敏审计、隔离实测。
