# 设计说明

## 1. 分层

```
宿主 cordis 运行时
 ├─ tools 服务（必选）      ← 32 个 sa_* 工具注册在这里
 ├─ schedule 服务（可选）    ← 投递/告警/派活消息
 └─ subagents 服务（可选）   ← sa_run / sa_fanout 的执行体
        ▲
        │ ctx.get(name, false) 惰性探测（缺失不影响加载）
        │
   index.js（本插件）
        ├─ 纯函数层：id 生成 / 状态图 / 裁剪 / 归档选取（可单测，不碰磁盘）
        └─ service 层：state.json 读写、outbox 投递、ingress/queue tick、证据与归档
```

**为什么 subagents 不写进 `export const inject`**：本插件面向的 cordis（4.0.5）里 `inject` 只接受
「服务名数组」或「服务名 → intercept 配置」的 map，**没有 required/optional 分组**；一旦写进数组而宿主
没提供该服务，fiber 会一直 PENDING（apply 不执行），结果是整个插件静默失效。所以顶层只声明必选的
`tools`，`subagents` / `schedule` 在 apply 里用 `ctx.get(name, false)` 探测 + `ctx.inject([name], cb)`
挂一次性惰性订阅；服务真的不存在时，只有依赖它的工具返回明确错误。

## 2. 状态机

```
queued  → running → ready → done
   ↓         ↓        ↓
 blocked ← blocked ← blocked → queued（重排）/ done（人工收口）
```

- 迁移统一走 `advance(id, to)`：校验 `NEXT` 表、bump `revision`、写 history（from/to/at/source/session）
- `ready` = 等 owner 收口；进入时把 outbox 记录（key = `ticketId:revision`）写进 state
- 投递在 tick 里逐条进行：成功写 `sentAt`，失败累加 `attempts`，重启后继续（不静默丢）
- `blocked` 不是终态：可 `sa_advance` 回 queued 重排，或人工 `done` 收口

## 3. 角色与权限

`owners.json`（stateDir 下，mtime 热读）保存角色名单：

| 角色 | 能做什么 |
|---|---|
| owner | 派活、改状态、收口、改角色、清归档、写白名单 |
| worker | `sa_report` + 被派到的单 `sa_attach` |
| judge | `sa_verdict`、`sa_escalate` |
| ops | 只用于坑投递箱目标，不参与工具授权 |
| children | `sa_run` 派出的子会话，按 worker 对待，工单 done 时自动回收 |

- 未登记会话 = `role:none`：只读工具可用，写工具返回 `forbidden`（并提示怎么授权）
- `ownerSessions` 为空时会额外提示「请先配置 ownerSessions」——这是分发版的默认状态
- 写白名单不允许删掉最后一个 owner（防锁死）
- `ownerSessions` 仅在 `owners.json` 不存在时播种，已有空名单不能靠改 patch 再重启修复；恢复时保留全部角色与白名单，见 [安装操作](install-operations.md)。

## 4. 证据链

```
evidence/<id>/
  manifest.json      # [{ name, bytes, by, at, sha256? }]
  <产物文件>
```

`sa_attach`：`content`（直接写文件）或 `sourcePath`（从已有文件复制），同时更新 manifest 与工单的
`artifacts` 清单；`sa_evidence` 用清单对磁盘（缺件、孤儿文件、解析方式 manifest/dir/legacy）。

安全边界：`attachRoots` 之外的路径拒绝；`.ssh`/`.gnupg`/`.codex`/`.dsh`/`.aws`/`id_rsa`/`*.pem`/
`credentials.json`/`*.env`/AppData Roaming 等敏感路径，在任意允许根内也拒绝（防「先配个宽根再读密钥」）。

默认允许根是 stateDir 的父目录（通常 `~/.dsh`）与系统临时目录；项目产物必须显式配 `attachRoots`，默认根不豁免敏感路径检查。

## 5. 双筛流程

```
owner            worker                 judge                 owner
  │ sa_submit        │                     │                     │
  ├─ sa_run/fanout ─▶│ 干活                │                     │
  │                 ├─ sa_attach(证据)     │                     │
  │                 ├─ sa_report(自报)     │                     │
  │                 │                     │                     │
  ├─ sa_judge ──────────────────────────▶│ 独立验收             │
  │                 │                     ├─ sa_verdict(pass) ──▶│（收到收口通知）
  │                 │                     └─ sa_verdict(fail)    │
  │                 │                        → blocked + 投坑投递箱
  └─ sa_advance ready→done ◀─────────────────────────────────────┘
```

判据写在 `sa_judge` 的 `criteria`；judge 只看「产物 + 判据 + worker 自报」，不看 worker 的过程叙述。

## 6. 目录与归档

- `stateDir/state.json`：唯一事实源（原子写：写临时文件 → rename；同时留 `.bak`）
- `stateDir/archive/`：`sa_archive` 把 done/blocked 的单移出主文件；工单号按纪元滚动（999 张一换），
  换纪元时旧单整体归档到 `archive/<纪元前缀>.json`
- 恢复：`sa_archive` 的 dryRun 可先看数量；归档条目可按 id 取回（`archive` 子命令）
- `stateDir/commands/`：面板/外部写命令文件，插件 tick 执行（避免两边同时写 state.json）

## 7. 并发与一致性

- 进程内串行：`runExclusive` 单队列，所有「读-改-写 state」都过它（不嵌套）
- 跨进程：**没有锁**。同一 `stateDir` 只应挂一个实例；两个实例会互相覆盖 state.json
- 幂等：`ingress` 按 `key` 去重（最多记 500 个）；`outbox` 按 `ticketId:revision` 去重；`sa_attach` 按文件名覆盖

## 8. 失败策略

| 场景 | 行为 |
|---|---|
| 投递失败（schedule 不在/宿主拒投） | 重试到 `maxDeliverAttempts`，之后放弃并记 abandoned（消息不悄悄消失） |
| 子代理派活失败 | 累加 `attempts`；超过 `maxRunAttempts` 后置 blocked 并写 `error-evidence.md` |
| running 超时 | watchdog 巡检发现 → 提示/告警（取决于 `watchdogAlerts`） |
| state.json 损坏 | 读失败时自动备份为 `state.corrupt-<ts>-<uuid>.json`，回退到 `.bak`，再不行从空状态起步 |
| 插件 dispose | 清所有 timer，最后写一行 `disposed` 日志 |

`sa_steer` 独立于工单迁移：仅 owner，参数 `sessionId/text/mode`（auto/steer/followup），schema 与 execute 双重校验。通过 `typert.lookups.get('agent').resolve(sessionId)` 取得 Agent，auto 下 running 调 steer、idle/unknown 调 followup；await 投递结果，同步/异步失败都返回 `{ok:false}`，不写账本/工单状态，Codex 执行体不支持。
