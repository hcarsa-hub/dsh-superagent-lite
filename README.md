# dsh-superagent-lite

**给 DSH（DeepSeek Harness）用的轻量「工单 / 派活 / 双筛」框架。**

> 仓库：https://github.com/hcarsa-hub/dsh-superagent-lite · 许可 MIT 三个插件打包成一个可直接安装的捆绑包：

| 目录 | 包名 @ 版本 | 作用 |
|---|---|---|
| `packages/dsh-plugin-subagent-lite` | `dsh-plugin-subagent-lite@0.1.8` | 工单内核：**31 个 `sa_*` 工具**、状态机、证据链、双筛（worker → judge → owner）、自动派单、judge 轮换、`sa_compact` |
| `packages/superagent-lite-panel` | `dsh-superagent-lite-panel@1.0.0` | 面板（host + client 半部）：工单 / 归档 / 判词 / 设置 / 诊断 |
| `packages/handoff-watch` | `dsh-plugin-handoff-watch@0.3.0` | handoff watcher：把 Codex 回合结束事件投递到会话（跳过 superagent 自己的票） |
| `cordis.patch.bundle.yml` | — | 三条 `insert`，贴到 `<profile>/cordis.patch.yml` 末尾 |
| `install.mjs` / `uninstall.mjs` | — | 建/删 junction（3 个主名 + 2 个兼容别名）；**默认 dry-run** |

内核里 **31 个 `sa_*` 工具**：工单（submit/advance/list/next/transfer/archive/evidence/attach）、派活（run/fanout/tell/role/agents/owners）、双筛（judge/verdict/report/escalate/requirements）、运维（watchdog/progress/compact/sendback/ingress/stats/whoami/archive/restore）。

## 快速开始（三步，全部可回滚）

```powershell
# 1) 先看计划（不动文件）
node install.mjs

# 2) 真装：备份 patch → 建 5 个 junction → 追加三条 insert（按 id 幂等）
node install.mjs --apply

# 3) 重启 DSH（client 半部必须冷启动），再按下面清单核对
```

装完必须**手工改 `cordis.patch.yml` 里的 4 处 TODO**：

| 位置 | 填什么 | 不填的后果 |
|---|---|---|
| 内核 `ownerSessions` | 你的会话 id（`sa_whoami` 能查到） | 所有写工具被拒（`role=none`） |
| 面板 `sessionId` | 同上 | 面板没有默认投递目标 |
| watcher `sessionId` | 同上 | **handoff 自动投递直接断**（宿主进程没有 `DSH_SESSION_ID`） |
| 三处 `queueDir` | 同一目录（默认空 = 内核 `<stateDir>/../queue`、watcher `<home>/.dsh/queue`，默认 stateDir 下一致；**自定义 `stateDir` 时两处必须逐字相同**） | Codex 事件进不了内核（`codexOffset` 恒 0） |

模板默认已经开了 **`autoJudge: true` + `judgeRotate: true`**：工单到 `ready` 会自动送审给 `owners.json` 里登记的第一个 judge，多个 judge 时轮流派；没登记 judge 时自动跳过，通知仍发给 owner。

## 验收清单（贴命令，看末行）

| 项 | 怎么看 | 期望 |
|---|---|---|
| 内核加载 | `lite.log` 最后一条 `tools registered:` | **31 个** `sa_*`，含 `sa_compact` |
| 写权限 | `sa_whoami` | `role=owner` |
| 建单 | `sa_submit { title:"smoke", type:"test" }` | 返回 `sa-001`（或当前纪元号） |
| 面板 | 侧栏「工单」入口 + 面板页 | 四页可点、设置页能保存 |
| watcher 启动 | `watch.log` 里 `watcher started: … session=…` | `session=` 后面**不为空** |
| watcher 真投递 | 往 `queue/events.jsonl` 投一条真 handoff | 必须出现 **`delivered: <文件>`**（只有 `skipped` 不算通过） |
| 内核吃事件 | 投事件后看 `state.json` 的 `codexOffset` | **值变大**（恒 0 = 两个 `queueDir` 解析到了不同目录） |
| judge 分流 | 两张 `type:test` 单推到 `ready` | `lite.log` 出现 `judge-rotate pick=…` 且两张单 judge 不同（只登记 1 个 judge 时固定进它，属正常） |
| 无报错 | 宿主日志搜 `failed to import` | 0 条 |

```powershell
# 自检工具（对仓库根跑，会建临时 profile、不碰你的真实环境）
node tools/audit.mjs .          # 安全/隔离审计（脱敏、凭据、绝对路径、动态执行…）
node tools/simulate.mjs .       # 安装器自证（临时 profile：建链/追加/幂等/卸载）
node tools/isolate-test.mjs .   # 隔离实测（临时目录装一遍、跑内核 smoke、核 manifest）
```

## 卸载 / 回滚

```powershell
node uninstall.mjs        # 删 5 个 junction（3 主名 + 2 别名）
# 再把 cordis.patch.yml 里三条 insert 注释掉，或恢复 install 时生成的 .bak-bundle-<时间戳>
# 重启 DSH
```

## 它解决什么问题

一个 agent 干活，**没有账本、没有验收、没有留痕**是常态。这套东西把「任务」变成有状态的对象：

```
queued ──派活──▶ running ──交活──▶ ready ──judge 判──▶ done
   │                │                 │
   └────────────────┴─────────────────┴──▶ blocked（任何态都可进；blocked → queued/done）
```

- **角色分层**：owner（决策/派活/收口）· worker（执行、交证据）· judge（独立验收）
- **证据链**：产物登记进 `evidence/<ticket>/` + 自报 + 判词，全部落盘可追溯
- **双筛**：worker 交的东西先过 judge（`sa_verdict`），owner 只做机械核验与收口
- **不绑模型**：worker 可以是 Codex、也可以是另一个 DSH 会话；`sa_run` / `sa_fanout` 两种派法
- **不碰宿主内部**：只通过 DSH 的 `tools` / `schedule` / `sessionController` 公开服务交互

## 已知边界（不是 bug）

- 面板设置页/诊断要**冷启动**才全生效；host 半部改 patch 会热重载，但 **plugin config 是加载时读一次**——改 `autoJudge` 这类键要重启（或换新 id 重新挂载）。
- `sa_compact` 要求目标会话空闲；压缩后上下文水位要等目标跑完一轮才刷新。
- 程序化建的会话（`sa_new_session`）**侧栏不显示**（宿主不写 `workspace.json`），属宿主限制。
- 本仓库不含 QQ / Codex 运行环境（NapCat、`codex.exe`），它们属外部依赖；桥脚本在 `packages/dsh-plugin-subagent-lite/integrations/` 只有参考实现。
- 内核 `docs/diagrams/` 带了系统框图与状态机图（PNG 占了大半体积），不需要可以删。

## 设计取舍

1. **不打成 npm 依赖树**：宿主按 `dsh.bundle.patch` + junction 装载插件；写 `dependencies` 只会把代码拖进 `node_modules` 且升级不可控。
2. **不改包名**：`package.json` name / `index.js` 的 `export const name` / `client.js` 的 `__ModuleLoader__.load({id})` / 自带 `cordis.patch.yml` 四处必须同名，否则插件整块不生效（踩过两次）。
3. **脱敏**：包内不出现本机路径与会话 id，默认值统一成 `~/.dsh/subagent`；真实路径由 patch config 提供。
4. **可校验**：`manifest.json` 记录每个文件的 sha256（随 release 提供），解包后可逐字节核。

## 许可与致谢

- 代码：**MIT**（见 `LICENSE`）
- 外部项目引用与致谢见 [`NOTICE.md`](./NOTICE.md)：设计上参考了 DeepSeek 官方开源的 **Super-Agent**（`dsh-superagent-prototype`）的问题视角与角色分层，**代码为独立编写、未复制其源码**。

## 目录结构

```
.
├─ packages/                  三个插件（可直接 junction 到 <profile>/node_modules）
│  ├─ dsh-plugin-subagent-lite/   内核（index.js 含全量注释）
│  ├─ superagent-lite-panel/      面板（host + client）
│  └─ handoff-watch/              watcher
├─ tools/                     审计 / 安装器自证 / 隔离实测
├─ cordis.patch.bundle.yml    三条 insert 模板
├─ install.mjs / uninstall.mjs
├─ LICENSE · NOTICE.md · CHANGELOG.md
```
