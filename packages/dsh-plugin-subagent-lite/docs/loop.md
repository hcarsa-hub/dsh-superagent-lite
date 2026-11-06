# 循环路径 · 状态机 · 失败回退

> 一张单从「被提交」到「被收口」要走一整圈。本页画清楚：**谁在什么时候做什么、谁在等谁、哪一步会卡、卡了怎么退**。

---

## 1. 主循环（ASCII）

```text
   [人 / QQ消息 / 定时任务 / Codex Stop]
                    |
                    v  (可选 ingress)
          ingress.jsonl --tickIngress--> 工单 queued
                    |
                    v  (owner 派单：sa_fanout / sa_tell / sa_run / autoDispatch)
              +-------------------+
              |  worker 会话      |
              |  接活 -> 干活     |
              |  sa_attach 证据   |
              |  sa_report 自报   |
              +-------------------+
                    |
                    v  sa_report(final:true) -> 工单 ready
              +-------------------+
              |  judge 会话       |      <-- autoJudge 配了才自动收到「请验收」
              |  独立验收         |          （默认关：不配就得 owner 手动 sa_judge）
              |  sa_verdict       |
              +-------------------+
                    |
        pass:true   |   pass:false
            |              |
            v              v
   工单 ready(判词已出)   工单 blocked
            |              |
            v              v
   owner 收到「请收口」   owner 转 queued / 改 brief
   owner 亲手验落地           |
            |                 v
            v            再派（证据保留，不重来）
       工单 done
            |
            v
      sa_archive（归档）/ 回传（sa_sendback，可选）
```

---

## 2. 谁在等谁（这是最容易搞混的）

| 时刻 | 谁**醒着在等** | 等什么 | 谁**可以睡了** |
|---|---|---|---|
| 单刚提交 | owner | 决定派不派、派给谁 | worker / judge |
| 已派活 | owner | 结果（但**不轮询**，等被动唤醒） | worker 在干活，judge 在睡 |
| worker 交完 | judge | worker 的报告 + 证据 | worker 可以睡 |
| judge 判完 pass | **owner** | 「判词已出，请收口」提醒 | judge 可以睡 |
| judge 判完 fail | **owner** | blocked + 缺什么 | judge 可以睡 |

### 三条硬规则

1. **owner 只在 verdict 之后被叫醒**（不是每步都叫）。想看中间状态就自己跑 `sa_list` / `sa_next`，**不要靠轮询**。
2. **worker 不停在 waiting**：交完就结束这一轮，不要挂起等消息。
3. **judge 不看 owner 的脸色**：判据来自 brief，不来自「owner 想通过」。

> **为什么强调"不要在等"**：常驻会话如果每轮都主动轮询，上下文会被空转吃掉。正确做法是被 `schedule` 唤醒（这就是本插件往会话投提醒的意义）。

---

## 3. 状态机（全量迁移）

| 状态 | 含义 | 谁能推进 | 能到哪 |
|---|---|---|---|
| `queued` | 建好了，等人接 | owner（派活）/ 自动派单 | `running` |
| `running` | 有会话在干 | worker（自报时由插件推进）/ owner | `ready` / `blocked` |
| `ready` | 交付完成，可以验收 | judge（pass）/ owner | `done` |
| `blocked` | 卡住或没通过 | owner（转回 `queued` 或改 brief 后重派） | `queued` / `done` |
| `done` | 已收口 | 终态（可归档） | — |

> 任意态都能 `sa_advance(..., to="blocked")`（带 `reason` 会写进 `blockedReason`）。**只有 owner 能推进状态**——worker 和 judge 不行。

---

## 4. 失败与回退（四种典型）

### 4.1 派活失败（消息没投出去）

```text
sa_fanout 成功但 tell 失败
   -> requeueDispatch：工单退回 queued，记 t.dispatchFailed
   -> 下一轮 tick 重试
   -> 累计失败到阈值（默认第 4 次）-> 置 blocked，blockedReason = "dispatch-failed x4: ..."
```

**owner 要做**：先看 `sa_list` 的 blockedReason，查为什么投不出去（会话 id 错？会话被回收？schedule 服务挂了？），修好再 `sa_advance(to="queued")` 重派。

### 4.2 卡住（running 太久没动静）

```text
running 超过 runningTimeoutMs（默认 5 分钟）无变更
   -> watchdog 巡检判定卡住 -> 置 blocked
```

**owner 要做**：`sa_evidence` 看产物有没有落地，`sa_list` 看最后变更时间，决定是「重派」还是「自己接手」。

> 注意：长任务的合理耗时可能超过默认 5 分钟。**跑长任务前先把 `policy.runningTimeoutMs` 调大**，否则会被误判。

### 4.3 子代理派活失败（`sa_run` 起不来）

```text
startActivation 失败 -> 记 runAttempts -> 达到 maxRunAttempts（默认 3）
   -> 置 blocked + 自动写 error-evidence.md（若 errorEvidence 开）
```

**owner 要做**：看 `error-evidence.md`；确认宿主有 `subagents` 服务、provider 名对吗。

### 4.4 验收不通过

```text
judge 下 sa_verdict{pass:false, reason="缺 X（文件:行号）"}
   -> 工单 blocked，reason 写进 blockedReason
   -> 同时把「坑在哪」投进坑投递箱（pitfallsInbox，供后续排查）
   -> owner 收到提醒
```

**owner 要做**：

1. 读 `blockedReason`，确认 judge 说的缺什么；
2. **不要直接把单改 done**（那是绕过验收）；
3. 修 brief / 补要求，`sa_advance(to="queued")` 重派；
4. **证据保留**——重派不删 `evidence/<id>/`，worker 可以在原产物上迭代。

> **重派时要说清"这一轮和上一轮的差别"**，否则 worker 会重做一遍已经做完的部分。

---

## 5. 提醒与投递（谁给谁发消息）

| 触发 | 谁收到 | 内容 | 开关 |
|---|---|---|---|
| 工单进入 `ready` | owner（或归属会话） | 「工单就绪，请验收/请派审」 | 走 outbox，无需开关；**但 autoJudge 生效时这一条不发给 owner**（改为直接提醒 judge） |
| 外部事件建单 | owner | 「有新单待派」 | `policy.notifyDispatch`（默认 true）；`quietSources` 命中的来源不叫醒 |
| judge 交验收请求 | judge 会话 | 「请验收」 | **`autoJudge` 配了才发**（默认关）；没配就 owner 自己 `sa_judge` |
| judge 判完（pass 或 fail） | owner | pass→「判词已出，请收口」；fail→「请安排回修」 | **autoJudge 生效时才发**（这是 sa-194 §14 的「owner 只在 verdict 后被叫醒一次」） |
| Codex 后端完成 | owner | 「请验收」 | `codexReadyNotify`（默认 false） |
| 卡住 / 异常 | owner | watchdog 告警 | `watchdogAlerts`（默认 false） |
| judge 判不通过 | 运维（坑投递箱，不叫醒） | 坑报告 | `pitfallsInbox` 配了才落文件 |

> **「autoJudge 生效」= 配了 `autoJudge` 且能解析到 judge 会话（`autoJudge:true` 取 `judges[0]`，judges 为空则退回提醒 owner）。**
> 只配了配置、但一个 judge 都没登记时，不算生效——会 log `auto-judge skipped ... no-judge-session` 并退回提醒 owner。
>
> **投递失败不静默丢**：进 outbox 重试，超过 `maxDeliverAttempts` 才标 abandoned。
> **告警不会投给子会话**：如果目标落在子代理路由，会回退到 owner 会话（子会话收不到 reminder）。

---

## 6. 两条旁路怎么并进来

### 6.1 Codex 旁路

```text
Codex 回合结束
   -> Stop hook 往 queueDir/events.jsonl 追加一行事件
   -> 内核 tick 读到（按 cursor 增量）
   -> 把对应工单推进 ready（或按契约做收口）
   -> owner 收到「请验收」（codexReadyNotify 开时）
```

要点：
- **`queueDir` 三处必须一致**（hook 的 `HANDOFF_QUEUE`、内核 `queueDir`、watcher `queueDir`）；
- Stop hook 必须 **fail-open**（钩子自身出错不能让 Codex 卡死）；
- 事件行 schema 见 `integrations/codex-bridge/contract.md`。

### 6.2 QQ 旁路

```text
QQ 群消息
   -> onebot-bridge（白名单校验）
   -> 写 ingress.jsonl
   -> tickIngress 建单 queued
   -> 正常主循环
```

要点：
- **白名单 fail-closed**（没配 = 全拒，不是全放）；
- 只连 `127.0.0.1`；
- 用**小号**跑，别用主号。

---

## 7. 跑第一张单的完整时序（照着做）

> 前提：**`autoJudge` 默认是关的**。不配的话，worker 交完只会让 owner 收到「已就绪」，
> judge **不会**自动被叫醒——你得手动 `sa_judge(id, judgeSessionId)`。
> 想让 judge 自动接活，就在 profile config 里配 `autoJudge: '<judge 会话 id>'`（或 `true` 取 `judges[0]`）。

**A. 配了 autoJudge（自动验收）**

```text
[owner]  sa_submit(title="...", type="code")            -> sa-001
[owner]  sa_fanout(id="sa-001", sessionIds=["<coder_1 id>"], brief="<完整 brief>")
         -> 工单 running；coder_1 收到消息

[coder_1] 读 brief -> 干活 -> sa_attach(id="sa-001", sourcePath="<产物>")
[coder_1] sa_report(id="sa-001", summary="做了 X；证据在 evidence/sa-001/<file>", final=true)
         -> 工单 running→ready（history worker-final）
         -> autoJudge 自动提醒 judge「请验收」（此时 owner **不**收到 ready 提醒）

[judge_1] 读 brief + worker 报告 -> 抽查复现 -> sa_verdict(id="sa-001", pass=true, reason="...")
         -> 工单 ready(判词已出)；owner 收到「请收口」

[owner]  sa_list() 确认 -> 亲手验一遍落地 -> sa_advance(id="sa-001", to="done")
```

**B. 没配 autoJudge（手动验收，这是默认）**

```text
[coder_1] sa_report(..., final=true)  -> 工单 ready
[owner]  收到「已就绪，请验收/请派审」  -> 自己发：sa_judge(id="sa-001", judgeSessionId="<judge id>", criteria="...")
[judge_1] sa_verdict(...)             -> owner 收口
```

> **`final:true` 只是「worker 干完了」**，把 `running` 推到 `ready`。
> 它**不会**让单变 `done`——收口永远是 owner 的事（双筛的底线）。
> **`sa_sendback` 是可选能力**：只有配了 `config.deliverOut` 才可用，且默认 `dryRun:true` 只打计划不真发。

---

## 8. 常见卡点速查

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 单躺在 `queued` 没人接 | 没派活 / 没开 autoDispatch / 没有 worker 登记 | `sa_next()` 看下一张该派谁，`sa_agents()` 看名单 |
| worker 说收不到消息 | session id 错 / 会话是子代理路由 / schedule 挂了 | `sa_agents` 核对 id；换常驻会话 |
| 单一直 `running` 不动 | worker 挂了 / 卡住超时 | 调大 `runningTimeoutMs`，或置 blocked 重派 |
| judge 没收到「请验收」 | autoJudge 关了 / judge 没登记 | `sa_agents()` 核对；手动 `sa_judge(id, judgeSessionId)` |
| owner 没收到「请收口」 | 投递失败进 outbox 重试中 | 看 `lite.log`；确认 `sessionId` 兜底配了 |
| 重派后 worker 又从头做 | brief 没说明"接着上次做" | 重派时指明已有产物位置 |

---

## 相关文档

- 装 + 建团队 → [`getting-started.md`](getting-started.md) · [`team-layout.md`](team-layout.md)
- 每个角色怎么写提示词 → [`prompts/`](prompts/)
- 全部开关与副作用 → [`config.md`](config.md)
