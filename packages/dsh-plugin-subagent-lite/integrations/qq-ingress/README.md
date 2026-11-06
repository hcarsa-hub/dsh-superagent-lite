# QQ → 工单（qq-ingress）

**一句话**：一个**脚本**（不是插件）把白名单里的 QQ 消息变成 `ingress.jsonl` 的一行，kernel 读到就建单。
触发链：**NapCat（WS 127.0.0.1:3001）→ `onebot-bridge.mjs` → `ingress.jsonl` → kernel `tickIngress`**。
kernel **只读文件**，从不 import 任何 QQ 插件——这条链不依赖宿主的 QQ 能力。

## 要不要用

- **要用**：你想在 QQ 群里发 `!工单 修个 bug` 就从工单系统建一张单，且只要这一件事。
- **不要用**：你想要「QQ 当完整聊天/远程控制通道」——那是现成 agent 插件的活（见下面「替代方案」），装它们即可，和本桥可以并存。

## 三步开法

1. **装 NapCat**：用一个小号登录，开 WebSocket 服务（默认 `ws://127.0.0.1:3001`），**只听回环**。
2. **填配置**：把 `onebot.json.example` 复制成 `onebot.json`，至少填 `ingressFile`、`selfId`、`allow.groups`/`allow.users`。
   （默认配置路径 `<ONEBOT_ROOT>/handoff/superagent/onebot.json`，也可用 `ONEBOT_CONFIG` 指定。）
3. **跑桥**：`node onebot-bridge.mjs`。看到 `ws open` 后，在白名单群里 @机器人 发 `!工单 标题`。

> kernel 侧要同时把 `config.ingressFile` 指到**同一个文件**（否则桥写得再对也没人读）。

## 安全默认（先看这段）

- **空白名单 = 一条都不接**（fail-closed）：`allow.groups` 与 `allow.users` 全空时，桥**直接拒绝启动**（exit 3）。
  空白名单不等于放行；要一条一条加。
- 群消息默认 **必须 @ 机器人**（`requireMention: true`）。
- **只认控制前缀**（默认 `!`）：`!工单 <标题>` / `!help`，其他消息只记日志、不建单。
- 只连 **127.0.0.1**，不发外网请求、不读 token。
- `logRaw` 默认关；开了会把原始消息文本写日志。

## 两条 QQ 路并行（事实，互不依赖）

1. **工单通道（本包自建）**：NapCat 小号（QQ.exe 监听 `127.0.0.1:3001`）→ `onebot-bridge.mjs`（可配 supervisor 守护）→ `ingress.jsonl` → kernel `tickIngress` 建单。
   群里的回执走 bridge 自己的 `replyOnAccept`（直接通过 NapCat 发 `send_group_msg` / `send_private_msg`）——**不经过** `notify_qq` / `send_to_qq`。
2. **聊天 / 推送通道（宿主插件）**：`dsh-qq-plugin@1.0.5`（作者 `xcisxc29`，走**腾讯官方 QQ 机器人平台**，不是 NapCat 路线），
   提供 `qqChannel` 与 `notify_qq` / `send_to_qq` 等出站工具。**本框架不依赖它**，也没有调用它。

两路可以**并存**：一条负责「把消息变成工单」，另一条负责「聊天/把结果推手机」。本包只做前者。

## 和宿主 QQ 插件的关系（出站可选、非依赖）

本包**不调用** `notify_qq` / `send_to_qq`，也不 import 任何 QQ 插件；它只写文件。
宿主里那类插件（如官方机器人平台的渠道插件）提供的是**出站**能力：把工单结果推到手机。
**不装它也能从 QQ 建单**；装了只是多了「结果自动推手机」——工单流程照跑，两边互不依赖。

## 设计来源与边界

- 规则参考开源项目 **Derpyu520/qq-bridge** 的 `RULES.md`（fail-closed 白名单、群聊 @ 门控、控制前缀、权限分层、
  管理命令在桥接层拦截、不经过模型）。
- **本桥只做「白名单消息 → ingress 事件」这一件事，不接管 agent 会话**：不建会话、不跑模型、不维护对话状态。
  与那类项目最大的区别就在这里——我们只做「触发器」，会话与推理交给 DSH 的 kernel/宿主。
- 我们**没有**实现它的四模式、会话重建、agent 侧控制台鉴权等能力；需要那些请直接装成熟插件。

## 替代方案（选型参考）

| 方案 | 社区信号 | 白名单默认 | 群聊行为 | 突出点 |
|---|---|---|---|---|
| [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) | ★ 约 2225 | fail-closed | 白名单群 + 安全预设 | `RULES.md` 成文规则、四模式 |
| [2710586329/dsh-qq](https://github.com/2710586329/dsh-qq) | 30 天约 5230 下载 | 私聊白名单默认开 | 默认 @ 才理（60s 窗口） | 本地离线 ASR、会话隔离 |
| [Tongyu3/dsh-qq-bot](https://github.com/Tongyu3/dsh-qq-bot) | 手机/本地部署向 | 空白 = 谁都不理 | 白名单群，否则丢弃 | 全程 127.0.0.1、一键本地 |
| [cheesehaqi/dsh-qq-onebot-bridge](https://github.com/cheesehaqi/dsh-qq-onebot-bridge) | 可观测性标杆 | fail-closed | 白名单 + @ 门控 | traceId / 离线回放 / 控制台鉴权 |
| [zxz-feng/dsh-qq-bridge](https://github.com/zxz-feng/dsh-qq-bridge) | ★ 0，设计参考向 | 空白 = 谁都不回 | 规则打分 + 概率决策器 | 零 token「何时闭嘴」决策 |
| **本包 `integrations/qq-ingress`** | — | **fail-closed（空 = 全拒）** | 只认控制前缀 + 可选 @ 门控 | 极薄、只建单、不碰 agent 会话 |

**一句话选型**：只想用 QQ 触发建单 → 用本桥；想让 QQ 变成完整聊天/远程控制通道 → 直接装上面某个成熟插件（两者可并存）。

## 五条通用安全（照本机笔记 §7）

1. 用**小号**登录 NapCat，别拿主号。
2. 白名单**从空开始**，一次只加一条，确认行为再继续。
3. 群聊优先 **@ 门控**（`requireMention: true`）。
4. NapCat 的 WS **只听 127.0.0.1**，不要对外监听。
5. 生产号**不要挂高权限工具**；桥只建单，不要给它别的授权。

## 自检

```bash
node onebot-bridge.mjs --selftest     # 期望末行：SELFTEST: ALL PASS（exit 0，不连网、不写生产文件）
node ingress-push.mjs                 # 不给 --file/INGRESS_FILE 时会报清晰错误并 exit 2（不猜路径）
```
