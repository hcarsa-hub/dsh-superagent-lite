# dsh-plugin-handoff-watch（可选）

codex-bridge 的「DSH 侧耳朵」：读 `<queueDir>/events.jsonl`，把**不是工单**的 handoff 事件投递成目标会话的一条消息。

- 跳过内容含行首 `sa-ticket:` 的 handoff（那是工单，由 `tickCodex` 收口，避免双重通知）
- 同一文件内容 sha256 去重（最多 50 条）
- 投递走宿主 `schedule` 服务；失败不记哈希、下轮重试

## 安装

```bash
# 1) link 到 profile 的 node_modules（与主插件同一套做法）
node scripts/install.mjs --profile <profile> --name dsh-plugin-handoff-watch
# 或手工建 junction：<profile>/node_modules/dsh-plugin-handoff-watch -> 本目录

# 2) profile 的 cordis.patch.yml 加一段
```

```yaml
- insert:
    - id: handoff-watch
      name: dsh-plugin-handoff-watch
      config:
        queueDir: 'C:/work/proj/handoff/queue'   # 必填，与 Codex hook 的 HANDOFF_QUEUE 同一个目录
        sessionId: '<把消息投给哪个会话>'
        pollMs: 2000
```

## 配置

| 键 | 类型 | 默认 | 必填 | 说明 | 副作用 |
|---|---|---|---|---|---|
| `queueDir` | string | 无（**不配就打印错误并拒绝启动**） | 是 | Codex hook 写的队列目录 | 配错 = 永远收不到事件 |
| `sessionId` | string | `$DSH_SESSION_ID` | 否 | 投递目标会话 | 空 = 投递时报 `sessionId not configured`，游标不推进（下轮重试） |
| `pollMs` | number | `2000` | 否 | 轮询间隔，最小 500ms | 太小空转，太大提醒延迟 |
| `title` | string | `handoff 就绪` | 否 | 消息标题 | — |
| `approvalsDir` | string | `<queueDir>/../approvals` | 否 | Codex 权限请求目录（请求投递开关） | 配了才会投「Codex 权限请求」消息 |

## 不配 queueDir 时

```
[dsh-plugin-handoff-watch] 未配置 queueDir：请在 profile config 里给 queueDir，且与 Codex hook 的 HANDOFF_QUEUE
指向同一个目录（例如 <你的项目>/handoff/queue）。本插件未启动。
```

打印这一行后 `apply()` 返回 null、不建目录、不抛栈（cordis 只会记一条插件未启动）。
