# 依赖清单（到底依赖了哪些包）

> **结论**：本插件**不依赖任何第三方插件包**；免费模型、QQ 通道、Codex 桥、watcher 都属**可选配套**，
> 缺任一都只是功能降级，不会加载失败（`subagents`/`schedule` 缺失时给明确错误，不静默失败）。

## A. 硬依赖：**零第三方插件包**

| 依赖 | 说明 | 缺了会怎样 |
|---|---|---|
| **Node 运行时** | 内核 `engines` 为 ≥20；终端安装 Node 与宿主自带运行时分别核对；`index.js` 只 import `node:*` | 版本不满足时不能按受支持安装路径运行 |
| **DSH 宿主本体** | 提供 cordis 运行时与服务容器 | 插件无法加载 |
| npm 依赖 | **没有任何一条**（`package.json` 里没有 `dependencies` / `optionalDependencies` / `peerDependencies`） | — |

## B. 宿主服务依赖（不是插件包，是宿主能力；用 `ctx.inject` / `ctx.get` 获取）

| 服务 | 谁要 | 缺了会怎样 |
|---|---|---|
| `tools` | kernel（必需） | 插件无法注册 32 个工具（等于没装） |
| `schedule` | kernel 投递/提醒、watcher 投递 | `deliver` 抛 `schedule service not ready`：工单能建能改，但**投递不出去**（不静默丢，会报错并重试/积压） |
| `subagents` | `sa_run` / `sa_fanout(models)` | 依赖临时子代理的路径返回明确错误；`sa_fanout(sessionIds)` 使用 schedule，其余工具按各自能力运行，不用旧的「其余 24 个」计数 |
| 宿主 Agent 查找与投递 | `sa_steer` | 仅 owner，经 `typert.lookups.get('agent').resolve(sessionId)` 取 Agent 并 await 投递；不可用或投递失败返回 `{ok:false}`；不支持 Codex 执行体 |
| `webServer` | **面板插件**（不在本包） | 面板路由不注册，UI 不出现 |
| `react` | **面板 client**（宿主注入，不在本包） | 面板渲染不出来 |

## C. 可选配套插件包（内核不依赖，按需挂载）

profile 的 dependencies 登记取决于宿主能否直接解析链接，具体版本分支未验证；登记不能代替 patch，见 [安装操作](install-operations.md)。

| 包 | 作用 | 不装失去什么 |
|---|---|---|
| `dsh-our-free-model`（开源 · MIT · 本机 **2.8.0**） | 提供免费模型（`our-free-model` provider）。上游：[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | 不能选免费模型；框架本身**不调用**它，只把 provider/model 字符串透传给宿主 |
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
| 系统 LibreOffice（soffice） | **本包不需要**。office 技能（`office-recalculate` / `office-render` / `office-export-pdf`）走宿主自带的 `@deepseek-ai/libreoffice-kit` + `libreoffice-kit-win32-x64` 二进制，**不走系统 soffice** | 不影响本插件；若有人按老文档去装系统 LO，是白装 |

## E. 致谢（上游开源项目）

本插件**不打包**下面这些项目的代码，只在运行时把「provider / model 字符串」或「文件投递」交给它们。
用了就要认账，许可证与作者如下：

| 项目 | 作者 / 组织 | 许可证 | 我们怎么用它 |
|---|---|---|---|
| [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | [Ebony-Vinyl](https://github.com/Ebony-Vinyl) | MIT | 免费模型通道（`our-free-model` provider）。**本项目已在其仓库点 Star 支持** |
| [DeepSeek Harness](https://github.com/deepseek-ai) 与本机 `@deepseek-ai/*` 包 | DeepSeek | 见各包 LICENSE | cordis 运行时、`tools`/`schedule`/`subagents` 服务、`libreoffice-kit` |
| Codex CLI | OpenAI | 见上游 | 可选的第二执行体（`sa_delegate_codex`） |

> 免费模型由上游插件提供，**可用性、额度、模型名随时可能变**（见 [models.md](models.md) §3）；
> 本插件不对上游的可用性做任何承诺，也不转发、不代理、不存储任何凭据。

## F. 结论

**本插件不依赖任何第三方插件包。** 缺 `subagents`：`sa_run`/`sa_fanout(models)` 不可用；
缺 `schedule`：投递会报错但工单状态照常维护（积压不丢）；免费模型、QQ 通道、Codex 桥、watcher、面板
全部是**可选配套**，缺任一都只是功能降级。
