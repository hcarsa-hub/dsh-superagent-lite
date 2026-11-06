# 提示词模板 · QQ 接入（旁路建单）

> **用途**：让 QQ 群里的消息变成工单。
> 事实来源：`integrations/qq-ingress/contract.md`。**两边之间只有文件，没有 RPC、没有插件依赖。**

---

## 1. 它在整个循环里的位置

```text
QQ 群消息
   │
   ▼
onebot-bridge.mjs（白名单校验 + @ 门控）
   │  只写一行 JSON
   ▼
ingress.jsonl ──(kernel tickIngress，每 2 秒)──▶ 建单 queued ──▶ 正常主循环
```

> 关键：**本桥不 import 任何 QQ 插件，也不调用 `notify_qq` / `send_to_qq`**。kernel 只读文件。
> 所以**不装 QQ 插件也能从 QQ 建单**；装了只是多了"把结果推手机"的能力。

---

## 2. 行 schema（`ingress.jsonl` 每行一个 JSON）

```json
{
  "at": "<ISO 时间>",
  "source": "qq",
  "key": "qq:g:<群号>:<message_id>",
  "title": "<一句话标题>",
  "body": "来自 QQ：群 <群号> / 发送者 <QQ 号>\n原文：<原始消息>",
  "sessionId": "<可选：工单归属会话>",
  "type": "test|code|office"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `source` | **是** | 来源名，QQ 桥写 `qq`；会进工单 history |
| `key` | **是** | 去重键；**空 key 的行被 kernel 直接跳过**（不建单、只记日志） |
| `title` | 是 | 工单标题；缺省用 body 兜底并截 200 字 |
| `body` | 否 | 正文，截 4000 字 |
| `sessionId` | 否 | 指定归属会话；不填走兜底链（`config.sessionId` → 最近调用者） |
| `type` | 否 | `test` / `code` / `office`；不给就按标题关键字猜 |
| `at` | 否 | 人读/排查用，kernel 不依赖 |

---

## 3. kernel 侧规则（对着代码，别猜）

- `tickIngress()` 每 **2 秒**一轮；**只消费以 `\n` 结尾的完整行**。
- **去重**：按 `key`，已见过的记在 `state.json` 的 `ingressSeen`（保留最近 500 个）；同 key 再来 → 日志 `ingress duplicate`，**不建单**。
- **游标**：`state.ingressOffset` 是**字节偏移**，按增量读；文件变短（被截断/轮转）→ offset 归 0 重读。
- **建单后**自动往决策人投一条「待派单」提醒（outbox key = `dispatch:<工单 id>`），不额外刷屏。
- 建出来的工单初始 `queued`。

> **推论**：`ingress.jsonl` **只追加、别原地重写**。重写虽能被识别，但会重读整个文件（去重靠 key 兜底，不会重复建单，但白跑一遍）。

---

## 4. 安全要求（三条，缺一不可）

### 4.1 白名单 **fail-closed**

> **没配白名单 = 全拒，不是全放。**

这是最容易被写反的地方。写反的后果：任何人都能往你的工单系统里塞任务。

### 4.2 @ 门控

只有 `@机器人` 的消息才建单（或在白名单里明确允许的指令前缀，例如 `!工单`）。
否则群里随便聊天都会被当成任务。

### 4.3 只连 `127.0.0.1`、用小号

- OneBot 实现只监听本机回环，不要暴露公网端口；
- **用 QQ 小号**跑机器人，别用主号（账号风险 + 好友/群关系污染）。

---

## 5. 生产者（你的桥）义务

1. 只写配置里 `ingressFile` 指定的文件；**不猜路径**（没配就拒绝启动）。
2. 一行一个 JSON，字段按上面的 schema；**不确定的字段宁可不写**。
3. 用 `key` 保证幂等：同一条消息重复投递（重连、重放）不会重复建单。
4. **不要写半行**：先拼好完整字符串，再一次性 append。

---

## 6. 建议的消息→工单映射

| QQ 消息 | 建单 title | type |
|---|---|---|
| `!工单 修个 bug` | `修个 bug` | 按关键字猜 |
| `!工单 跑一下测试` | `跑一下测试` | `test` |
| 纯闲聊（无 `!工单` 前缀） | **不建单** | — |
| 白名单外的人发的 | **不建单**（记日志） | — |

> `key` 建议：`qq:g:<群号>:<message_id>` 或 `qq:p:<QQ号>:<message_id>`。用 `message_id` 而不是时间戳——重放时才能真的幂等。

---

## 7. 自检

- [ ] 白名单为空时，发消息**不会**建单（验证 fail-closed）
- [ ] 白名单内的号 + `@` 门控通过后，`ingress.jsonl` **多一行完整 JSON**
- [ ] `sa_list` 能看到新单，初始 `queued`
- [ ] 同一条消息再投一次，**不会**建第二张单（去重生效）
- [ ] `ingress.jsonl` 里没有半行/断行
- [ ] 桥只监听 `127.0.0.1`，用的不是主号

---

## 相关文档

- 完整契约 → `integrations/qq-ingress/contract.md`
- 桥的装法 → `integrations/qq-ingress/README.md`
- 主循环里 QQ 旁路怎么并进来 → [`../loop.md`](../loop.md) §6.2
