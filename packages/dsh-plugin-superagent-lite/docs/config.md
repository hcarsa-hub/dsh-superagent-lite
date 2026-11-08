# 配置项（profile config）

所有键写在宿主 profile 的 `cordis.patch.yml` 里该插件的 `config:` 下。
`<home>` = 当前用户主目录；`<stateDir>` = 数据目录。

## 总表

| 键 | 类型 | 默认 | 必填 | 说明 | 副作用 / 不配会怎样 |
|---|---|---|---|---|---|
| `stateDir` | string | `<home>/.dsh/subagent` | 否 | 数据目录（state.json / evidence / archive / commands / lite.log） | 改它 = 换整套工单数据；两个实例配同一个目录会互相覆盖 |
| `ownerSessions` | string[] | `[]` | **首次授权必填** | 仅 `owners.json` 不存在时播种，之后热读名单文件 | 已有名单不会因补填 config 再重启而更新；保留其他角色的恢复方法见 [安装操作](install-operations.md) |
| `sessionId` | string | `$DSH_SESSION_ID` 或 `''` | 否 | 投递/告警没有目标会话时的兜底会话 | 空 = 按最近一次调用者推断；都没有时投递报 `no-session`（积压不丢） |
| `queueDir` | string | `<stateDir>/../queue` | 否 | 外部事件流目录，内核只读 `<queueDir>/events.jsonl`（Codex Stop 收口）；**hook 的 `HANDOFF_QUEUE`、内核 `queueDir`、watcher `queueDir` 三处必须一致** | 配错目录 = Stop 事件永远读不到（工单停在 running）；显式空串也走默认值 |
| `ingressFile` | string | `''`（关闭） | 否 | 外部事件投递队列文件 | 空 = `sa_ingress` 返回「ingress 未配置」、tickIngress 空转；配了但目录不可写 → 每次投递失败并记日志 |
| `inboxFile` | string | `''`（关闭） | 否 | `sa_delegate_codex` 写的 handoff 文件 | 空 = `sa_delegate_codex` 直接拒绝；配了会发生「同一个文件被下一个 Codex 回合覆盖」 |
| `pitfallsInbox` | string | `<stateDir>/../pitfalls-inbox` | 否 | 坑投递箱目录（judge 判不通过 / `sa_escalate` 落文件） | 目录不可写 → 投递失败（`sa_verdict` 仍会置 blocked，只是没落坑文件） |
| `subagentProvider` | string | `'spawn'` | 否 | `sa_run` 用的子代理后端 | 宿主没有该后端 → `startActivation` 报错、工单按失败策略处置（不写脏状态） |
| `attachRoots` | string[] | `[<stateDir> 的上一级, 系统临时目录]` | 否 | `sa_attach` 允许读取的根目录 | 配错 = 合法产物被拒；配太宽 = 附件可读更大范围（敏感路径仍被拒） |
| `attachMaxBytes` | number（字节） | `8388608`（8MB） | 否 | 单个附件上限 | 调大 = 单次写盘更大、可能塞爆 state 目录；调小 = 大产物要自己分卷 |
| `autoDispatch` | boolean | `false` | 否 | 自动把 `auto:true` 的 queued 单派给已登记、kind 匹配且可接单的 worker | 单张 `sa_submit.auto` 默认 true；全局开关、工单允许、匹配 worker 三个条件齐备才派 |
| `autoDispatchMs` | number（毫秒） | `15000` | 否 | 自动派单最小间隔 | 调太小 = 频繁扫队列；调太大 = 单子躺在 queued 没人接 |
| `watchdogAlerts` | boolean | `false` | 否 | 定时 watchdog 是否发告警 | 开 = 每 `watchdogMs` 巡检并向 owner 投告警（可能打扰）；关只影响定时，`sa_watchdog` 手动仍可用 |
| `watchdogMs` | number（毫秒） | `60000` | 否 | watchdog / policy tick 周期 | 调小 = 更及时但更费；调大 = 卡住单发现得晚 |
| `codexReadyNotify` | boolean | `false` | 否 | Codex 后端完成后是否投递「请验收」提醒 | 开 = 每张 Codex 单完成都会叫 owner 一次 |
| `concurrency` | object | `{ maxConcurrent: 1, defaultPriority: 5 }` | 否 | 并发上限与默认优先级 | `maxConcurrent` 调大 = 同时跑多张 running 单（彼此会争同一份产物目录）；调 0/负数按 1 处理 |
| `policy` | object | 见下 | 否 | 失败策略 | 见子表；`runningTimeoutMs` 决定「多久没动算卡住」 |
| `pruneCaps` | object | 见下 | 否 | 状态裁剪窗口 | 见子表；调小会真的删历史/产物清单条目（不可恢复） |

## policy 子键

本副本未携带内核源码，FACTS 未确认下列历史数值；与其他旧文档冲突的超时默认值标为未验证，不把固定分钟数作为恢复依据。

| 子键 | 默认 | 说明 | 副作用 |
|---|---|---|---|
| `runningTimeoutMs` | **未验证**（历史文档曾写 5 分钟，另页写 20 分钟） | 按实际加载配置与连续无变更策略判定卡住 | 先核对配置与心跳；调小可能误判，调大可能延迟发现 |
| `maxDeliverAttempts` | `30` | 单条 outbox 最大投递次数 | 超限后标 abandoned（消息不再重投，但记录仍在） |
| `maxRunAttempts` | `3` | 子代理派活失败的最大尝试次数 | 超限后置 blocked 并写 `error-evidence.md` |
| `notifyDispatch` | `true` | 外部事件建单后是否通知 owner「有新单待派」 | 关 = 建单静默，owner 要自己 `sa_list` 才看得到 |

## pruneCaps 子键（状态裁剪）

| 子键 | 默认 | 说明 | 副作用 |
|---|---|---|---|
| `outboxMax` | `500` | outbox 最多保留条数 | 超限删最旧 |
| `outboxKeepDays` | `7` | outbox 保留天数 | 过期删 |
| `abandonedKeepDays` | `3` | 放弃记录保留天数 | 过期删 |
| `historyMax` | `100` | 单张单 history 最多条数 | 超限截断（早期状态流转记录会丢） |
| `artifactMax` | `200` | 单张单产物清单上限 | 超限截断清单（文件仍在 evidence/） |
| `reportMax` | `50` | 单张单 report 上限 | 超限丢最旧自报 |

## settings.json（运行期热改，不需要重启）

`<stateDir>/settings.json` 里的键覆盖上面的默认值，按 mtime 热读：

| 键 | 类型 | 说明 | 副作用 |
|---|---|---|---|
| `autoDispatch` | boolean | 覆盖 config.autoDispatch | 立即开始/停止自动派单 |
| `autoDispatchMs` | number | 覆盖自动派单间隔 | 立即生效 |
| `watchdogAlerts` | boolean | 覆盖定时 watchdog 开关 | 立即生效 |
| `runningTimeoutMs` | number | 覆盖卡住判定 | 立即生效 |
| `maxDeliverAttempts` | number | 覆盖投递重试上限 | 立即生效 |
| `attachMaxBytes` | number | 覆盖附件上限 | 立即生效 |
| `errorEvidence` | boolean | 失败时是否自动写 `error-evidence.md` | 关 = 失败单没有自动证据 |
| `pruneCaps` | object | 覆盖裁剪窗口 | 立即生效 |

> 编辑后保存即生效；写坏了会被当空文件处理（按默认值走），不会让插件崩。

## 示例

项目产物必须显式加入 `attachRoots`。默认 stateDir 的父目录通常是 `~/.dsh`，但敏感路径检查仍会拒绝 `.dsh` 等受保护目录，不代表默认允许读取其内部文件。`queueDir` 默认 `<stateDir>/../queue`，即通常的 `~/.dsh/queue`；watcher 的独立默认值也是 `~/.dsh/queue`，hook 的 `HANDOFF_QUEUE` 需显式配齐。路径配置见 [安装操作](install-operations.md)。

```yaml
- insert:
    - id: superagent-lite
      name: dsh-plugin-superagent-lite
      config:
        ownerSessions: ['<owner session id>']
        sessionId: '<default session id>'
        subagentProvider: 'spawn'
        attachRoots: ['<your-project-dir>']
        concurrency: { maxConcurrent: 2 }
        policy: { runningTimeoutMs: 600000, maxDeliverAttempts: 10 }
```

`autoJudge` 未配置时不自动送审；捆绑模板显式启用 `autoJudge:true` 与 `judgeRotate:true`，仍需独立 judge 登记并核对投递。`sessionCreateRoots` 默认 `[]`，`sa_new_session` 的 cwd 必须在显式允许根内；`attachRoots` 不代替会话创建白名单。
