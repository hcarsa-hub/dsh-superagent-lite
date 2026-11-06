# 提示词模板 · Codex 桥（旁路接入）

> **用途**：Codex（或任何"回合结束后写 handoff"的外部后端）怎么接进工单系统。
> 本桥**不联网**，只有"写文件"和"读文件"。全部事实来自 `integrations/codex-bridge/contract.md`。

---

## 1. 它在整个循环里的位置

```text
DSH: sa_delegate_codex(id)  写 <inboxFile>（含 sa-ticket: <id>）→ 工单 running(backend=codex)
        │
        ▼
Codex 在它自己的工作目录干活，把结果写回 handoff 文件
        │
        ▼
Codex 回合结束 → Stop hook 追加一行到 <queueDir>/events.jsonl
        │
        ▼
内核 tickCodex() 按字节游标增量读 → 命中 running(backend=codex) → 转 ready → 投递「请验收」给 owner
```

> 你**不需要**让 Codex 知道 DSH 的存在。它只要"回合结束时让 hook 落一行事件"就够了。

---

## 2. Stop hook 的输入契约

hook 从 **stdin** 读一个 JSON：

```json
{ "hook_event_name": "Stop", "session_id": "…", "turn_id": "…", "cwd": "<codex 工作目录>" }
```

- **只认** `hook_event_name === "Stop"`；其它事件（PreToolUse、PermissionRequest…）直接返回，**不落任何文件**。
- **缺省** `hook_event_name` 时按 Stop 处理（兼容老版 Codex）。
- 缺 `cwd` → 记一行 `no-cwd` 到 `hook.log`，**不落事件**。

---

## 3. 找 handoff 文件的顺序

1. 环境变量 `HANDOFF_FILE` 直接指定 → 存在就用；
2. 否则 `<cwd>/handoff/inbox/latest.md`；
3. 再否则 `<HANDOFF_ROOT>/handoff/inbox/latest.md`；
4. 都没有 → 记 `no-handoff`，不落事件。

相关环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HANDOFF_ROOT` | hook 进程的 cwd | 兜底根目录 |
| `HANDOFF_QUEUE` | `<HANDOFF_ROOT>/handoff/queue` | **事件队列目录** |
| `HANDOFF_FILE` | — | 直接指定 handoff 文件 |
| `HANDOFF_FRESH_MS` | `900000`（15 分钟） | 新鲜度窗口 |

---

## 4. 三个保护机制（别关掉）

### 4.1 新鲜度

`now - mtimeMs > HANDOFF_FRESH_MS` → 记 `stale`，**不落事件**。

> 理由：防止「一周前写过的文件，今天随便一跑又被当成新任务」。

### 4.2 去重

`<HANDOFF_QUEUE>/state.json`：

```json
{ "seen": { "<文件绝对路径>": 1790000000000 } }
```

同路径的 `mtimeMs <= 已记录` → 记 `duplicate`、不落事件。**同一文件被再次写（mtime 变新）才会再触发。**

### 4.3 fail-open（铁律）

- hook 任何异常都**吞掉**、**exit 0**、stdout 打 `{}`
- **绝不阻断 Codex 回合**——这是最重要的一条：宁可漏一个通知，也不能让用户的 Codex 卡死
- 不联网、不读 `auth.json` / token、不执行 DSH 或 Codex 命令

---

## 5. 事件格式（`events.jsonl` 一行）

```json
{ "ts": "<ISO 时间>", "sessionId": "<codex session>", "turnId": "<turn>", "cwd": "<工作目录>", "file": "<handoff 文件绝对路径>", "mtimeMs": 1790000000000, "size": 1234 }
```

- `events.jsonl` **只追加不重写**；DSH 侧按字节游标读（`codexOffset`），文件变短则游标归零。
- 同时写 `last.json`（最近一条，便于排查），每个动作往 `hook.log` 追一行（写失败也吞）。

---

## 6. 四个已知坑（别重踩）

| # | 坑 | 表现 | 怎么办 |
|---|---|---|---|
| 1 | **`.cmd` 引号** | Stop hook 直接失败、`events.jsonl` 一行也不涨 | Windows 路径带空格时，**命令与参数两端都要加引号** |
| 2 | **改 `hooks.json` 后信任失效** | 表现同样是"什么都没发生" | Codex 记录 hook 的**信任哈希**；改完必须回 Codex 里**重新信任** |
| 3 | **单文件一次** | 一个 handoff 里多个事件只投一次 | 按"单文件一次"设计（mtime + sha256 去重）；要多次触发就写多次 |
| 4 | **queue 路径两边一致** | 最常见的"装了但没反应" | hook 的 `HANDOFF_QUEUE` 与插件的 `queueDir` **必须指向同一目录** |

> 排查口诀：**先看 `hook.log` 有没有新行**。没有 → hook 根本没跑（坑 1/2）；有 `no-cwd`/`no-handoff`/`stale`/`duplicate` → 看对应那一项；有事件但工单不动 → 查 queueDir 不一致（坑 4）。

---

## 7. 审批旁路（PermissionRequest，可选）

如果想让 Codex 的权限请求也走文件审批而不是它自己的弹窗：

```text
<APPROVALS_DIR>/pending/<id>.json   请求（tool_name / tool_input / cwd / session_id / timeoutMs）
<APPROVALS_DIR>/res/<id>.json       决策 {"decision":"allow"} 或 {"decision":"deny","reason":"…"}
<APPROVALS_DIR>/policy.json         策略
```

策略文件结构（**缺文件 = 一律 defer 弃权**）：

```json
{
  "workspaces": [{ "id": "proj", "root": "<你的工作目录>" }],
  "deny": [{ "id": "no-rm", "regex": "rm -rf|Remove-Item -Recurse", "reason": "破坏性删除" }],
  "allow": [
    { "id": "ws-write", "type": "workspace-write", "reason": "工作区内写文件" },
    { "id": "readonly", "regex": "^(Get-ChildItem|git status|node --check)" }
  ],
  "default": "defer"
}
```

判定顺序：`deny` → `apply_patch`（Delete/Move 直接拒，路径必须落在 workspace 内）→ 链式/变量 defer → workspace-write 路径校验 → 只读 allow → 默认 defer。

**工作区外的请求直接弃权**（不写 pending、不投递，避免命令原文漏进别的会话）。等不到决策 → 超时弃权（默认 60 秒），Codex 回落到自己的弹窗。

---

## 8. 接入自检

- [ ] `hook.log` 在 Codex 回合结束后**有新行**（证明 hook 真的跑了）
- [ ] `events.jsonl` 在 handoff 更新后**多一行**（证明事件落了）
- [ ] `events.jsonl` 里的 `file` 路径就是你的 handoff 文件
- [ ] 插件的 `queueDir` 与 hook 的 `HANDOFF_QUEUE` **是同一个目录**
- [ ] 工单能从 `running(backend=codex)` 自动转 `ready`

---

## 相关文档

- 完整契约（含 approvals 细节）→ `integrations/codex-bridge/contract.md`
- 装 hook 的步骤 → `integrations/codex-bridge/README.md`
- 主循环里 Codex 旁路怎么并进来 → [`../loop.md`](../loop.md) §6.1
