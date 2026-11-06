# 可选配套（companions）

内核（`index.js`）**不 import 任何配套**；配套都是独立的宿主插件或本地脚本，靠 **同一个 `queueDir` / `ingressFile`** 与内核协作。
装不装都能跑内核——只是少了对应的那一路能力。

| 配套 | 必需? | 不装失去什么 |
|---|---|---|
| **面板 UI**（不在本包） | 否 | 没有界面，只能用工具与 `state.json` 看进度；功能不减 |
| **watcher**（`integrations/codex-bridge/watcher/`，包名 `dsh-plugin-handoff-watch`） | 否 | 普通 handoff 文件不会自动投递成会话消息；**内核 `tickCodex` 仍在**，Codex 派活的工单完成 → ready 不受影响 |
| **QQ 触发**（NapCat + 本包自建 `onebot-bridge.mjs`，规则参考 Derpyu520/qq-bridge） | 否 | 不能从 QQ 建单；工单系统本身照常 |
| **QQ 出站/聊天**（宿主插件，如 `dsh-qq-plugin` 官方机器人通道，提供 `notify_qq` / `send_to_qq`） | 否 | 结果不会自动推手机；工单流程照跑。本包**不调用**它的工具，两边互不依赖 |

## 补充说明

- **Codex 桥**（`integrations/codex-bridge/` 里的 Stop/PermissionRequest hook）是 watcher 与 `sa_delegate_codex` 的**共同前置**：
  不装 hook 就没有 `events.jsonl` 事件，watcher 与 `tickCodex` 都收不到「Codex 完成」。
- **queue 路径必须一致**：hook 的 `HANDOFF_QUEUE` = 内核 `config.queueDir` = watcher `config.queueDir`（默认都是 `<stateDir>/queue`）。
- **QQ 通道只多一条入口**：`onebot-bridge.mjs` 写 `ingressFile`，内核 `tickIngress` 读；不装 QQ 什么都不影响。

## 三条铁律

1. **不写 dependencies**：DSH 插件靠 patch 层注册；写进 `dependencies` 只会把代码拖进 `node_modules` 却不挂载，还逼「只想用内核」的人多装一个插件。
2. **代码零耦合**：内核只读 `queueDir/events.jsonl` 与 `ingressFile` 的增量；watcher / QQ 桥各自独立写读，互不 import。
3. **安全默认 fail-closed**：QQ 白名单空 = 全拒；`ownerSessions` 空 = 写工具全拒；外部通路默认只读不写。
