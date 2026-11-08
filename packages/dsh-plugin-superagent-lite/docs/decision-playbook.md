# 决策手册 · 派单判断、验收判据与异常恢复

> **读者**：已按 [快速开始](getting-started.md) 跑过首单的**操作者 / 决策者（owner）**；本文用于判断与排障，不另设一条首单教程。
> **这不是 API 文档**，是一个决策者在真实返工里攒下来的操作顺序 —— 每一步写清三件事：**你该判断什么、看什么证据、这一步断了怎么办**。
> 本文只写「怎么用」，不写维护者的打包与分发动作；可选配套只在 §11 一行带过，没装就当它不存在。
> 与实测冲突时**以实测为准**，别为了迎合文档去做错事。

本文 `sa_*` 示例均为**在 DSH 会话中请求调用工具**，工具名后统一给 JSON 参数，不是 PowerShell 命令。首次安装、owner 授权恢复和升级命令见 [安装操作](install-operations.md)。

## 0. 先看这张图

```
建单 ─▶ 选人 ─▶ 写 brief ─▶ 派 ─▶ 盯 ─▶ 收活 ─▶ 判 ─▶ 收口 ─▶ 归档 ─▶ 下一张
  ▲                                                                      │
  └──────────── 失败分支：返工 / 重派 / 放弃 / 拆单 ◀────────────────────┘
```

十步里：**七步由你拍板**（建单、选人、brief、派、盯、收口、下一张），两步交出去（worker 干活、judge 判定），一步是机器强制（状态迁移）。

三处最容易断，先记住：

| 断点 | 症状 | 代价 |
|---|---|---|
| brief 缺判据 | worker「交了几组验几组」 | 假绿，判了等于没判 |
| 交活漏 `final: true` | 单子停在 running，judge 永远收不到 | 卡一整晚 |
| 收口前没查孤儿 | 产物在磁盘上、没进清单 | 判词只能靠 judge 外部取证 |

## 1. 你是谁：owner 的四件事、三条禁止

| 你该做 | 你不该做 |
|---|---|
| 建单、写 brief、选人、派活 | ❌ 替 worker 写活（你写了就没人能独立验） |
| 机械验证：跑命令、看退出码、核字节 | ❌ 做质量判定（那是 judge 的活） |
| 收口：`sa_evidence` 确认 `orphan=0` 再 `done` | ❌ 把「我自己跑通了」当成通过理由 |
| 拍板：要不要重启、要不要放弃、要不要拆单 | ❌ 为了赶进度跳过 judge |

> 一句话：**worker 做、judge 判、owner 收**。三者合并的那一刻，这套框架就退化成「AI 自己说好就上线」。

**收口前的固定问句**：这张单的 `verdict.pass` 在哪？拿不出来就不许 `done`。

## 2. 闭环十步：每一步的判断、证据、断点

### 2.1 建单

**你判断**：这活要不要建单？
- 有交付物、要别人验 → **建**
- 自己 5 分钟能做完、不需要第二个人看 → **不建**（建了反而多一次判定成本）

```text
sa_submit {"title":"<一句话说清交付物>","type":"code","priority":5,"auto":false}
```

- `type`：`code` / `test` / `office` / `doc`（影响自动派单能否命中，也影响 judge 判据粗细）
- **必须显式给 `type`，别指望标题推断**：推断只在标题含明确词时命中，实战多数落到 `undefined`，面板就显示「未标」。另注：面板类型标签目前只有 测试/代码/办公，`doc` 会显示「未标」（面板待补标签，见 PENDING）；文档类活想在图里好看，可先用 `office`。
- `auto=false`：**不参与自动派单，必须你手工派**（忘了派 = 单子永远 queued）
- `auto:true`：允许自动派单，**省略也默认 true**；实际派单还需全局 `autoDispatch:true` 与已登记、`kind` 匹配且可接单的 worker，单传 true 不保证派出

**断点**：单子建了没人管。查 `sa_list`，若是 `queued` 且 `auto=false` → 手工 `sa_fanout`。

### 2.2 选人

**你判断的顺序**（按这个顺序想，别跳）：

1. **能力对不对**：`sa_agents` 看 `[kind]` 标签；`kind=code` 的人不接 `office` 活
2. **人闲不闲**：正在跑长任务的别塞第二张（会互相抢文件）
3. **档位够不够**：判对错/写分析要高思考档；照说明书执行用最便宜的
4. **贵不贵**：按次计费的通道，别拿它跑机械活

| 活的性质 | 派给谁 |
|---|---|
| 照说明书执行（装、跑、抄配置） | 团队里最便宜的 worker |
| 判对错、查资料、写分析 | 中高档思考模型 |
| 多文件改造、要一次成型 | 最熟悉代码、上下文扛得住的 worker |
| 机械切片 / 注释 / 批量替换 | 便宜且听话的 worker |
| 端到端验证、产出图片或文件 | 工具齐全、能真机跑的那台 |

**断点**：`kind` 没有匹配的人 → 自动派单不派、只提醒你，必须手工指定。

### 2.3 写 brief（六件套，缺一即返工）

```markdown
【工单 <id>】<一句话目标>

⏱ 时间盒 <N> 分钟；每 5 分钟请求调用 `sa_progress {"id":"<id>","note":"<进展>"}`

要做什么（逐条，带判据）：
1. ...（产物格式、尺寸、字段、阈值）
2. ...

交付（必须）：
- 产物放 `<绝对目录>`，文件名 `<规则>`
- `sa_attach` 到 `<id>`（绝对路径）
- 请求调用 `sa_report {"id":"<id>","summary":"结论+证据路径+未验项","final":true}` ← `final` 不能漏

证据要求：命令原文 + 退出码 + 文件字节 / 像素尺寸；没跑过的写「未验」

红线：不装东西、不改宿主配置、不重启、不碰私密区；遇到坑先查团队的已知问题库
```

**你判断**：**判据由你写死**（组数、字段、阈值、尺寸）。worker 只负责达标，不许自己改分母。
**反例**：worker 把「5 组完整性检查」改成 `cases===3`，照样打印 ALL PASS。
**自检**：brief 里有没有「必须检查 X 组、缺一即 fail」？没有就补上再派。

### 2.4 派

```text
sa_fanout {"id":"<id>","sessionIds":["<worker-session-id>"],"brief":"<六件套>"}
```

| 形态 | 用什么 | 注意 |
|---|---|---|
| 派给已登记的会话 | `sa_fanout`（可多人） | 多人时产物**分目录**写，否则互相覆盖 |
| 只要一条消息、不建 assignee | `sa_tell` | 适合提醒/叫停，不适合当正式派活 |
| 临时子会话（一次性） | `sa_run` + provider/model | 子会话拿不到你的上下文，brief 要自包含 |

**你判断**：这一张要不要拆？预计超过 25 分钟、或要同时取证两个方向 → 拆单或并行，别让一张单拖着。

**断点**：手工 `sa_fanout` 通知失败可能返回 `FAIL->...`，但不会自动撤销已登记的派单状态。先核对投递结果、`sa_list` 的状态/指派和 worker 实际接收情况，再按状态恢复或重派；不要直接重复派单。自动派单的恢复策略不能套用到手工路径。

### 2.5 盯（这一步最容易被忽略）

| 你要看 | 在哪看 | 判据 |
|---|---|---|
| 单子还在动吗 | `sa_list` 的「距上次变更」 | 超过 15 分钟没动 → 查 |
| worker 有没有心跳 | `sa_requirements` / 工单 progress | 长任务应有 5 分钟一条 |
| 是不是误杀 | 日志里 `dispatch-stale` / `timeout` | 有就重派，别怪 worker |

**纠偏：正在跑的会话怎么插话**

| 情况 | 用什么 | 效果 |
|---|---|---|
| 目标**正在跑**，要加约束/改方向 | owner 调 `sa_steer {"sessionId":"<sid>","text":"<约束>","mode":"auto"}` | `running` → 插到**下一步**；`idle/unknown` → 新回合 |
| 目标空闲，只是派新活 | `sa_tell` / `sa_fanout` | 排新回合 |
| 要它立刻停 | 使用目标宿主 UI 的停止入口，确认停止后再发新指令 | UI 具体入口未验证；本包不注册停止工具，插话不等于中断 |

> `sa_steer` **仅 owner**，参数只有 `sessionId` / `text` / `mode`（`auto|steer|followup`），schema 与 execute 双重校验；通过宿主 `typert.lookups.get('agent').resolve(sessionId)` 找 Agent，**await 投递结果**，同步/异步失败均返回 `{ok:false}`。auto 下 running 走 steer，idle/unknown 走 followup；返回 followup 不能据此断言目标一定空闲。它不写账本或工单状态，**不支持 Codex 执行体**，也不能确认目标已执行完新要求。

**断点**：单子卡住先查三处 —— ① `sa_list` 状态与停留时长；② 日志最后一条相关事件；③ 是不是 `auto=false` 没人派。

### 2.6 收活（worker 侧动作，但你要在 brief 里写死）

```text
sa_progress {"id":"<id>","note":"<这一轮在做什么>"}
sa_attach {"id":"<id>","sourcePath":"<允许根内的产物绝对路径>"}
sa_report {"id":"<id>","summary":"<结论+证据+未验项>","final":true}
```

长任务每 5 分钟心跳。首次附加项目产物前显式配置 `attachRoots`，默认根不包含任意项目目录，敏感路径始终拒绝。

**你判断**：worker 报「做完了」不算完，看 `sa_evidence` 的清单里有没有主产物。

### 2.7 判（交给 judge，但判据是你的责任）

```text
sa_judge {"id":"<id>","judgeSessionId":"<judge-id>","criteria":"<你写的判据>"}
sa_verdict {"id":"<id>","pass":true,"reason":"<逐条核了什么、没核什么>"}
```

第一条由 owner 调用，第二条由独立 judge 调用；失败改为 `"pass":false`。未启用 `autoJudge` 时必须手工送审，登记 judge 本身不会叫醒它；已自动指派则先核对，避免重复送审。

**judge 的四个必 fail 项**：

| 症状 | 判 |
|---|---|
| 报告自相矛盾（结论说通过、数据说失败） | fail |
| 关键结论无证据（只写「已验证」不给命令/输出） | fail |
| 过度承诺（「一定能」「100% 兼容」） | fail |
| 自己列了「未验」项但没写影响 | fail（要他写清哪些结论因此不成立） |

**你判断**：判词有没有写「亲验 / 采信 / 未验 / 修法」四段？只写 pass 不给亲验过程的，打回重判。

### 2.8 收口

```text
sa_evidence {"id":"<id>"}
sa_advance {"id":"<id>","to":"done","reason":"judge pass + 我核了什么"}
```

**顺序不能反**：先 `sa_evidence` 再 `done`。反过来就会出现「单子 done 了，主报告还躺在磁盘上没进清单」—— 等于判了个寂寞。

**断点**：`orphan>0` → 先 `sa_attach` 补登，再 `done`。

### 2.9 归档

```text
sa_archive {"dryRun":true}
sa_archive {"keep":50}
```

先看归档计划，再执行保留最近 50 张的操作；这里的 `dryRun` 是归档工具参数，与没有 dry-run 的捆绑卸载器无关。

归档只作用于**已收口**的单（done / blocked）；归档文件在 `<stateDir>/archive/`，历史清单仍可读。

### 2.10 下一张

| 场景 | 节奏 |
|---|---|
| 单张复杂 | 一次一张，brief 写全 |
| 多张同类 | **先做一张验证 brief 有效**，再批量扇出（批量错 = 全错） |
| 链式（研究 → 归纳 → 终审） | **上一张出结果再建下一张**；一次建 4 张会让后面的在队列里等到告警 |
| 并行取证 | 派给两个会话，产物分目录 |

## 3. 状态机与工具地图

### 3.1 合法迁移（内核强制）

```
queued ─▶ running ─▶ ready ─▶ done
  │          │          │
  └──────────┴──────────┴─▶ blocked（queued/running/ready 可进）
blocked ─▶ queued（返工） / done（放弃）
```

- **`queued → done` 会被拒**：必须走完 ready
- `done` 是终态，`NEXT.done=[]`；正常收口是 judge pass 后由 owner 推 done，judge 不直接收口
- `ready → blocked` 是 judge 判 fail 的落点；`blocked → queued` 是返工，会清掉旧 judge 指派与旧判词，下一轮重新送审
- 追加需求只对 `queued` / `running` 有效；单已 `ready` / `done` → **开新单**

### 3.2 工具分组（32 个）

32 是 FACTS 确认的注册数，内核 README 用途表按工具名去重也为 32。下表用于定位操作主题；除 FACTS 明确确认的参数外，全部 schema 与目标宿主运行结果未现场验证，见 [内核 README](../README.md)。

| 组 | 工具 | 什么时候用 |
|---|---|---|
| 建单 | `sa_submit` | 有活要派 |
| 派活 | `sa_fanout` / `sa_tell` / `sa_run` / `sa_delegate_codex` | 见 §2.4；Codex 后端要配 Stop 钩子才算闭环 |
| 纠偏 | `sa_steer` | 目标正在跑时要插话（见 §2.5） |
| 推进 | `sa_advance` | 仅 owner；judge 通过 `sa_verdict` 下判词 |
| 交活 | `sa_report` / `sa_attach` / `sa_progress` | worker 三件套 |
| 验收 | `sa_judge` / `sa_verdict` / `sa_evidence` / `sa_requirements` | judge 与收口 |
| 运维 | `sa_status` / `sa_list` / `sa_next` / `sa_stats` / `sa_watchdog` / `sa_archive` / `sa_transfer` / `sa_escalate` / `sa_ingress` / `sa_compact` / `sa_new_session` / `sa_owners` / `sa_owner_add` / `sa_owner_remove` / `sa_role` / `sa_agents` / `sa_sendback` / `sa_whoami` | 排障、统计、换归属、压缩上下文 |

### 3.3 两条最容易踩的语义

1. **`sa_report` 不传 `final: true` 不会推进状态**：只传 summary = 记一条自报、单子停在 running、judge 永远收不到。
2. **`sa_advance` 进 ready 会自动送审**（配了 `autoJudge` 时）：手工补推进 = 顺手把验收也发出去了。

## 4. 十一根决策原则

每条：**规则 → 为什么 → 反例 → 自检**。

### 4.1 没报错 ≠ 成功
- **规则**：任何「写完 / 跑完」都要外部证据：字节、行数、退出码、文件存在、图的实际像素。
- **为什么**：静默失败太多 —— 大文件被截断、BOM 让配置静默失效、插件入口消失，都不报错。
- **反例**：改 115KB 的文件用「读全文→改→写」，实际只读到 51KB，写回后白屏。
- **自检**：`Get-Item <file> | Select Length`、`node --check`、退出码、读图片头看宽高。

### 4.2 先查已知问题库，再动手
- **规则**：报错先查团队的已知问题库（速查卡 / 历史工单 / 坑位清单），命中就照它做；没有就自己记一条。
- **自检**：同一症状按库里写法做**两次**仍不对 → 停，标「质疑中」，别第三次照旧。

### 4.3 行号、字节、版本号必须现取
- **规则**：报告里的每个 `文件:行号`、字节数、版本号，都当场从文件取。
- **反例**：一份研究 22 处行号全是估的（写 L27 实际 L31），judge 全查出来 → fail 重做。
- **自检**：`grep -n` 现取；版本号读 `package.json`。

### 4.4 证据留痕，孤儿归零
- **规则**：产物一律 `sa_attach` 登记；收口前 `sa_evidence` 必须 `orphan=0`。
- **自检**：清单条目与磁盘条目一致，没有「孤儿」。

### 4.5 判据不许由交付方定
- **规则**：验收标准由你在 brief 里写死；worker 只负责达标。
- **自检**：brief 里有没有「必须检查 X 组、缺一即 fail」。

### 4.6 关键断言要有负向对照
- **规则**：重要的「通过」至少做一次「故意破坏 → 必须 FAIL」。
- **自检**：删一条断言 / 改坏一个字段，测试应立刻红；不红说明断言是摆设。

### 4.7 长任务必须心跳
- **规则**：预计 >15 分钟的活，brief 写「时间盒 + 每 5 分钟 `sa_progress`」。
- **为什么**：超时依赖运行配置中的 `runningTimeoutMs`、巡检周期及连续无变更次数。当前副本的历史文档默认值互相冲突，FACTS 未确认这些数值，固定分钟数**未验证**；按实际配置判断，避免长任务缺心跳被误判。
- **反例**：一个单连跑 20 分钟没心跳被误杀，重派 + 复核多花 15 分钟。

### 4.8 交活带 `final: true`
- **反例**：两张单只传 summary，停在 running 一整晚，judge 从没收到。

### 4.9 发现卡单先查三处
1. `sa_list`：状态与停留时长
2. 日志：最后一条相关事件（有无 `judge-assign` / `auto-rework` / `dispatch-stale`）
3. 是否 `auto=false` 没人派

### 4.10 不要把「旧结论」当现态
- **规则**：版本 / 单量 / 字节 / 配置状态，一律现查；**被压缩过的会话摘要不可信**。
- **自检**：`sa_status`、`sa_agents`、文件字节、配置文件里的版本号。

### 4.11 涉及重启的事，先说清再动
- **规则**：重启是**用户决策**。要重启才生效的，先写清「加载哪些未验收代码 / 会切断哪些在跑回合 / 哪些常驻进程会死」。
- **自检**：能不能用热加载替代？先看日志，再问用户。

## 5. 派单的四种形态

| 形态 | 做法 | 适用 |
|---|---|---|
| 单张 | 一张一 brief，等结果 | 复杂、要一次做对 |
| 批量同类 | 先做一张验证 brief，再扇出 | 机械化、任务同构 |
| 链式 | 上一张出结果再建下一张 | 研究 → 归纳 → 终审 |
| 并行取证 | 两个会话、产物分目录 | 两个方向互相独立 |

### 5.1 返工与重派
- judge 判 fail → 先 blocked；后续是否自动 `blocked → queued` 取决于返工策略和次数上限，本副本的默认上限未验证，查看实际状态/history 后决定是否手工重派
- 重派前先看 `blockedReason`：judge 写清了「缺什么」，照着补齐，别重做一遍
- 原 worker 还在跑（比如被 timeout 误杀）→ **先让它停手**，再派给别人，否则两个 agent 写同一目录会互相覆盖

### 5.2 并发
- `concurrency.maxConcurrent` 单机建议 1–2；超出直接拒绝而不是排队
- 并行时**禁止两个 worker 写同一文件/目录**

## 6. 验收：别全信报告

1. 从报告里挑 **1–3 处关键数字**自己重取（字节、行号、图尺寸、接口返回）
2. 跑报告里**最容易假绿**的那条断言（通常是「全部通过」那组）
3. 检查产物**真的存在且非空**（`sa_evidence` 清单 vs 磁盘）

**判词格式（judge 照这个写）**：

```
【结论】pass / fail
【亲验】我自己跑/读了什么（命令 + 关键输出）
【采信】哪些内容我认可但没亲验（说明为什么可以采信）
【未验】哪些没验、影响什么结论
【修法】fail 时必须逐条写「改成什么」
```

**负向校准（每周一次）**：投一份**已知该 fail** 的样本（删一组断言、把完整性检查降级），不告诉 judge 它是校准样本。判 pass 说明判据失效，立刻收紧。

## 7. 收口与归档

```text
sa_evidence {"id":"<id>"}
sa_advance {"id":"<id>","to":"done","reason":"judge pass + 我核了什么"}
sa_archive {"keep":50}
```

- 归档只作用于已收口的单；归档后历史清单仍可读
- 收口前再问一遍：**verdict 在哪？orphan 是几？**

## 8. 事故库（症状 → 根因 → 做法）

| 症状 | 根因 | 做法 |
|---|---|---|
| 页面白屏 / 语法错 | 大文件被静默截断后整体写回 | 备份 → 定点替换 → 核字节 → `node --check` → 才重启 |
| 所有工具消失 | 先改 patch 后建 junction，宿主导入失败 | **先 junction → 验证 resolve → 才改 patch** |
| 插件入口消失 / 改码不生效 | 包名、export name、loader id、patch name 不一致 / 双 active / 缓存 | 保持标识一致 + 单 active + **换新目录 + 沿用原包名 + 重启**；**别在原目录覆盖或只改 `package.json`**（模块 URL 没变 → 宿主还是导入旧模块），也别为了「方便回滚」把多个版本并挂，见 §9 |
| 工具在、面板没有 | 链接目标或 active patch 不正确 | 核对链接和 patch；保留旧解包目录，按 §9 反向切回 |
| 交活了 judge 收不到 | `sa_report` 漏 `final: true` | 补 `final`，或 owner 手工 `sa_advance ready` |
| 单子卡 queued 不动 | 未手工派 / 全局自动派单关 / 单 auto:false / 无匹配 worker | 核对三个自动条件，或手工 `sa_fanout` |
| 判 fail 后第二轮不再送审 | 旧 judge 指派未清（旧版本 bug） | 升级到含「回修清 judge」的版本；临时 `sa_judge` 手动重投 |
| 收假提醒 / 队列污染 | 测试脚本写了生产队列 | 测试用临时目录，并断言生产文件 size/mtime 未变 |
| 全绿但删逻辑仍全绿 | 没有负向对照 | 关键断言做一次「故意破坏必 FAIL」 |
| 判 fail：行号全错 | 行号凭记忆 | `grep -n` 现取；对不上即不通过 |
| 改错文件 / 改到旧副本 | 把会话摘要当现态 | 只信实测：先确认路径与 mtime，再动手 |
| 代码上线却未判 | 跳过 judge / 证据漏挂成孤儿 | `sa_evidence` 到 `orphan=0`，再问「verdict 在哪」 |
| 需求没进验收 | 给 ready/done 的单追加需求 | 已 ready/done 一律开新单 |

### 8.1 新 AI 最容易犯的 5 个错

1. 拿「没报错」当成功 —— 截断、BOM、入口消失都不报错。
2. 凭记忆写数：行号、字节、文件数、版本、工具数。
3. 自己定判据分母：「交了几组验几组」= 假绿。
4. 顺序反着来：先改 patch 后建 junction、先 done 后取证。
5. 不查已知问题库、不信实测，把旧结论当现态。

## 9. 换版本与回滚

> 这一节只讲**换版本时别丢账本、坏了怎么退**。

### 9.1 换之前备份三样

| 备份什么 | 位置 | 为什么 |
|---|---|---|
| 完整数据目录 | 整个 `<stateDir>` | 账本、证据、归档、owners、settings、commands 等必须一起保留 |
| 宿主配置 | profile patch、package.json、锁文件 | 恢复授权配置、挂载和依赖目标 |
| 外部通路及旧包 | stateDir 外的队列/handoff 与旧解包目录 | 恢复游标配套事件流，并能把同名链接切回旧代码 |

```powershell
$backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath '<stateDir>' -Destination "<独立备份目录>/state-$backupStamp" -Recurse
```

### 9.2 换挂姿势：**换新目录 + 沿用原包名 + 重启**

| 做法 | 结论 |
|---|---|
| **换新目录，包名不变，冷启动** | ✅ **推荐，也应该是唯一做法**：安装器按固定 name 重建链接（旧链接先改名 `.bak-bundle`），patch 的 name/id 都不用动；机器上始终只有**一个** active 版本 |
| 换新目录但把包名带版本号 | ⚠️ 只给维护者在本机调试用：同一台机器会出现两个可解析的包，宿主可能同时加载、两条 insert 抢同一个 stateDir；**给别人的机器装东西时不要这么干**（新手装完会多出一堆包，出问题也没人看得懂） |
| 原地覆盖 / 只在旧目录改 `package.json` | ❌ 禁止：目录没变 → 模块 URL 没变 → 宿主导入的还是旧模块（panel34 事故：插件入口整块消失），旧版本还没退路 |

> **为什么坚持同包名**：这套东西在一台机器上只该有**一个** active 版本。带版本号并挂等于同时装两份，工具集重复注册、数据目录可能被两个版本交替写 —— 你自己排障还行，交给别人就是事故。

**顺序不能反**：`① 停写 + 备份 stateDir 与 patch → ② 解包到新目录并核 manifest → ③ 建链接指向新目录（同名）→ ④ 验证 resolve/import → ⑤ patch 基本不用改（只有你换了包名才要三处一起改）→ ⑥ 重启`。反过来会让宿主先卸载旧插件、再导入失败，**所有工具消失**。

### 9.3 版本号怎么看

- 内核与捆绑包是**两条版本线**（内核装进捆绑包里），别拿一个数对另一个数
- 换完确认三件事：`sa_status` 能出数、工具数没变少、`sa_agents` 里的人还在

### 9.4 回滚（按 §9.2 推荐姿势装的）

1. 停止写入：确认没有 running 的单、没有会话正在调 `sa_*`（有就等它收尾或先打断）
2. patch 里把**新块整段注释掉、旧块取消注释**（旧块一直留着，只动注释）
3. 冷启动宿主
4. 核对：`sa_status` 单量对得上、工具数没变少、`sa_agents` 里的人还在
5. 若用了原地覆盖（没有旧块可回）：用 §9.1 的 `<stateDir>.bak-<ts>` 只能救**数据**，代码要重新解旧版包

> 回滚**不要删**旧目录、不要删旧 junction —— 它就是你的退路；确认新版本稳定跑几天后再清。

## 10. 配置键与命令速查

### 10.1 配置键

| 键 | 作用 | 建议 |
|---|---|---|
| `stateDir` | 账本/证据/归档根目录 | 显式写，别全靠默认 |
| `autoJudge` | `true`=用 `roles.judges` 并轮换；写具体 id=固定那个 judge | 有 2 个 judge 时用 `true` |
| `judgeRotate` | `autoJudge:true` 时是否轮换 | 开，避免全堆一个 judge |
| `notifyReadyTo` | ready 时提醒谁（judge/owner/both） | 用 `judge` |
| `notifyEvents.verdictPass` | judge 通过是否提醒 owner | 嫌吵可关，但要看板兜底 |
| `watchdogAlerts` | watchdog 是否发告警 | 单机自用可关，手动巡检 |
| `dispatchStaleMin` | queued 多久算「没派活」 | 链式排队调大（如 40） |
| `runningTimeoutMs` / `staleMisses` | 多久无进展判 timeout | 固定默认数值未验证，先核对运行配置与心跳，再调整 |
| `concurrency.maxConcurrent` | 同时跑几张 | 单机 1–2 |

### 10.2 命令速查

| 我要… | 命令 |
|---|---|
| 看团队 | `sa_agents` |
| 看总量 | `sa_status` |
| 看待办 | `sa_next {}` / `sa_list {"limit":10}` |
| 派活 | `sa_fanout {"id":"<id>","sessionIds":["<sid>"],"brief":"<...>"}` |
| 插话（仅 owner，DSH Agent） | `sa_steer {"sessionId":"<sid>","text":"<...>","mode":"auto"}` |
| 看证据 | `sa_evidence {"id":"<id>"}` |
| 交活 | `sa_report {"id":"<id>","summary":"<...>","final":true}` |
| 心跳 | `sa_progress {"id":"<id>","note":"<...>"}` |
| 判 | `sa_verdict {"id":"<id>","pass":true,"reason":"<...>"}`（失败用 false） |
| 收口 | `sa_advance {"id":"<id>","to":"done","reason":"<...>"}` |
| 巡检 | `sa_watchdog` |
| 归档 | `sa_archive {"keep":50}` |

## 11. 附注：可选配套与开发期经验（不装 / 不用均不影响主流程）

三插件捆绑包包含内核 + 面板 + watcher，`sa_steer` 插话已并入内核，**没有第四个插话插件**。主流程不依赖额外配套；Codex 桥、QQ 通道、免费模型 provider、第三方设计/办公插件均属选装，按需接入即可。清单与接法见 [companions.md](companions.md)。

**开发期经验（可选读，使用者可忽略）**：一次只改一类东西 —— 布局 / 结构 / 换版本别混在同一版，先验证入口还在再加下一类。这条来自改插件时的真实返工，**不针对日常派活**，用不上就不用。

## 12. 相关文档

- 安装与第一次跑通：[`getting-started.md`](./getting-started.md)
- 状态机与卡点全解：[`loop.md`](./loop.md)
- 团队规模与命名：[`team-layout.md`](./team-layout.md)
- 角色提示词：[`prompts/owner.md`](./prompts/owner.md) · [`prompts/worker.md`](./prompts/worker.md) · [`prompts/judge.md`](./prompts/judge.md) · [`prompts/tester.md`](./prompts/tester.md)
- 配置总表：[`config.md`](./config.md) · 模型路由：[`models.md`](./models.md) · 依赖：[`dependencies.md`](./dependencies.md)
- 已知限制：[`known-limitations.md`](./known-limitations.md)

> 发现这份文档写错了：**以实测为准**，把差异反馈给维护者，别为了迎合文档去做错事。
