# 快速开始（安装、授权与第一张完整工单）

> 目标：装好插件 → 准备 owner / worker / judge 三个独立会话 → 登记角色 → 建一张单 → 送审与收口。
> 不要求写业务代码；安装、路径配置和首次授权恢复需要操作终端或配置文件，耗时取决于宿主环境。

本文中的 `<...>` 都是占位符，替换成你自己的值。
所有 `sa_*` 示例表示**在 DSH 会话中请求调用工具**；工具名后的对象是 JSON 参数，不是终端命令。无参数工具传 `{}`。

---

## 0.1 安装前检查表（先核完再动手）

| 检查项 | 要求 | 怎么核 |
|---|---|---|
| 命令行 Node | **≥ 20**（`package.json` 的 `engines` 要求；安装脚本要跑 Node） | `node -v` |
| 实际 profile 目录 | 你**实际启用**的那个 profile；根安装器不传 `--profile` 时默认找 `desktop`，不对就显式传 | 在宿主里确认当前 profile 名 |
| 目录写权限 | 对 `<profile>/node_modules/` 与 `<profile>/cordis.patch.yml` 可写；受限沙箱里会 `Permission denied` | 在 profile 目录试写一个文件 |
| 宿主版本 | 未逐一验证各 DSH 版本（未验证）；遇到「宿主要求包登记在 `dependencies`」的情形按 [README](../README.md)「已知限制」一节的分支处理 | 先按 link 装完看 `sa_whoami` |
| 模型通道 | 首单实操只需要你自己的 owner 会话 + 一个 worker 会话，不需要额外模型通道 | — |
| 平台差异 | Windows 用 junction（不需管理员）；非 Windows 用符号链接。面板「定位文件」按钮仅 Windows 可用 | — |

> 离线解包安装（link 方式）全程不联网；只有后续把工单派给模型/子代理执行时才需要相应通道在线。

## 0. 你要先准备什么

| 需要 | 说明 |
|---|---|
| 一个 DSH 宿主 | 插件跑在宿主进程里，宿主提供 `schedule` / `subagents` 服务 |
| 命令行 Node ≥20 | `node --version` 核对；宿主兼容版本范围未验证，按 [安装前检查](install-operations.md) 核对服务能力 |
| 一个 profile 目录 | 例如 `<your-home>/.dsh/profiles/<profile-name>` |
| 写权限与模型通道 | 使用实际活动 profile；链接安装可离线，模型回合的网络需求由所选通道决定 |
| 一个**会话**当 owner | 决策人自己用的会话；它会被登记成 `owner`，有派单/收口权限 |
| 至少一个**会话**当 worker | 干活的那个；可以是子代理，也可以是你在 UI 里另建的会话 |
| 一个独立**会话**当 judge | 本文完整双筛闭环必需，不能由执行该单的 worker 自判 |

> **关键认知**：本插件不自动创建侧栏可见的团队会话、不创建工作区。`sa_new_session` 可请求宿主建会话，但需 `sessionController` 与显式 `sessionCreateRoots`，且当前已知侧栏不可见；常驻团队位建议用 UI 建（见第 3 步）。

---

## 1. 安装（让宿主能解析到包）

以下为单独内核包入口，在包含 `scripts/install.mjs` 的包目录执行。三插件捆绑包使用根 `install.mjs`，默认打印计划、`--apply` 才写入；完整的两种入口与卸载差异见 [安装操作](install-operations.md)。

**A. link（推荐，离线可用）**

```powershell
$profileDir = Join-Path $env:USERPROFILE '.dsh/profiles/desktop'  # 换成实际活动 profile
node scripts/install.mjs --profile "$profileDir" --dry-run
node scripts/install.mjs --profile "$profileDir"
```

```bash
profile_dir="$HOME/.dsh/profiles/desktop"  # 换成实际活动 profile
node scripts/install.mjs --profile "$profile_dir" --dry-run
node scripts/install.mjs --profile "$profile_dir"
```

脚本会在 `<profile>/node_modules/` 下建一个指向本包的链接，并**打印**要贴的 patch 片段——它**不会**改你的 `cordis.patch.yml`。

**B. npm 安装**（registry 发布状态未验证；确认版本存在且采用 npm 管理 profile 后才选）

```bash
cd "$profile_dir"
npm install dsh-plugin-superagent-lite@0.1.9
```

PowerShell 对应先执行 `Set-Location -LiteralPath $profileDir`，再执行上述 npm 命令。安装位置必须是目标 profile；依赖登记分支见 [安装操作](install-operations.md)。

---

## 2. 配置（贴 patch 片段）

把下面的片段贴进 `<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: superagent-lite
      name: dsh-plugin-superagent-lite
      config:
        ownerSessions: ['<your-owner-session-id>']   # 必填！否则所有写工具都会被拒绝
        attachRoots: ['<项目产物目录绝对路径>']       # 首次附加项目产物前配置
        autoDispatch: false                        # 本教程手工派单
        autoJudge: false                           # 本教程手工送审
```

> - `ownerSessions` 空 = 所有写工具返回 `forbidden`（只读工具仍可用）。**这是最常见的"装好了但什么都干不了"的原因。**
> - 不配 `stateDir` 时数据落在 `<home>/.dsh/subagent`。
> - 全部键与副作用见 [`config.md`](config.md)。

**首次启动前拿到 session id**：从宿主 UI 会话详情/复制 id 功能取得，具体 UI 入口未验证。若 UI 无法取得，可先以空 owner 名单加载，调用只读 `sa_whoami {}`，然后按 [首次授权恢复](install-operations.md) 修复已有 `owners.json` 的 `owners` 数组并保留全部其他角色与配置。`ownerSessions` 仅在该文件不存在时播种，不能靠补填 patch 再重启修复已有空名单。

默认 `attachRoots` 为 stateDir 的父目录（通常 `~/.dsh`）与系统临时目录，且敏感路径限制仍生效；项目产物必须显式配置允许目录。捆绑模板默认 `autoJudge:true`，若保留该值，登记 judge 后使用第 7 步的自动送审分支。

---


> **ownerSessions 只播种一次**：内核仅在 `<stateDir>/owners.json` **不存在**时按 patch 里 `ownerSessions` 初始化一次；
> 之后改 patch 再重启**不会**更新已有名单。填错顺序的补救：直接改 `<stateDir>/owners.json` 的 `owners` 数组（其它角色字段不动），
> 名单按 mtime 热读、不用重启；或删掉该文件再重启让它重新播种。
## 3. 建工作区 + 侧栏可见的团队会话

### 3.1 工作区 = 一个目录 + 在宿主里登记一次

在工作区列表里添加目录，例如：

```
<your-root>/subagent/worker_1
```

### 3.2 会话 = 在工作区里点「新建会话」

> ⚠️ **常驻团队位只能手动建**。`sa_new_session` 能建出可派活的会话，但侧栏/`workspace.json` 看不到（见 [`known-limitations.md`](known-limitations.md) §1）；`sa_tell` 只往**已存在**的会话投消息，`sa_run` 起的是**临时子会话**（宿主管生命周期，不能当常驻 worker 用）。
>
> 如果你要的是**侧栏可见**的常驻会话，只能靠 UI 手动建（或你自己做 UI 自动化）——本包不提供 UI 自动化。

### 3.3 起几个会话？

完整双筛最小闭环 = **1 个 owner + 1 个 worker + 1 个独立 judge**。只有 owner + worker 可派活交活，缺少独立验收；本文按三会话闭环操作。推荐拓扑见 [`team-layout.md`](team-layout.md)。

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
sa_role {"sessionId":"<coder_1 的真实 session id>","role":"worker","kind":"code"}
sa_role {"sessionId":"<judge_1 的真实 session id>","role":"judge"}
```

可选参数 `model`：只是给人看的标签（例：`model="<模型名>"`），方便你按任务挑人，不参与路由。

查看当前名单：

```text
sa_agents {}
sa_owners {}
```

> 让 worker 自己调 `sa_whoami` 拿到 id 再报给 owner，是最省事的做法。

---

## 5. 建一张单（`sa_submit`）

在 owner 会话里：

```text
sa_submit {"title":"给我的一句话任务描述","priority":5,"type":"code","auto":false}
```

返回 `sa-XXX`。可选参数：

| 参数 | 说明 |
|---|---|
| `priority` | 1–9，9 最急，默认 5 |
| `type` | `test` / `code` / `office` / `doc`。**建议每次显式给**：不填时按标题推断，实战里常推断失败、面板显示「未标」；另 `doc` 目前面板无对应标签（显示未标） |
| `auto` | 默认 `true`；本例显式 `false` 以便手工派单。实际自动派单还要求全局 `autoDispatch:true` 和已登记、`kind` 匹配且可接单的 worker |
| `sessionId` | 归属会话；省略 = 当前调用者 |

---

## 6. 派活（三种方式，按需选）

| 工具 | 做什么 | 适合 |
|---|---|---|
| `sa_fanout`，参数 `id/sessionIds/brief` | 派给**已登记**的 worker 会话 | 常驻团队（推荐） |
| `sa_tell`，参数 `sessionId/prompt` | 只投一条消息给某个会话，**不建单** | 临时使唤一下 |
| `sa_run`，参数 `id` | 起**临时子会话**干活（需宿主有 `subagents`） | 一次性、不想常驻 |

派活时 `brief` 必须写清：**目标文件 + 交付三件套（产物 / 报告 / `sa_report`）+ 验收命令与末行 + 禁止项**。
模板见 [`prompts/worker.md`](prompts/worker.md)。

owner 使用第 5 步返回的真实工单号请求调用：

```text
sa_fanout {"id":"sa-XXX","sessionIds":["<worker 的真实 id>"],"brief":"<目标文件、产物目录、报告、验收命令及预期、禁止项；完成后 attach 并 report final:true>"}
```

核对返回的投递结果、`sa_list {}` 与 worker 实际接收情况。手工派单通知失败可能返回 `FAIL->...`，不会自动撤销已登记状态，先查明再恢复，避免重复派单。

---

## 7. 收口（状态走完一整圈）

```
queued --派活--> running --worker: sa_attach + sa_report--> ready
      --judge 判 pass--> ready(判词已出) --owner 核证据并收口--> done
```

具体命令（按角色分）：

**worker**（在 worker 会话里）

```text
sa_attach {"id":"sa-XXX","sourcePath":"<已配置允许根内的产物绝对路径>"}
sa_report {"id":"sa-XXX","summary":"做了什么 + 证据在哪 + 未验证项","final":true}
```

`sa_attach` 也可使用 `content` 写文本；阶段汇报不带 `final:true`。单到 ready 后，**owner 手工送审**（本教程 `autoJudge:false`）：

```text
sa_judge {"id":"sa-XXX","judgeSessionId":"<judge 的真实 id>","criteria":"<brief 中逐条判据、验收命令及预期结果>"}
```

若已启用 `autoJudge` 且已登记独立 judge，先核对自动指派与实际接收，避免重复送审。仅登记 judge 不会开启自动送审。

**judge**（在 judge 会话里）

```text
sa_verdict {"id":"sa-XXX","pass":true,"reason":"<逐条判据 + 亲验命令与结果 + 未验项>"}
```

不通过时传 `"pass":false`，reason 写清缺口与文件/行号；判词通过仍为 ready，收口由 owner 完成。done 是终态，不能再转 blocked。

**owner**（回到自己会话）

```text
sa_list {}
sa_evidence {"id":"sa-XXX"}
sa_advance {"id":"sa-XXX","to":"done"}
```

按顺序先核对判词、清单与磁盘，补齐缺件/孤儿文件，验完落地才调用 `sa_advance`。

---

## 8. 装完自查清单

- [ ] `sa_whoami` 返回了 `sessionId` 和 `role=owner`（否则 `ownerSessions` 没配对）
- [ ] `sa_agents` 能看到你的 worker / judge
- [ ] `sa_submit` 能建单，`sa_list` 能看到它
- [ ] worker 调 `sa_report` 成功（不报 `forbidden`）
- [ ] owner 已手工 `sa_judge` 或核对自动送审成功，judge 实际收到请求
- [ ] judge 调 `sa_verdict` 成功
- [ ] owner 能把单推到 `done`

以上都过 = 完整双筛闭环可用；工具注册应为 32 个，包含 `sa_steer`、`sa_compact`。

---

## 9. 配 attachRoots（第一次跨目录交产物前）

`sa_attach` 的 `sourcePath` 默认只允许 `stateDir` 的父目录（通常 `~/.dsh`）与系统临时目录。worker 的产物落在工作区里（不在上述范围）就配：

```yaml
# <profile>/cordis.patch.yml 里该插件 config: 下加一行
attachRoots: ['<your-project-root>']   # 你的项目产物根目录，可多条
```

敏感路径（`.ssh` / `.gnupg` / `.dsh` / `*.pem` / `credentials.json` 等）在任意根内都会被拒绝。详见 [`config.md`](config.md)。

---

## 常见问题

**Q：装好了但所有写工具都报 `forbidden`**
A：先用只读 `sa_whoami {}` 核对 id；已有 `owners.json` 时仅改 `ownerSessions` 无效。由现有 owner 授权，或按 [首次授权恢复](install-operations.md) 保留其余角色修复名单。

**Q：`sa_submit` 报 `no-session`**
A：没配 `sessionId` 兜底，且当前调用者识别不到。配 `sessionId` 或用 `sessionId=` 显式指定。

**Q：worker 收不到派活消息**
A：①worker 的 session id 登记对没对（`sa_agents` 看）；②宿主 `schedule` 服务在不在；③该会话是不是子代理路由（子会话不收 reminder 投递）。

**Q：能不能用脚本批量建会话？**
A：常驻团队位**只能 UI 手动建**。`sa_new_session` 能建出可派活的会话，但侧栏/`workspace.json` 看不到，适合一次性验证（见 [`known-limitations.md`](known-limitations.md) §1）。

**Q：想让 worker 自动接活**
A：全局 `autoDispatch:true` + 工单 `auto:true`（省略默认 true）+ 已登记、`kind` 匹配且可接单的 worker，三个条件缺一不生效。

---

## 下一步

- 安装前检查、授权恢复、升级与卸载 → [`install-operations.md`](install-operations.md)
- 团队怎么分、起几个会话 → [`team-layout.md`](team-layout.md)
- 一整圈的时序图、谁在等谁、怎么回退 → [`loop.md`](loop.md)
- 每个角色的提示词模板 → [`prompts/`](prompts/)
- 全部配置项 → [`config.md`](config.md)
