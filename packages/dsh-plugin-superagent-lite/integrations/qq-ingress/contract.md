# QQ → ingress 契约

`onebot-bridge.mjs` 只做一件事：把白名单里的 QQ 消息变成 **ingress.jsonl 的一行**。
kernel（dsh-plugin-superagent-lite）的 `tickIngress` 读这个文件建单。**两边之间只有文件，没有 RPC、没有插件依赖。**

## 1. 行 schema

每行一个 JSON 对象（**整行追加，别改历史行**）：

```json
{ "at": "2026-11-06T11:30:00.000Z", "source": "qq", "key": "qq:g:<群号>:<message_id>", "title": "修个 bug", "body": "来自 QQ：群 <群号> / 发送者 <QQ 号>\n原文：!工单 修个 bug", "sessionId": "<可选：工单归属会话>" }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `at` | 否 | ISO 时间；kernel 不依赖它（用于人读/排查） |
| `source` | 是 | 来源名，QQ 桥写 `qq`；会进工单 history |
| `key` | **是** | 去重键；**空 key 的行会被 kernel 直接跳过**（不建单、只记日志） |
| `title` | 是 | 工单标题；kernel 里缺省会用 body 兜底，并截 200 字 |
| `body` | 否 | 正文，截 4000 字 |
| `sessionId` | 否 | 指定工单归属会话；不填走 kernel 兜底链（`config.sessionId` → 最近调用者） |
| `type` | 否 | `test` / `code` / `office`；不给就按标题关键字猜 |

## 2. kernel 侧规则（对着代码）

- `tickIngress()` 每 **2 秒** 一轮；只消费「以 `\n` 结尾」的完整行。
- **去重**：按 `key`；已见过的 key 记在 `state.json` 的 `ingressSeen`（持久化，保留最近 500 个），
  同 key 再来 → 日志 `ingress duplicate`，**不建单**。
- **游标**：`state.ingressOffset` 是字节偏移，按增量读；文件变短（被截断/轮转）→ offset 归 0 重读。
  所以：**只追加、别原地重写**（重写也能被识别，但会重读全文件）。
- **建单后**会自动往决策人投一条「待派单」提醒（outbox key = `dispatch:<工单 id>`），不额外刷屏。
- 建出来的工单初始状态 `queued`，之后走正常派活/验收流程。

## 3. 生产者（本桥）义务

1. 只写 `config.ingressFile` 指定的文件；**不猜路径**（没配就拒绝启动）。
2. 一行一个 JSON，字段用上面的 schema；不确定的字段宁可不写。
3. 用 `key` 保证幂等：同一条 QQ 消息重复投递（重连、重放）不会重复建单。
4. 不要写半行（先拼好字符串再一次性 append）。

## 4. 与宿主 QQ 插件的关系

本桥**不 import 任何 QQ 插件**，也不调用 `notify_qq` / `send_to_qq`（那是宿主侧可选出站工具，见 README「出站」一节）。
kernel 只读文件，所以：**不装 QQ 插件也能从 QQ 建单**；装了也只是多了「把结果推手机」的能力。
