# tools/ — 上下文监测（可选）

> 一个可选的小工具：**盯住每个会话的上下文占用**，快到上限时提醒你换会话或手动压缩。
> **默认关闭，不自动启动**——要不要用，先看 [`../docs/ctx-monitor.md`](../docs/ctx-monitor.md) 的决策矩阵。

---

## 这套东西是什么

| 文件 | 作用 |
|---|---|
| `ctx-monitor.mjs` | 监测进程本体（零依赖，只读 projcache） |
| `_test-ctx-monitor.mjs` | 自测（末行 `ctx-monitor: ALL PASS`） |
| `start-ctx-monitor.vbs` | 双击启动（无窗口，用 `%~dp0` 定位，不写死路径） |
| `README.md` | 本文件 |

**它只做三件事**：

1. **只读** `<USERPROFILE>/.dsh/storages/session_projcache/sessions/*.json`（DSH 自己写的会话快照）
2. 算 `pressureTokens / contextWindow` 的百分比，超过阈值就**报一行警告**
3. 落盘只有三样：`ctx-alerts.log`（告警日志）、`ingress.jsonl`（告警事件，可选）、`ctx-monitor.pid`（pid 文件）

**它不做什么**：不写任何会话的提示词/配置、不调用 DSH 接口改会话、不改任何状态。

---

## 三种场景（要不要跑，先看这个）

| 你的宿主情况 | 要不要跑 | 原因 |
|---|---|---|
| **卸载了 compaction 插件** 或 `compaction-basic` 配了 `auto:false` | **要跑** | 上下文不会自动压缩，必须靠脚本盯水位，到点提醒你换会话或手动 `/compact` |
| **装了自动压缩**（`auto:true`） | **不要跑** | 宿主自己会压；再跑脚本 = 重复告警，且压缩后水位骤降会误判 |
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

**Q：会不会把告警发给错误的人？**
A：不会。告警目标由 `--owner-session` / 环境变量 `DSH_CTX_OWNER` 显式指定；**没指定就只写本地日志、不建单**（宁可不发，也不发给错的人）。
