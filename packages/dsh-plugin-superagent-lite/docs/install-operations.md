# 安装前检查、首次授权与版本恢复

本文区分单独内核包与三插件捆绑包。首次工单操作集中在 [getting-started.md](getting-started.md)；工具调用在 DSH 会话内进行，终端只执行标有 PowerShell / Bash 的命令。所有 `<...>` 均需替换，示例路径不代表当前机器的目录。

## 安装前检查

| 检查 | 要求与确认方式 |
|---|---|
| 命令行 Node | `node --version` 应为 ≥20，与内核 `package.json` 的 `engines` 一致；宿主自带运行时与终端 Node 分别确认 |
| 实际 profile | 在宿主设置中确认当前启用的 profile，核对其 `cordis.patch.yml`；不要因为安装器默认找 `desktop` 就认定它是活动 profile |
| 目录权限 | 对解包目录和目标 profile 有读写权限；Windows 使用 junction，非 Windows 使用符号链接，权限要求由系统决定；Windows junction 本身不要求管理员 |
| 宿主能力 | 必需 `tools`；会话派单需要 `schedule`；`sa_run` / `sa_fanout(models)` 需要 `subagents`；`sa_new_session` 需要 `sessionController` 与白名单；`sa_steer` 需要宿主 Agent 查找与投递能力 |
| 宿主版本 | 此文档副本没有宿主运行环境，兼容版本范围**未验证**；先在隔离 profile 核对上述服务和工具，再用于正式 profile |
| 模型通道 | 准备一个在宿主中能完成普通回合的模型通道；离线解包/链接不需要 registry，模型执行是否联网由所选通道决定 |
| 团队 | 完整双筛使用三个独立会话：owner、worker、judge；先从宿主 UI 获取真实会话 id（显示名不等于 id） |
| 数据与产物 | 明确 `stateDir`，项目产物目录必须显式加入 `attachRoots`；不要把凭据目录加入允许根 |

捆绑包中的面板和 watcher 均可选。面板「定位文件」使用 Windows `explorer.exe`，非 Windows 不提供该按钮能力；其余界面功能仍需在目标宿主验证。

## 1. 让宿主解析包

### 三插件捆绑包 / 发布仓根安装器

先把终端切换到解包后的目录（该目录应包含 `install.mjs`、`uninstall.mjs`、`packages/`）。以下是两种 Shell 的完整 profile 参数写法，二选一；使用其他 profile 时修改变量。

PowerShell：

```powershell
$profileDir = Join-Path $env:USERPROFILE '.dsh/profiles/desktop'
Test-Path -LiteralPath (Join-Path $profileDir 'cordis.patch.yml')
node install.mjs --profile "$profileDir"
node install.mjs --profile "$profileDir" --apply
```

Bash：

```bash
profile_dir="$HOME/.dsh/profiles/desktop"
test -f "$profile_dir/cordis.patch.yml"
node install.mjs --profile "$profile_dir"
node install.mjs --profile "$profile_dir" --apply
```

安装器默认只打印计划，`--apply` 才写入；目标为 3 个主名 + 2 个兼容别名。它先规划所有目标，正确链接跳过；如果将使用的 `.bak-bundle` 备份已存在，**任何写入前拒绝**。先检查并保留已有备份，再按安装器提示处理冲突，不要覆盖备份以求继续。

安装后检查实际 patch 中的三条 insert，**首次加载前**填写下一节的 owner、投递目标和路径。安装器输出的 dependencies 提示应按下文宿主分支判断。

### 单独内核包

在内核包目录（包含 `scripts/install.mjs`）执行：

```powershell
$profileDir = Join-Path $env:USERPROFILE '.dsh/profiles/desktop'
node scripts/install.mjs --profile "$profileDir" --dry-run
node scripts/install.mjs --profile "$profileDir"
```

```bash
profile_dir="$HOME/.dsh/profiles/desktop"
node scripts/install.mjs --profile "$profile_dir" --dry-run
node scripts/install.mjs --profile "$profile_dir"
```

此脚本建立内核链接并打印 patch 片段，需手工合并片段。它与根目录捆绑安装器是两个入口，不能混用默认写入行为。

registry 发布状态及版本可获取性**未验证**，因此首装推荐离线链接。只有确认目标 registry 提供所需版本、并选择由 npm 管理该 profile 时，才在**目标 profile** 执行以下替代操作（会改 profile 的依赖与锁文件）：

```powershell
Set-Location -LiteralPath $profileDir
npm install dsh-plugin-superagent-lite@0.1.9
```

```bash
cd "$profile_dir"
npm install dsh-plugin-superagent-lite@0.1.9
```

### dependencies 与 patch 各解决什么

| 宿主解析能力 | 操作 |
|---|---|
| 能从 profile 的链接直接解析包，并按 patch 加载 | 链接 + insert 即可，无需额外登记 dependencies |
| 要求 profile 的 `package.json` 登记本地包 | 先备份 profile 的 `package.json` 与锁文件，按该宿主支持的包管理器登记本地链接，再保留同一条 insert；具体宿主版本/包管理器组合**未验证** |

两条分支都需要 patch 才能挂载插件。内核包自身零第三方依赖，与 profile 是否需要登记内核包是两件事。不要混用包管理器；若其重建链接，重新核对链接实际目标。可用宿主指定的本地链接命令；仅在已确认其支持 `link:` 的情况下使用 `"dsh-plugin-superagent-lite": "link:<内核包绝对目录>"`。无法确认时先在隔离 profile 验证，不能把安装器打印的提示当成兼容性证明。

## 2. 首次授权与路径配置

### 首次启动前取得 id

先在宿主 UI 打开拟任 owner 的会话，从会话详情/复制 id 功能取真实 id；不同宿主 UI 的入口名称**未验证**。填入 patch 的 `ownerSessions`，随后才加载插件。不得把显示名当 id。

若 UI 没有提供 id，允许先以 `ownerSessions: []` 加载一次，只在目标会话调用只读 `sa_whoami`，然后按下一小节修复已生成的角色名单。**只改 patch 再重启不会更新已有 `owners.json`。**

单独内核的首单示例配置：

```yaml
- insert:
    - id: superagent-lite
      name: dsh-plugin-superagent-lite
      config:
        ownerSessions: ['<owner 会话 id>']
        stateDir: ''
        attachRoots: ['<项目产物目录的绝对路径>']
        autoDispatch: false
        autoJudge: false
```

`attachRoots` 不配时允许根为 **stateDir 的父目录（通常 `~/.dsh`）与系统临时目录**；敏感路径检查仍会拒绝 `.dsh` 等目录中的受保护路径，默认根不等于这些路径可附加。要 attach 项目产物，必须显式配置对应目录；不要依赖临时目录例外。路径上限与敏感路径见 [config.md](config.md)、[design.md](design.md)。

捆绑模板已有 `autoJudge:true` 与 `judgeRotate:true`；首单可以保留自动送审，但必须登记 judge 并检查实际投递。下列配置逐项核对：

| 位置 | 填写内容 |
|---|---|
| 内核 `config.ownerSessions` | owner 真实 id；仅在 `owners.json` 不存在时播种 |
| 面板 `config.sessionId` | 默认投递目标；面板 `stateDir` 与内核一致 |
| watcher `config.sessionId` | 真实投递目标，不能依赖宿主进程有 `DSH_SESSION_ID` |
| 内核 `config.attachRoots` | 项目产物目录绝对路径 |
| 内核 `config.queueDir` | 默认 `<stateDir>/../queue`；stateDir 默认时为 `~/.dsh/queue` |
| watcher `config.queueDir` | 默认 `~/.dsh/queue`；自定义 stateDir 时显式与内核指向同一目录 |
| Codex hook 环境变量 `HANDOFF_QUEUE` | 不是第三个 config 键；启用桥时显式指向同一队列，不依赖 hook 的独立默认值 |

### 已错误启动：保留角色名单修复 owner

1. 调用只读 `sa_whoami` 记录目标会话真实 id，确认当前内核实际 `stateDir`（可用 `sa_status` 查看状态文件位置）。
2. 停止宿主与所有对此 stateDir 写入的进程；备份完整 stateDir、profile patch、profile `package.json` 和锁文件。
3. 编辑已有 `<stateDir>/owners.json`：仅向 `owners` 数组追加目标 id，保留原有 owners、workers、judges、ops、children、models、白名单和其他字段。不要删整个文件或用最小示例覆盖它。同步补好 patch 的 `ownerSessions`，供将来首次播种使用。
4. 用 UTF-8 无 BOM 保存合法 JSON，冷启动宿主，在目标会话调用 `sa_whoami`，必须返回 `role=owner`；再用 `sa_agents` 核对其他角色未丢失。已有可用 owner 时优先让它调用 `sa_owner_add` 授权，无需编辑文件。

## 3. 卸载：先停用，再删链接

先停止相关任务与宿主，备份完整 stateDir 和 profile 配置，停用 patch 中对应的 insert，再执行卸载。**根 `uninstall.mjs` 没有 dry-run 模式，执行即删除链接**，不要用它试探安装状态。

在捆绑包根目录，二选一：

```powershell
node uninstall.mjs --profile "$profileDir"
```

```bash
node uninstall.mjs --profile "$profile_dir"
```

卸载器先检查全部 5 个目标（3 主名 + 2 别名）；任一是普通目录或文件，整次拒绝、exit 3，**任何链接都不删**。通过后只 unlink junction/符号链接，不删除其指向的包目录，也不删除 stateDir。遇真实目录应先识别来源并备份，不能为继续卸载直接递归删除。

单独内核包使用 `node scripts/uninstall.mjs --profile "$profileDir"`（PowerShell）或 `node scripts/uninstall.mjs --profile "$profile_dir"`（Bash），同样先停用对应 insert。五目标预检规则只指根目录捆绑卸载器；此副本未带单包脚本，单包卸载的具体预检行为**未验证**。卸载完成再冷启动，确认对应工具/面板入口已移除，数据备份保留。

## 4. 升级与反向回滚：解到新目录（包名可沿用），别原地覆盖

做法是**解到新目录、重建链接指向新目录、沿用同一个包名，然后重启**（安装器会先把旧链接改名 `.bak-bundle`）。**包名不变**是有意的：一台机器上只该有一个 active 版本，带版本号并挂会让宿主可能同时加载两份、两个工具集抢同一个 stateDir —— 维护者自己调试才这么干，交付给别人不要。另有两种做法要避开：①原地覆盖旧目录；②只在旧目录里改 `package.json` —— 目录没变、模块 URL 就没变，宿主导入的仍是旧模块（panel34 事故：插件入口整块消失）。以下为捆绑包操作；单包采用同样的停写、备份、停用 insert、卸旧链接、新目录安装、恢复 insert、冷启动顺序，使用对应单包脚本。

1. 确认没有在跑的工单/会话写入，停止宿主、watcher、hook 等相关写入方；记录旧包目录、profile、stateDir 和队列目录。
2. 把**完整 stateDir**（含 `owners.json`、`settings.json`、证据、归档、日志、commands）复制到独立备份；另存完整 patch、profile `package.json`、锁文件。若队列/handoff 在 stateDir 外，也单独备份，避免回滚游标与事件流不匹配。
3. 解包新版本到独立目录，核验交付 manifest。保留旧目录；备份并核对安装器将使用的 `.bak-bundle` 文件，存在冲突先保存到独立位置再处理。停用三条 insert。
4. 在**旧包根目录**运行卸载器，预检通过后移除 5 个旧链接；在**新包根目录**先运行安装计划，再 `--apply`。恢复已备份的三条 insert（或逐字段合并新模板）：包名没变就不用改 insert，保留 owner、路径和开关即可。只有你确实换了包名（维护者场景）才需要把 insert 的 `name` 一起改（目录名 / 链接名 / patch name 三处同名）。若 profile 记录了本地依赖，同时更新依赖目标并核对链接。
5. 冷启动；核对 32 个工具（含 `sa_steer`、`sa_compact`）、owner 权限、`sa_agents`、单量和证据，按需检查面板与桥。任一关键检查失败先停写再回滚。

切换命令（PowerShell，在每个包各自根目录执行；`$profileDir` 始终指同一个目标 profile）：

```powershell
# 旧包根目录；insert 已停用、宿主已停止
node uninstall.mjs --profile "$profileDir"
# 切到新包根目录后
node install.mjs --profile "$profileDir"
node install.mjs --profile "$profileDir" --apply
```

回滚反向执行：停止写入、保存新版本产生的数据，在新包根目录卸载链接，回旧包根目录重新计划并安装链接，恢复备份的 patch 与依赖文件。**只恢复 patch 无法把同名链接指回旧代码**。若新版本已写入不兼容数据，保留该数据副本后，用完整 stateDir 与外部队列备份恢复到配套快照；不可把旧数据覆盖进仍在运行的目录。冷启动旧版本，重新核对单量、角色、证据、工具与面板。

升级与回滚的目标宿主实操**未验证**，以上为依据安装器事实整理的顺序；每一步都要检查退出码和实际链接目标，失败后停止后续步骤。
