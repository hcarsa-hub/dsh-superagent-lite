# 快速开始（5 分钟最小可用）

> 目标：装好插件 → 建一个工作区和一个会话 → 登记角色 → 建一张单 → 跑完一次完整收口。
> 全程不需要写代码；只有第 1、2 步要碰命令行和配置文件。

本文中的 `<...>` 都是占位符，替换成你自己的值。

---

## 0. 你要先准备什么

| 需要 | 说明 |
|---|---|
| 一个 DSH 宿主 | 插件跑在宿主进程里，宿主提供 `schedule` / `subagents` 服务 |
| 一个 profile 目录 | 例如 `<your-home>/.dsh/profiles/<profile-name>` |
| 一个**会话**当 owner | 决策人自己用的会话；它会被登记成 `owner`，有派单/收口权限 |
| 至少一个**会话**当 worker | 干活的那个；可以是子代理，也可以是你在 UI 里另建的会话 |

> **关键认知**：本插件**不创建会话、不创建工作区**。会话要在宿主 UI 里手动建（见第 3 步）。插件只负责「谁干、谁验、状态怎么走」。

---

## 1. 安装（让宿主能解析到包）

在本包目录里执行（二选一）：

**A. link（推荐，离线可用）**

```bash
node scripts/install.mjs --profile "<your-profile-dir>"
# 只打印片段、不动文件系统：
node scripts/install.mjs --profile "<your-profile-dir>" --dry-run
```

脚本会在 `<profile>/node_modules/` 下建一个指向本包的链接，并**打印**要贴的 patch 片段——它**不会**改你的 `cordis.patch.yml`。

**B. npm 安装**（有 registry 时）

```bash
npm i dsh-plugin-subagent-lite
```

---

## 2. 配置（贴 patch 片段）

把下面的片段贴进 `<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: subagent-lite
      name: dsh-plugin-subagent-lite
      config:
        ownerSessions: ['<your-owner-session-id>']   # 必填！否则所有写工具都会被拒绝
```

> - `ownerSessions` 空 = 所有写工具返回 `forbidden`（只读工具仍可用）。**这是最常见的"装好了但什么都干不了"的原因。**
> - 不配 `stateDir` 时数据落在 `<home>/.dsh/subagent`。
> - 全部键与副作用见 [`config.md`](config.md)。

**怎么拿到自己的 session id**：装好并重启后，在目标会话里调 `sa_whoami`，它会返回 `sessionId=... | role=...`。

---

## 3. 建工作区 + 建会话（**只能手动，没有脚本**）

### 3.1 工作区 = 一个目录 + 在宿主里登记一次

在工作区列表里添加目录，例如：

```
<your-root>/subagent/worker_1
```

### 3.2 会话 = 在工作区里点「新建会话」

> ⚠️ **这一步没有 CLI / 没有脚本 / 没有工具能替你建**。本插件里也没有"建会话"的 API——`sa_tell` 只往**已存在**的会话投消息，`sa_run` 起的是**临时子会话**（宿主管生命周期，不能当常驻 worker 用）。
>
> 如果你确实想自动化，只能靠 UI 自动化（键鼠操作）或宿主自己暴露的建会话接口——**本包不提供**。

### 3.3 起几个会话？

最小可用 = **1 个 owner + 1 个 worker**。推荐拓扑见 [`team-layout.md`](team-layout.md)。

| 会话显示名（人看的） | 角色 | 职责 |
|---|---|---|
| owner（你自己的会话） | `owner` | 派单、验落地、收口 |
| coder_1 | `worker` | 干活、交证据、自报 |
| judge_1 | `judge` | 独立验收 |

> **显示名 ≠ session id**。`coder_1` 只是你在 UI 里起的名字，派活和登记角色用的是**真正的 session id**。详见 [`team-layout.md`](team-layout.md) §命名规范。

---

## 4. 登记角色（`sa_role`）

在 **owner 会话**里调：

```text
sa_role(sessionId="<coder_1 的真实 session id>", role="worker")
sa_role(sessionId="<judge_1 的真实 session id>", role="judge")
```

可选参数 `model`：只是给人看的标签（例：`model="<模型名>"`），方便你按任务挑人，不参与路由。

查看当前名单：

```text
sa_agents()     # owner / worker / judge 各是谁、各自登记的模型
sa_owners()     # 只有 owner 白名单
```

> 让 worker 自己调 `sa_whoami` 拿到 id 再报给 owner，是最省事的做法。

---

## 5. 建一张单（`sa_submit`）

在 owner 会话里：

```text
sa_submit(title="给我的一句话任务描述", priority=5, type="code")
```

返回 `sa-XXX`。可选参数：

| 参数 | 说明 |
|---|---|
| `priority` | 1–9，9 最急，默认 5 |
| `type` | `test` / `code` / `office`，不填按标题推断 |
| `auto` | `true` 才允许自动派单（需要另开 `autoDispatch`），默认 `false` |
| `sessionId` | 归属会话；省略 = 当前调用者 |

---

## 6. 派活（三种方式，按需选）

| 工具 | 做什么 | 适合 |
|---|---|---|
| `sa_fanout(id, sessionIds=[...], brief)` | 派给**已登记**的 worker 会话 | 常驻团队（推荐） |
| `sa_tell(sessionId, prompt)` | 只投一条消息给某个会话，**不建单** | 临时使唤一下 |
| `sa_run(id)` | 起**临时子会话**干活（需宿主有 `subagents`） | 一次性、不想常驻 |

派活时 `brief` 必须写清：**目标文件 + 交付三件套（产物 / 报告 / `sa_report`）+ 验收命令与末行 + 禁止项**。
模板见 [`prompts/worker.md`](prompts/worker.md)。

---

## 7. 收口（状态走完一整圈）

```
queued --派活--> running --worker: sa_attach + sa_report--> ready
      --judge: sa_verdict{pass:true}--> ready(判词已出) --owner: sa_advance to=done--> done
```

具体命令（按角色分）：

**worker**（在 worker 会话里）

```text
sa_attach(id="sa-XXX", sourcePath="<产物绝对路径>")   # 或 content="<文本>"
sa_report(id="sa-XXX", summary="做了什么 + 证据在哪")
```

**judge**（在 judge 会话里）

```text
sa_verdict(id="sa-XXX", pass=true, reason="<逐条判据 + 你亲手跑过的命令>")
# 不通过：pass=false，reason 必须写清缺什么（带文件/行号）
```

**owner**（回到自己会话）

```text
sa_list()                                  # 看单子
sa_advance(id="sa-XXX", to="done")         # 验完落地再收口
```

---

## 8. 装完自查清单

- [ ] `sa_whoami` 返回了 `sessionId` 和 `role=owner`（否则 `ownerSessions` 没配对）
- [ ] `sa_agents` 能看到你的 worker / judge
- [ ] `sa_submit` 能建单，`sa_list` 能看到它
- [ ] worker 调 `sa_report` 成功（不报 `forbidden`）
- [ ] judge 调 `sa_verdict` 成功
- [ ] owner 能把单推到 `done`

六条都过 = 最小闭环可用。

---

## 常见问题

**Q：装好了但所有写工具都报 `forbidden`**
A：`ownerSessions` 没配或配错。用 `sa_whoami` 拿到真实 id 填进去，重启宿主。

**Q：`sa_submit` 报 `no-session`**
A：没配 `sessionId` 兜底，且当前调用者识别不到。配 `sessionId` 或用 `sessionId=` 显式指定。

**Q：worker 收不到派活消息**
A：①worker 的 session id 登记对没对（`sa_agents` 看）；②宿主 `schedule` 服务在不在；③该会话是不是子代理路由（子会话不收 reminder 投递）。

**Q：能不能用脚本批量建会话？**
A：**不能**。本插件不提供建会话能力，宿主也没有稳定公开的建会话 API。只能 UI 手动建（或你自己做 UI 自动化）。

**Q：想让 worker 自动接活**
A：配 `autoDispatch: true` + 建单时 `auto: true` + 已登记 worker。三个条件缺一不生效。

---

## 下一步

- 团队怎么分、起几个会话 → [`team-layout.md`](team-layout.md)
- 一整圈的时序图、谁在等谁、怎么回退 → [`loop.md`](loop.md)
- 每个角色的提示词模板 → [`prompts/`](prompts/)
- 全部配置项 → [`config.md`](config.md)
