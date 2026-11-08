# Codex 桥 · 双向文件契约

本桥**不联网**，只有两类东西：**Codex 的 hook 事件**（写文件）和 **DSH 侧的读**（插件/工具）。
所有状态都在你指定的两个目录里（`queueDir` / `approvalsDir`），随时可以删掉重来。

```
Codex 回合结束 (Stop hook)
   └─ codex-stop-hook.mjs ── 写 ──▶ <queueDir>/events.jsonl   （+ last.json / state.json / hook.log）
                                        │
                                        ├─▶ dsh-plugin-superagent-lite.tickCodex()
                                        │      → 命中 running(backend=codex) 的工单 → 转 ready → outbox 投递
                                        └─▶ watcher 插件（可选）
                                               → 内容不含 sa-ticket 的 handoff → 投一条「handoff 就绪」消息

DSH sa_delegate_codex
   └─ 写 <inboxFile>（默认 <stateDir>/../inbox/latest.md，含 sa-ticket: <id>）
          └─ 之后 Codex 回合结束时由 Stop hook 把「已完成」送回上面的 events.jsonl
```

## 1. Codex → DSH（Stop 事件）

hook 从 **stdin** 读一个 JSON：

```json
{ "hook_event_name": "Stop", "session_id": "…", "turn_id": "…", "cwd": "C:/work/proj" }
```

- **只认** `hook_event_name === 'Stop'`；其它事件（PreToolUse、PermissionRequest…）直接返回，不落任何文件。
- 缺省 `hook_event_name` 时按 Stop 处理（兼容老版 Codex）。
- 缺少 `cwd` → 记一行 `no-cwd` 到 `hook.log`，不落事件。

## 2. 找 handoff 文件规则

1. `HANDOFF_FILE`（环境变量）直接指定 → 存在就用；
2. 否则 `<cwd>/handoff/inbox/latest.md`；
3. 再否则 `<HANDOFF_ROOT>/handoff/inbox/latest.md`；
4. 都没有 → `no-handoff` 记日志，不落事件。

`HANDOFF_ROOT` 默认 = hook 进程的 `cwd`；`HANDOFF_QUEUE` 默认 = `<HANDOFF_ROOT>/handoff/queue`。

## 3. 新鲜度

`HANDOFF_FRESH_MS`，默认 **900000（15 分钟）**。`now - mtimeMs > FRESH` → 记 `stale`，不落事件。
理由：防止「Codex 一周前写过、今天随便一跑又被当成新任务」。

## 4. 去重

`<HANDOFF_QUEUE>/state.json`：

```json
{ "seen": { "<文件绝对路径>": 1790000000000 } }
```

同路径的 `mtimeMs <= 已记录` → 记 `duplicate`、不落事件。**同一文件被再次写（mtime 变新）才会再触发**。

## 5. 事件格式

`<HANDOFF_QUEUE>/events.jsonl` 追加一行：

```json
{ "ts": "2026-11-06T11:20:00.000Z", "sessionId": "…", "turnId": "…", "cwd": "C:/work/proj", "file": "C:/work/proj/handoff/inbox/latest.md", "mtimeMs": 1790000000000, "size": 1234 }
```

同时写 `last.json`（最近一条，便于排查），每个动作都往 `hook.log` 追一行（写失败也吞）。
`events.jsonl` 只追加不重写；DSH 侧按字节游标读（`codexOffset`），文件变短则游标归零。

## 6. fail-open 铁律

- hook 任何异常都吞掉、**exit 0**、stdout 打 `{}`，绝不阻断 Codex 回合
- 不联网、不读 `auth.json` / token、不执行 DSH 或 Codex 命令
- 写队列失败只记 `hook.log`（失败则彻底静默）

## 7. DSH → Codex（派活）

1. `sa_delegate_codex { id }` 写 `<inboxFile>`（默认 `<stateDir>/../inbox/latest.md`），内容含 `sa-ticket: <id>` 标记；
   工单转 `running(backend=codex)`。
2. Codex 在**它的工作目录**里干活，把结果写回 `<cwd>/handoff/inbox/latest.md`（或同一个 inboxFile）。
3. Codex 回合结束 → Stop hook 落事件。
4. `tickCodex()` 按 `codexOffset` 增量读 `events.jsonl` → 找到 running 且 backend=codex 的单 → 转 `ready` → 走正常 outbox 投递给 owner。

> 插件与 hook 的 `queueDir` / `HANDOFF_QUEUE` **必须指向同一个目录**，否则永远读不到（常见坑 ④）。

## 8. watcher（可选插件）

`watcher/` 是独立 cordis 插件（`dsh-plugin-handoff-watch`）：

- 游标 `<queueDir>/cursor.json`，逐行读 `events.jsonl`
- **跳过**内容含行首 `sa-ticket:` 的 handoff（那是工单，由 `tickCodex` 收口，避免双重通知）
- 其余 handoff → 走宿主 `schedule` 投给 `sessionId`
- 同文件内容 sha256 去重（`deliveredFiles` 最多 50 条，超出丢最旧）
- 投递失败不记哈希，下一轮重试（不丢）

## 9. PermissionRequest（审批）契约

`request-hook.mjs` 把请求写成文件，DSH 侧写回决策：

```
<APPROVALS_DIR>/pending/<id>.json     请求（tool_name / tool_input / cwd / session_id / turn_id / timeoutMs）
<APPROVALS_DIR>/res/<id>.json         决策 {"decision":"allow"} 或 {"decision":"deny","reason":"…"}
<APPROVALS_DIR>/log.jsonl             审计（policy / request / decision / timeout 各一行）
<APPROVALS_DIR>/policy.json           策略（见下）
```

策略文件结构（缺文件 = 一律 defer 弃权）：

```json
{
  "workspaces": [{ "id": "proj", "root": "C:/work/proj" }],
  "deny": [{ "id": "no-rm", "regex": "rm -rf|Remove-Item -Recurse", "reason": "破坏性删除" }],
  "allow": [
    { "id": "ws-write", "type": "workspace-write", "reason": "工作区内写文件" },
    { "id": "readonly", "regex": "^(Get-ChildItem|git status|node --check)" }
  ],
  "default": "defer"
}
```

判定顺序：deny → apply_patch（Delete/Move 直接拒，路径必须落在 workspace 内）→ 链式/变量 defer →
workspace-write 路径校验 → 只读 allow → 默认 defer。**工作区外的请求直接弃权**（不写 pending、不投递，
避免命令原文漏进别的会话）。等不到决策 → 超时弃权（默认 60 秒），Codex 回落到自己的弹窗。

## 10. 已知坑（四个，别重踩）

1. **`.cmd` 引号**：Windows 路径带空格时，命令与参数两端都要加引号；写错的表现是 Codex 的 Stop hook 直接失败、`events.jsonl` 一行也不涨。
2. **改 `hooks.json` 后信任失效**：Codex 记录 hook 的信任哈希，改完必须回到 Codex 里重新信任，否则 hook 不会执行（表现同样是「什么都没发生」）。
3. **单文件一次**：一个 handoff 文件里出现多个事件时，按「单文件一次」投递（mtime + sha256 去重），不会重复提醒。
4. **queue 路径两边一致**：hook 的 `HANDOFF_QUEUE` 与插件的 `queueDir` 必须指向同一目录；一边 A 一边 B 是最常见的「装了但没反应」。
