# CHANGELOG

## 0.1.6 — 2026-11-09

- **安装文档大幅更新**：新增 `docs/install-operations.md`（安装前检查 / 让宿主解析包 / 首次授权与 `owners.json` 恢复 / 卸载顺序 / 升级回滚）；重写 `docs/getting-started.md`（§0.1 检查表、§9 `attachRoots`、`ownerSessions` 只播种一次的补救）。交给 agent 也能照着装完并建出第一张单。
- **决策者（owner）文档**：`docs/decision-playbook.md` 重写为十步闭环（每步写清判断 / 证据 / 断点）+ 十一根原则 + 事故库；配 `docs/prompts/owner.md` 可直接抄的 AGENTS 模板。
- **新增内核工具 `sa_steer`**（工具 31 → **32**）：目标 running 时插到下一步、idle 时起新回合；仅 owner；`await` 投递，失败显式 `{ok:false}`。**仅适配 DSH 生态**，Codex 等外部执行体不支持。
- **内核改名**：包名 `dsh-plugin-subagent-lite` → **`dsh-plugin-superagent-lite`**，短 id 同步为 `superagent-lite`；升级需把 patch 的 `name` 与 junction 名一起换（数据结构不变）。
- **打包链修复**：卸载器 5 目标预检、遇真实目录整次拒绝（exit 3）；安装器备份冲突先拒后写；`sa_steer` 异步失败不再假成功；模拟器不再吞子命令失败。
- **上下文监测**：新增压缩检出（两轮 pct 回落 ≥15 点判为被压缩）与 `--brief=judge|worker|owner` 压缩后自检简报。
- **新增 `bundle-name-audit` 闸门**（16 项）：旧名残留 / 四处身份 / 归档条目 / manifest 一致性；本版旧名残留 0。
- **文档一致性**：工具数全包统一 32；新增 `docs/verification.md`；`system-radial` 头图重渲染为 32；README / NOTICE / 本 CHANGELOG 重写；界面截图更新为 `docs/screenshots/panel-20261109-*.png`（看板 / 表格+判词 / 归档 / 设置）。
- 门禁：kernel smoke ALL PASS（195 断言）、name-audit 16/16、bundle-audit A–M 全 PASS、isolate 6/6、simulate 11/11。
## 0.1.5 — 2026-11-07

- **面板体验修复（client 半部）**：输入框上方的工单 dock 改为**默认收起**（只一行摘要 + 「N 条 · 展开」），有活跃工单时不再挤占宿主提示区；侧栏「工单」的未读角标改为**绝对定位**，不再把标签顶偏。
- 新增 `docs/screenshots/` 三张真实界面图（看板 / 表格与判词 / 设置体检），README 增加「界面」一节。

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
