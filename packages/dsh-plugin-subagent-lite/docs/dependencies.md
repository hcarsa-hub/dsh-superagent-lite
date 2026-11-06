# 依赖清单（到底依赖了哪些包）

> **结论**：本插件**不依赖任何第三方插件包**；免费模型、QQ 通道、Codex 桥、watcher 都属**可选配套**，
> 缺任一都只是功能降级，不会加载失败（`subagents`/`schedule` 缺失时给明确错误，不静默失败）。

## A. 硬依赖：**零第三方插件包**

| 依赖 | 说明 | 缺了会怎样 |
|---|---|---|
| **Node 运行时** | 宿主自带；`index.js` **只 import `node:*`**（`node:fs` / `node:crypto` / `node:path` / `node:os`） | 跑不起来（宿主本身也起不来） |
| **DSH 宿主本体** | 提供 cordis 运行时与服务容器 | 插件无法加载 |
| npm 依赖 | **没有任何一条**（`package.json` 里没有 `dependencies` / `optionalDependencies` / `peerDependencies`） | — |

## B. 宿主服务依赖（不是插件包，是宿主能力；用 `ctx.inject` / `ctx.get` 获取）

| 服务 | 谁要 | 缺了会怎样 |
|---|---|---|
| `tools` | kernel（必需） | 插件无法注册 30 个工具（等于没装） |
| `schedule` | kernel 投递/提醒、watcher 投递 | `deliver` 抛 `schedule service not ready`：工单能建能改，但**投递不出去**（不静默丢，会报错并重试/积压） |
| `subagents` | `sa_run` / `sa_fanout` | 这两个工具返回明确错误（现文案含「本插件未启用 subagent 能力 / subagent 能力未启用」，旧版为 `subagents service unavailable`），**其余 24 个照常**；宿主没开 delegation 就是这种 |
| `webServer` | **面板插件**（不在本包） | 面板路由不注册，UI 不出现 |
| `react` | **面板 client**（宿主注入，不在本包） | 面板渲染不出来 |

## C. 可选配套插件包（**不写 dependencies**，只在 README/docs 指路）

| 包 | 作用 | 不装失去什么 |
|---|---|---|
| `dsh-our-free-model`（本机 2.1.0） | 提供免费模型（`our-free-model` provider） | 不能选免费模型；框架本身**不调用**它，只把 provider/model 字符串透传给宿主 |
| `dsh-qq-plugin`（本机 1.0.5，腾讯官方机器人平台） | 手机 ↔ 会话聊天通道，提供 `notify_qq` / `send_to_qq` | 不能从 QQ 聊天/推送；工单流程照跑（本包不调用它的工具） |
| `dsh-plugin-handoff-watch`（本包配套） | 把普通 handoff 文件投递到会话 | 普通 handoff 不自动投递；kernel 的 `tickCodex` 仍在 |
| 未来的面板包 | 图形界面 | 只能命令行/工具操作 |

## D. 外部程序（不是 npm 包，运维层）

| 程序 | 用途 | 缺了会怎样 |
|---|---|---|
| Codex CLI | Stop hook 来源、`sa_delegate_codex` 的执行体 | 不能派给 Codex；DSH worker 会话照用 |
| NapCat + QQ 客户端（小号） | QQ 触发通道 | 不能从 QQ 建单 |
| `explorer.exe`（Windows） | 面板「定位文件」 | 该按钮在非 Windows 不可用（面板功能，不影响 kernel） |
| 本包自带脚本 | `onebot-bridge.mjs`、`codex-stop-hook.mjs`、`request-hook.mjs`（工具脚本，不在内核） | 对应集成不工作，内核不受影响 、**`tools/ctx-monitor.mjs`**（上下文监测，可选、默认不启动，见 [`ctx-monitor.md`](ctx-monitor.md)）　|

## E. 结论

**本插件不依赖任何第三方插件包。** 缺 `subagents`：只有 `sa_run`/`sa_fanout` 不可用；
缺 `schedule`：投递会报错但工单状态照常维护（积压不丢）；免费模型、QQ 通道、Codex 桥、watcher、面板
全部是**可选配套**，缺任一都只是功能降级。
