# NOTICE —— 外部项目引用与致谢

本仓库（`dsh-superagent-lite` 系列插件）在设计上参考了下列开源项目。**代码为独立编写，未复制下列项目源码**；若将来引入其代码，将在此文件按文件/许可逐项标注。

## 1. DeepSeek Super-Agent（`dsh-superagent-prototype`）

- 仓库：https://github.com/deepseek-ai/dsh-superagent-prototype
- 项目描述：Towards a More Autonomous Agent System（DeepSeek 官方开源的 super-agent 原型）
- 我们借用了什么：
  - **问题视角**：让 agent 自己盯团队消息/工单、认领工作、交付可验收的产物，而不是等人一件件派；
  - **角色分层**：决策（owner）/ 执行（worker）/ 独立验收（judge）三段式；
  - **证据优先**：产物与判词落盘、可追溯。
- 我们没有采用什么：不复制其代码、不实现其子代理运行时、不绑定其模型或通信层。
- 本项目的差异：轻量实现 —— 只做「工单状态机 + 派活 + 双筛 + 证据链」，以 DSH 插件形式提供 31 个 `sa_*` 工具，执行体完全由宿主（`schedule` / `subagents` / 会话）提供。

## 2. Archify（图表渲染，仅用于生成文档图）

- 仓库：https://github.com/tt-a1i/archify ｜ 许可：MIT License, Copyright (c) 2026 tt-a1i (Archify)
- 用途：`handoff/dist/dsh-plugin-subagent-lite/docs/diagrams/architecture.*` 这套图及其候选 JSON 由 Archify 3.2.0 生成。
- 说明：本仓库只分发**生成产物**（HTML/PNG/候选 JSON），不包含也不依赖 Archify 代码。

## 3. 第三方商标

文中出现的 DeepSeek、DSH、Codex、QQ、NapCat 等名称，仅用于说明兼容性与接入方式，商标归各自所有者；不代表背书或合作。
