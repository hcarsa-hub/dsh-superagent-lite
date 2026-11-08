# 与官方 superagent 的关系：定位与差异（事实对照）

> 本文用于对外说明「本项目是什么 / 不是什么」，避免把研究原型误读成官方产品，也避免反过来贬低它。
> 官方仓库：<https://github.com/deepseek-ai/dsh-superagent-prototype>（MIT）
> 本文结论基于**该仓库 README 的公开描述**（2026-11-09 读取），未阅读其源码；它的文档体系是 `000-philosophy / 001-domain / 002-authorization / 003-execution / 004-prompts / 005-panel / 006-deployment / 007-architecture / 008-cookbook`。

## 一、官方自己怎么说

其 README 首段原文要点：

- **"Research prototype for reference only, not an official DeepSeek product."** —— 研究原型，**不是**官方 DeepSeek 产品；
- "Treat it as research code, not production-ready software." —— 当研究代码看，不是生产级软件；
- 定位是 **"a proactive coding agent for one GitHub repository"**：监听 GitHub（可选飞书）→ 有人派活就开工作项 → 在**自己的会话与目录**里干 → 回到原对话交付（例如提 PR）→ 面板只展示「需要人看」的事。

## 二、本项目是什么

**DSH 里的一套轻量「工单编排层」**：把「派活 → 干 → 独立验收 → 收口」做成状态机 + 证据链 + 面板。

- 内核**零第三方依赖**，单文件 `index.js`（约 237 KB），**32 个 `sa_*` 工具**；
- 角色写进内核：`owner`（决策/派活/收口）· `worker`（执行交证据）· `judge`（独立验收）· `ops`；越权调用统一 `forbidden`；
- 工单状态机 `queued → running → ready → done`（前三态可进 `blocked`，`done` 为终态）；
- 证据链：`evidence/<id>/` + manifest + 缺件/孤儿检查（收口前要求 `orphan=0`）+ 逐文件 sha256；
- 双筛：worker `sa_report` 自报 → judge `sa_verdict` 判 → owner 机械核验后收口；
- 可选配套：面板（看板/表格+判词/归档/设置+诊断）、Codex 桥（Stop 钩子自动推 ready）、QQ ingress、上下文监测、`sa_steer` 中途插话（限 DSH 生态）。

## 三、逐项对照

| 维度 | 官方 superagent（研究原型） | 本项目（dsh-superagent-lite） |
|---|---|---|
| 触发方式 | GitHub / 飞书事件自动建工作项 | owner 手工建单（`sa_submit`），或 ingress 投外部事件 |
| 谁执行 | agent 自己认领并在独立会话/目录里干 | 派给**指定 worker 会话**（`sa_fanout` / `sa_run` / Codex 后端） |
| 交付形态 | 回到原对话（例如 PR/评论） | worker `sa_attach` + `sa_report`，**owner 收口** |
| 角色与授权 | 有（authorization 文档整章） | 有，且**硬编码进内核**（owner/worker/judge/ops + kind 标签） |
| 独立验收（双筛） | README 未描述 | **有**：judge 独立判词，owner 不得自判（工作流强制） |
| 证据与可审计 | 有工作项概念 | `evidence/` + manifest + orphan=0 + sha256 + 归档按纪元滚动 |
| 面板 | 有（只说「展示需要人看的事」） | 看板 / 表格+判词 / 归档 / 设置+诊断 |
| 中途改需求 | README 未描述 | **`sa_steer`**：running 插到下一步、idle 起新回合（**仅 DSH**，Codex 除外） |
| 扩展 Source | **有 Cookbook「加一个 Source」** | **没有**：只有通用 ingress，未抽象 Source |
| 自主性 | **主动型**：自己盯事件、自己开干 | **人类主导**：owner 决策，状态机强制流转 |
| 工程形态 | pnpm + 类型检查 + 测试 + 多篇设计文档 | 零依赖单文件内核 + 一包闸门（smoke/audit/isolate/simulate/name-audit） |
| 成熟度声明 | 作者自称研究代码、非生产级 | 本机 **234 张真实工单**全收口、包可装、公开 clone 可验 |

## 四、结论：怎么称呼彼此

- 本项目**不是**官方 superagent 的 lite 版、精简版、移植版或兼容实现，**也未与其产生运行时依赖**；
- 官方 README 已自行声明「research prototype / not an official product」，引用时**不要**写成「DeepSeek 官方 superagent」；
- 本项目对它的借鉴是**问题视角与角色分层**（agent 自己盯团队活、认领、交付可验收产物；决策/执行/验收三段式），**代码独立编写**；
- 如有读者问「能不能替代」：答**不能**——它偏「主动型 agent 自动干活」，本项目偏「人类决策下的工单编排与独立验收」，两者可互补。

## 五、对外可用的表述

> 受 DeepSeek 开源的 superagent 研究原型**启发**，独立实现的**轻量工单编排层**：把「派活 → 干 → 独立验收 → 收口」变成 DSH 里的状态机与证据链。

避免使用：「官方 lite 版」「精简版」「兼容实现」「移植」「DeepSeek 官方插件」。
