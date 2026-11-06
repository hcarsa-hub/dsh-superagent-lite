# Codex 桥（可选扩展依赖）

**它不是网络插件**，是「文件队列 + 去重键」契约：Codex 回合结束时在本地队列追加一行事件，
DSH 侧（本插件的 `tickCodex` 或可选的 watcher 插件）读这一行决定「工单完成 / 提醒人」。

- 契约细节（schema、时序、失败策略）：[`contract.md`](contract.md)
- **不装它也完全可用**：`sa_delegate_codex` 仍会写 handoff 文件；只是 Codex 跑完后不会自动把工单推回
  `ready`，需要你用 `sa_list` / `sa_watchdog` 发现，或手动 `sa_advance`。
- 本桥**不联网、不读凭据、不执行 DSH/Codex 命令**；任何异常都 fail-open（exit 0、stdout `{}`）。

## 什么时候需要它

你要把工单交给 **Codex 后端**（`sa_delegate_codex`）跑，并希望「Codex 一跑完，DSH 侧自动把单推到 ready」时。
只用子代理（`sa_run` / `sa_fanout`）或只用人工交接的，不需要装。

## 怎么开（三步）

### 1) 放 hook 脚本

把本目录（`integrations/codex-bridge/`）放到一个**长期存在**的路径（别放临时目录），例如 `C:/work/codex-bridge/`。
目录里应有：

```
codex-stop-hook.mjs        Stop 事件 → 队列
request-hook.mjs           PermissionRequest → 待办 → 等决策
run-stop-hook.cmd          上者的启动器（把 .template 改名为 .cmd 后即可用）
run-permission-hook.cmd    同上
hooks.json.example         注册片段示例
watcher/                   可选：把队列事件投成会话消息的插件
```

`.template` 要先复制成 `.cmd`（并确认 node 在 PATH，或设 `NODE_EXE` 指向 node.exe）。

### 2) 注册到 Codex hooks

把 `hooks.json.example` 里的片段并进 Codex 的 hooks 配置（通常在 `<home>/.codex/hooks.json`；具体位置和字段以你的 Codex 版本为准），
把里面的 `C:/path/to/...` 换成你真实的路径。**改完要在 Codex 里重新信任 hook**（见「已知坑②」）。

### 3) 建 Codex 工作目录

Codex 跑起来时它的 `cwd` 下要有 `handoff/inbox/latest.md`（或者你把 `HANDOFF_FILE` 直接指到一个文件）。
并且让 **DSH 侧与 hook 用同一个队列目录**：

| 侧 | 环境变量/配置 | 默认 |
|---|---|---|
| hook | `HANDOFF_QUEUE` | `<HANDOFF_ROOT>/handoff/queue` |
| 插件 | `config.queueDir` | **无默认，必须显式配**（没配就打印错误且不启动） |

## 已知坑（别重踩）

1. **Windows 路径带空格**：`.cmd` 里命令和参数两端都要加引号，否则 Stop hook 静默失败、`events.jsonl` 一行也不涨。
2. **改 hooks 配置后信任哈希失效**：必须回到 Codex 里重新信任，否则 hook 不会执行（表现是「什么都没发生」）。
3. **一个 handoff 文件里出现多个事件**：按「单文件一次」投递（去重靠 mtime + sha256），不会重复提醒。
4. **queue 目录必须两边配成同一个**：hook 写 A、插件读 B 是最常见的「看起来装了但没反应」。

## 自检

```bash
node --check codex-stop-hook.mjs
node --check request-hook.mjs
# 干跑：同一份 stdin 喂两次，应只落 1 行事件；再喂 PreToolUse 应不落
```

## 发布说明（包名）

- 桥本身**不是独立 npm 包**；要单独发布 `watcher/` 的话，包名用 **`dsh-plugin-handoff-watch`**（已查空闲）。
- 另一个「dsh-plugin- + codex + bridge」组合的名字在 npm 上**已被占用**，不要用；桥的独立包只叫 `dsh-plugin-handoff-watch`。
