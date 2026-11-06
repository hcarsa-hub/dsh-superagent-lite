# 接模型 / 免费模型

本插件**不内置任何模型或 provider**。它只做一件事：把「派给谁」的模型路由参数原样交给宿主的
`subagents` 服务。模型能不能用，取决于宿主当前装了哪些 provider 插件。

## 1. 三条路由写法

### 1.1 单次派活：`sa_run`

```json
{ "id": "sa-001", "provider": "our-free-model", "model": "glm-5.3-flash-free", "reasoning_effort": "low" }
```

- `provider` 与 `model` **必须成对给**（只给一个会被宿主忽略，插件会直接报错）
- `reasoning_effort` 可选：`low` / `medium` / `high`（宿主不认的档位会被忽略或报错，以宿主为准）
- 路由会写进 `request.agentOptions = { provider, model, reasoningEffort }`（camelCase，宿主真实字段名）

### 1.2 多模型并行：`sa_fanout` 的 `models`

```json
{
  "id": "sa-002",
  "models": [
    { "provider": "trae", "model": "glm-5.3", "reasoning_effort": "low", "label": "trae" },
    { "provider": "raccoon", "model": "sn-glm-5-3-flash", "reasoning_effort": "low", "label": "sam" }
  ]
}
```

- 每个元素各起一个临时子会话，产出由各子会话 `sa_attach` / `sa_report` 交回同一张单
- `label` 只用于子会话显示名，不参与路由
- 没有 `subagents` 服务时直接返回「本插件未启用 subagent 能力」，不会静默失败

### 1.3 按模型挑人：`sa_agents` + `sa_fanout { sessionIds }`

先在 `owners.json` 的 `models` 里给每个已登记会话写备注（`sa_role` 的 `model` 参数会写进去），
派活前用 `sa_agents` 读出来，按「这活要快 / 要强 / 要免费」挑人，再用
`sa_fanout { id, sessionIds: ["<session id>"] }` 指派。

```json
{ "id": "sa-003", "sessionIds": ["<worker a>", "<worker b>"], "brief": "并行出两个方案，各自 sa_report" }
```

> `sessionIds` 模式只发消息（走宿主 `schedule`），**不创建会话**；子会话模式（`sa_run`/`models`）才会向宿主申请临时子代理。

## 2. 模型白名单：`saRunAllow`

`owners.json` 里的 `saRunAllow` 决定「能不能指定模型」：

| 情况 | 行为 |
|---|---|
| **没有这个键** | 不限制：任何 owner 都能给 `sa_run` / `sa_fanout(models)` 指定任意 provider/model |
| **有这个键（数组）** | 白名单：只允许表里的条目，不在表里直接 `sa-run-denied` |

条目匹配两种写法（二选一命中即通过）：

- `"provider/model"`，例如 `"trae/glm-5.3"`
- `"model"`，例如 `"glm-5.3-flash-free"`

示例：

```json
{
  "owners": ["<owner session id>"],
  "workers": ["<worker session id>"],
  "judges": ["<judge session id>"],
  "models": { "<worker session id>": "our-free-model/glm-5.3-flash-free" },
  "saRunAllow": ["our-free-model/glm-5.3-flash-free", "deepseek-v4.1-flash-free"]
}
```

> 注意：`saRunAllow` 是**数据文件**里的键，不是 profile config；编辑 `owners.json` 保存即生效（按 mtime 热读）。

## 3. 示例模型名（仅格式示范，不是默认值）

| provider 示例 | model 示例 | 说明 |
|---|---|---|
| `our-free-model` | `glm-5.3-flash-free`、`deepseek-v4.1-flash-free` | 宿主装了 Our Free Model 插件时可用（名字以宿主为准） |
| `trae` | `glm-5.3`、`deepseek-v4.1-flash` | 第三方中转；**不是**官方 DS，配额/上下文窗口与官方不同 |
| `raccoon` | `sn-glm-5-3-flash`、`sn-deepseek-v4-1-flash-1017` | 第三方中转 |
| `qodercn` | `qfmodel` | 第三方中转 |
| `deepseek-account` | `deepseek-flash` | 官方账号通道 |

**换机 / 换插件后模型名会变**：请用宿主的 `list_subagent_models` 或模型选择器确认真实 id，不要照抄上表。

## 4. 失败与代价

- 子会话起不来（provider 不存在 / 模型不存在 / 父会话没有模型策略）→ 宿主抛错，工单留在 queued 或按失败策略置 blocked，不会写脏状态
- 子会话跑完不 `sa_report` → 单子停在 running，由 watchdog 巡检（`sa_watchdog`）暴露
- 并发受 `concurrency.maxConcurrent` 限制；超出直接拒绝而不是排队
