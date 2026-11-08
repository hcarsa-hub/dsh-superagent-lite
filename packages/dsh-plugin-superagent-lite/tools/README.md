# tools/ — 上下文监测（可选）

> 一个可选的小工具：**盯住每个会话的上下文占用**，快到上限时提醒你换会话或手动压缩。
> **默认关闭，不自动启动**——要不要用，先看 [`../docs/ctx-monitor.md`](../docs/ctx-monitor.md) 的决策矩阵。

---

## 这套东西是什么

| 文件 | 作用 |
|---|---|
| `ctx-monitor.mjs` | 监测进程本体（零依赖，只读 projcache） |
| `_test-ctx-monitor.mjs` | 自测（末行 `ctx-monitor: ALL PASS`） |
| `_test-compact-brief.mjs` | 压缩检出 + 简报文本的自测（末行 `ALL PASS`） |
| `start-ctx-monitor.vbs` | 双击启动（无窗口，用 `%~dp0` 定位，不写死路径） |
| `README.md` | 本文件 |

**它只做四件事**：

1. **只读** `<USERPROFILE>/.dsh/storages/session_projcache/sessions/*.json`（DSH 自己写的会话快照）
2. 算 `pressureTokens / contextWindow` 的百分比，超过阈值就**报一行警告**
3. 落盘只有三样：`ctx-alerts.log`（告警日志）、`ingress.jsonl`（告警事件，可选）、`ctx-monitor.pid`（pid 文件）
4. **发现会话被压缩**（同一会话两轮之间 pct 回落 ≥ 15 个点）时，写一条 `【压缩后自检】` 事件，body 里附带角色化简报（`--brief`，见下）

**它不做什么**：不写任何会话的提示词/配置、不调用 DSH 接口改会话、不改任何状态。

---

## 三种场景（要不要跑，先看这个）

| 你的宿主情况 | 要不要跑 | 原因 |
|---|---|---|
| **卸载了 compaction 插件** 或 `compaction-basic` 配了 `auto:false` | **要跑** | 上下文不会自动压缩，必须靠脚本盯水位，到点提醒你换会话或手动 `/compact` |
| **装了自动压缩**（`auto:true`） | **越线告警不要，压缩检出可以要** | 宿主自己会压，所以「快到上限」的告警是重复的；但**压缩检出**恰好补上宿主不告诉你的那件事：会话刚被压过、摘要已替换原文 → 用 `--brief` 让 worker/judge 重新对一遍真源（这条只在自动压缩环境里才有用） |
| **不确定** | 先跑面板「一键体检」 | 诊断会读 profile patch 告诉你 compaction 是开还是关 |

> 详细决策矩阵 + 为什么，见 [`../docs/ctx-monitor.md`](../docs/ctx-monitor.md)。

---

## 怎么跑

### 方式 1：自检（推荐先跑这个）

```bash
# 扫一轮、打印表格、不写任何文件
node ctx-monitor.mjs --once --dry-run

# 扫一轮、写文件（正常使用时）
node ctx-monitor.mjs --once
```

`--once` 跑完就退出，**不留进程**。适合手动看一眼当前水位。

### 方式 2：常驻（长时间盯）

```bash
node ctx-monitor.mjs --daemon
```

`--daemon` 会写 pid 文件、常驻运行、每 `intervalSec`（默认 60 秒）扫一轮。
**正常轮询是静默的**：只有越阈值才打印 `ALERT` 行。

### 方式 3：双击 vbs（不想开命令行）

双击 `start-ctx-monitor.vbs` —— 它用 `%~dp0` 找到本目录的脚本，用隐藏窗口启动。
node 解释器优先取环境变量 `DSH_CTX_NODE`，否则用 PATH 里的 `node`。

---

## 压缩检出与「压缩后自检」简报（v0.1.6 新增）

压缩本身不归脚本管（那是宿主 compaction 插件的事），但**压缩之后当事人容易照着摘要干活**，而摘要是不可信的。
脚本因此多做一件事：**发现会话刚被压缩，就提醒去核对真源**。

### 怎么判「被压缩」

同一会话前后两轮扫描：`上一轮 pct − 本轮 pct ≥ 15`（且上一轮 ≥ 30%）→ 判为被压缩。

- 回落太少不触发（默认 15 个点），避免水位正常抖动误报；
- 阈值可调：`--drop-pts=<%>` / `--drop-min-prev=<%>`；
- 命中后 `ctx-alerts.log` 多一行 `{"level":"compaction",...}`，并向 `ingress.jsonl` 写一条 key 前缀 `ctx-compact:` 的 `【压缩后自检】` 事件（标题带「压缩前 % → 压缩后 %」）。

> 越线告警是 `level:"warn"`、压缩事件是 `level:"compaction"`，同一个日志里用 `level` 区分。

### 直接拿简报文本

```bash
node ctx-monitor.mjs --brief=judge    # 给 judge
node ctx-monitor.mjs --brief=worker   # 给 worker
node ctx-monitor.mjs --brief=owner    # 只打共同段
```

`--brief` **只打印、不扫描、不写任何文件**，适合把文本原样贴给被压缩的会话。

### judge 版为什么这么写

口径（2026-11-09 定）：**摘要不可信；已收口工单的证据极强、可置信；核对证据工单即可。**

- 判据优先级：**工单证据（`sa_evidence` 的清单 + 判词）> 交接文档 > 压缩摘要**；
- 已经 `done` 的工单：只要证据清单非空、孤儿 `orphan=0`、判词 `pass` 在，**不用重审**；
- 要引用或复判，就核对那张单的证据本身，**不必回到摘要里的转述，也不必全量重跑**；
- 力气只花在：清单缺件、缺判词、以及新交来的 `ready` 单。

> 这也是为什么 `_test-ctx-monitor.mjs` 里三条计数断言改成了「压缩事件另计」——回落会多写一行，越线告警口径没变。

---

## 参数从哪来（**热生效**）

**阈值和间隔不用重启进程**：进程每轮都从 `settings.json` 的 `ctxMonitor` 读参数（按 mtime 缓存），
面板上改了保存，**下一轮（≤ 一个 interval）就生效**。

| 参数 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | **默认关闭**；只有面板点「启动」才真跑 |
| `intervalSec` | `60` | 轮询间隔（秒） |
| `thresholdOfficial` | `65` | `provider=deepseek-account`（官方 DS）的阈值（%） |
| `thresholdOther` | `85` | 其它 provider 的阈值（%） |
| `thresholds` | `[]` | 按 provider 覆盖，如 `[{provider:'trae', pct:80}]`；未命中回退 `thresholdOther` |
| `alertIngress` | `true` | 是否把告警写成 `ingress.jsonl` 事件（关掉就只写本地日志） |

**阈值匹配顺序**（命中哪一档会写进告警行，方便核对）：
1. `thresholds` 里 provider 精确匹配 → 用它（告警行显示 `[provider:<名>]`）
2. provider 是 `deepseek-account` → `thresholdOfficial`（显示 `[official]`）
3. 其余 → `thresholdOther`（显示 `[other]`）

**命令行参数只作临时覆盖**（自测/一次性用），常驻运行应以 settings 为准。

---

## 文件落在哪

默认在 **`<本目录>/ctx-monitor-data/`**（可用 `--data-dir` 改）：

| 文件 | 内容 |
|---|---|
| `ctx-alerts.log` | 告警日志，一行一条 JSON；超过 1MB 自动轮转成 `.1` |
| `ingress.jsonl` | 告警事件（喂给工单系统建单），`alertIngress:false` 时不写 |
| `ctx-monitor.pid` | 常驻时的 pid；停止后应被清理 |

扫描范围默认是**当前工作目录**下的会话（可用 `--root` 或环境变量 `DSH_CTX_ROOT` 指定）。
不在范围内的会话一律跳过：不报警、不写日志，只计入统计。

---

## 怎么停

**有面板**：设置页「上下文监测」区点「停止」——端点会按 pid 文件 kill，并**校验命令行含 `ctx-monitor`**（防误杀别的进程）。

**没面板**：

```bash
# 看 pid
cat ctx-monitor-data/ctx-monitor.pid
# 停（请先确认那个 pid 真的是 ctx-monitor，别杀错）
```

> ⚠ 手工 kill 前**务必核对进程命令行**：pid 会被系统复用，杀错进程可能很麻烦。

---

## 自测

```bash
node _test-ctx-monitor.mjs
# 末行应为：ctx-monitor: ALL PASS
```

测试全部用临时目录，**不写真实的 alerts / ingress**。所有路径都是测试内造的（`<本目录>/.ctxmon-ws`），不依赖任何本机绝对路径。

---

## 常见问题

**Q：跑 `--once` 显示 `inScope=0`，是不是坏了？**
A：不是。默认只扫「当前工作目录」下的会话。你的会话在别的目录时就会是 0。用 `--root=<你的工作区根>` 指定。

**Q：告警没出现，但我确实快满了？**
A：①确认你的会话 `cwd` 落在 `--root` 内；②确认 provider 对应的阈值（可能你设了 `thresholds` 覆盖）；③冷却 30 分钟 + 迟滞 5%——掉到阈值以下 5 个点才会重新武装，不是每轮都报。

**Q：能不能改成一改就立刻生效？**
A：阈值/间隔是**下一轮**生效（≤ 一个 `intervalSec`）。启停则是立即的（要动进程）。

**Q：压缩检出会不会很吵？**

A：只在你**真的掉了 ≥15 个点**时写一条（同分钟同会话按 key 去重）。嫌吵就把 `--drop-pts=25` 调大；只想要本地日志就加 `--no-ingress`。

**Q：`--brief` 会不会改我的会话？**

A：不会。它只打印一段文本，不扫描、不写文件、不调用任何 DSH 接口。

**Q：会不会把告警发给错误的人？**
A：不会。告警目标由 `--owner-session` / 环境变量 `DSH_CTX_OWNER` 显式指定；**没指定就只写本地日志、不建单**（宁可不发，也不发给错的人）。
