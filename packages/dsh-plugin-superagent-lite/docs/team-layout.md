# 团队拓扑与命名规范

> 本页回答三件事：**建几个工作区、建几个会话、名字怎么起**。
> 本插件不自动创建侧栏可见的团队会话、不建工作区；`sa_new_session` 可请求宿主建会话但侧栏不可见，需服务与白名单。团队 UI 会话按下文手工建立，插件负责「谁干、谁验、状态怎么走」。
> `sa_*` 均在 DSH 会话中请求调用；工具名后的对象为 JSON 参数，不是 Shell 命令。

---

## 1. 推荐拓扑

```
<your-root>/
├── subagent/                  ← 三个「工作区」，在宿主里各登记一次
│   ├── worker_1/             真作业区 → 在里面建 coder_1、coder_2 两个会话
│   ├── test/                 测试区   → 在里面建 test_1
│   └── judge/                判官区   → 在里面建 judge_1（可选 judge_2 轮换）
└── <owner-workdir>/          owner（决策人）自己的工作区，**不要**放进 subagent/
```

对应的会话与角色：

| 工作区 | 目录建议 | 会话显示名（建议） | 登记角色 | 干什么 |
|---|---|---|---|---|
| owner 自己的工作区 | `<your-root>/<owner-workdir>` | owner（你自己的会话） | `owner` | 派单、验落地、收口 |
| worker_1 | `<your-root>/subagent/worker_1` | `coder_1`、`coder_2` | `worker` | 改代码 / 写测试 / 交证据 |
| test | `<your-root>/subagent/test` | `test_1` | `worker`（或 `judge`） | 只做验证与复现 |
| judge | `<your-root>/subagent/judge` | `judge_1`（可选 `judge_2`） | `judge` | 独立验收 |

> **为什么 owner 不进 `subagent/`**：`subagent/` 下是「被派活的执行区」，owner 是派活的人。放一起容易让 owner 的会话误以为自己也是 worker，也容易在清理执行区时误伤决策人自己的工作文件。

---

## 2. 为什么这么分

| 设计 | 理由 |
|---|---|
| **worker 与 judge 分工作区** | 判官要能独立复现、独立取证。同区同目录容易「看到 worker 的中间产物就当证据」，判断被污染。 |
| **worker_1 里可以有多份 coder 会话** | 同一区不同会话 = 同一份代码、不同任务，避免复制仓库；但**并发写同一文件会丢行**，所以要么串行、要么明确划分写入范围。 |
| **test 单独一个区** | 测试会造临时文件、跑破坏性命令。隔离出来，不弄脏真作业区。 |
| **judge 可选 `judge_2` 轮换** | 同一判官连续判同类单会形成惯性（"上次都过了"）。轮换能互相校准；单判官也能用，但要自己防惯性。 |
| **owner 单独一个区** | 决策人不干活，只验收；他的工作区里放 brief、验收记录、发布脚本。 |

---

## 3. 命名规范（**必读**）

### 3.1 显示名只是人看的

```text
coder_1 / coder_2 / test_1 / judge_1 / judge_2
```

这些是你在 **UI 里给会话起的名字**，方便你自己认。它们：

- **不是** session id；
- **不参与**任何路由；
- **不能**直接用于 `sa_role` / `sa_fanout` / `sa_tell`（那些要真实 id）。

### 3.2 派活与登记用的是 session id

```text
sa_role {"sessionId":"<真实 id>","role":"worker"}
sa_fanout {"id":"sa-XXX","sessionIds":["<worker A 的真实 id>","<worker B 的真实 id>"],"brief":"<完整派单说明>"}
sa_tell {"sessionId":"<真实 id>","prompt":"..."}
```

**怎么拿真实 id**：在那个会话里调 `sa_whoami`，返回 `sessionId=... | role=...`。让它把 id 复制给你（owner）登记。

> 拿到 id 后建议记在自己的笔记里（显示名 ↔ id 对照表），否则一重启 UI 就容易记混。

### 3.3 命名建议

| 建议 | 说明 |
|---|---|
| 用 `角色_序号`：`coder_1`、`judge_1` | 一眼知道它能干什么、是第几个 |
| 不要用 `worker`、`test` 这种单数名 | 撞名后无法区分是哪张单的执行体 |
| 一个会话专一角色 | 同一会话既当 worker 又当 judge，等于自己判自己，双筛就失效了 |
| 角色变更走 `sa_role` 的 `sessionId/role` 参数 | 不要靠改显示名假装换了角色——权限看的是 `owners.json` 里登记的角色 |

---

## 4. 三条硬限制（照实说，别指望插件替你解决）

### 限制 1：工作区 = 目录 + 在宿主里登记

- 工作区不是"插件概念"，是**宿主概念**：一个目录 + 在 DSH 里登记一次。
- 登记后该目录下的 `AGENTS.md` 会被注入到**该区的所有会话**。

### 限制 2：建会话有两条路——`sa_new_session` 或 UI 手动建

> **两条路都行，选哪条看你要不要自动化。**

**路 A：`sa_new_session`（程序化，sa-201 起可用）**

```text
sa_new_session {"cwd":"<工作区绝对路径>","title":"coder_3"}
→ { ok: true, detail: "session-<uuid>" }
```

前置条件（三个都得满足，缺一就建不了）：

1. 宿主提供 `sessionController` 服务（没有则工具明确报错，不影响其它工具）；
2. `config.sessionCreateRoots` 里**显式列出**允许的根目录——**默认 `[]` = 全拒**，不配就建不了；
3. `cwd` 必须是**已存在的绝对路径目录**。

> **默认拒绝是有意的红线**：不做成任意路径可建，避免一条命令在机器上乱造会话。

**路 B：UI 手动建**（没有 `sessionController`，或懒得配白名单时用）

在工作区里点「新建会话」。

**三个容易混的点**：

- `sa_tell`：只给**已存在**的会话投消息，不建会话；
- `sa_run`：起**临时子会话**，生命周期由宿主管，做完即回收，**不能当常驻 worker**；
- `sa_fanout` 的 `sessionIds` 模式：只是给已登记会话发消息，也不建会话。

> 所以「建出一个新会话」只有**路 A / 路 B**；其余三个工具都是**往已有会话上做动作**。

### 限制 3：AGENTS.md 的注入粒度

| 层级 | 文件 | 放什么 | 为什么 |
|---|---|---|---|
| 工作区级 | `<workspace>/AGENTS.md` | **角色 + 铁律**（我是谁、我不许做什么） | 注入该区**所有会话**，一次写好全员生效 |
| 会话级 | 新会话第一条提示词 | **这张单做什么**（具体任务） | 每次任务不同，不能写死在文件里 |

> 所以：**不要把某一单的具体任务写进 `AGENTS.md`**（所有会话都会看到，还会干扰别的单）；也**不要指望会话记得角色**（新会话没有上一轮记忆，角色靠 `AGENTS.md` + `sa_role` 登记）。

---

## 5. 最小 / 标准 / 强化 三档配置

| 档位 | 会话数 | 组成 | 适用 |
|---|---|---|---|
| **仅派活演示** | 2 | owner + 1 worker | 可交活，缺少独立验收，不作为完整闭环 |
| **完整双筛最小 / 标准**（推荐） | 3 | owner + 1 worker + 1 judge | 独立判定与 owner 收口，首单使用此档 |
| **强化** | 5 | owner + 2 coder + 1 test + 1 judge（或 judge_2 轮换） | 多张单并行、需要隔离测试 |

> 会话不是越多越好：每多一个常驻会话就多一份上下文开销，而且并发写同一文件的风险上升。**先跑通标准档再说。**

---

## 6. 一个具体的起步流程

```text
1) 宿主 UI 里加三个工作区目录：subagent/worker_1、subagent/test、subagent/judge
2) 在 owner 自己的工作区：你的会话（已有）
3) worker_1 里新建会话 → 显示名 coder_1   → 调 sa_whoami 记下 id
4) test 里新建会话   → 显示名 test_1    → 调 sa_whoami 记下 id
5) judge 里新建会话  → 显示名 judge_1   → 调 sa_whoami 记下 id
6) 回 owner 会话：
   sa_role {"sessionId":"<coder_1 id>","role":"worker"}
   sa_role {"sessionId":"<test_1 id>","role":"worker"}
   sa_role {"sessionId":"<judge_1 id>","role":"judge"}
7) sa_agents {} 核对名单
8) 给每个工作区写 AGENTS.md（模板见 prompts/）
```

做完 8 步，团队就建好了。接下来看 [getting-started.md](getting-started.md) 跑第一张单；[loop.md](loop.md) 用于理解触发、等待与失败回退。首次 owner 授权需先完成 [安装操作](install-operations.md)，不能把登记其他角色当作首次 owner 授权手段。
