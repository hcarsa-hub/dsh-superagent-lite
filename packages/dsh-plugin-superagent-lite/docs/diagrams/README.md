# 图表来源与复现（维护附录）

现行文档图为 system-radial 与 state-machine；architecture 与 architecture-radial 为历史存档，其中工具数、状态文案可能过期，不能用作补丁后行为依据。只改正文不自动重渲染存档；本次未修改图源或 PNG，尺寸与历史生成记录沿用原文，未重新验证。

| 文件 | 尺寸/字节 | 来源 |
|---|---|---|
| `system-radial.html` | 14,400B | Codex CLI + `gpt-6.1-sol`，手写内联 SVG（页面自带「导出 PNG（3×）」） |
| `system-radial.png` / `system-radial@3x.png` | 3360×2880 / **5040×4320** | 同上，Edge 无头 `Page.captureScreenshot` 渲染 |
| `state-machine.html` | 10,923B | 同上 |
| `state-machine.png` / `state-machine@3x.png` | 3360×2380 / **5040×3570** | 同上 |
| `architecture.html` / `architecture.png` | 833,731B / 285,451B | **Archify 3.2.0**（MIT, © 2026 tt-a1i）由 `architecture.candidate.json` 生成，四闸全 pass |
| `architecture.candidate.json` | 6,895B | Archify 的 JSON 源（可重渲染） |
| `architecture-radial.*` | 9,527B / 1,765,065B / 2,622,773B | 本项目手写 SVG（第一版尝试，已存档） |

## 重渲染 Archify 版

```powershell
$env:ARCHIFY_CHROME = '<your-edge-path>'
node "$env:USERPROFILE\.agents\skills\archify\bin\archify.mjs" finalize architecture `
  docs/diagrams/architecture.candidate.json docs/diagrams/architecture.html --quality showcase --json
```

Archify：https://github.com/tt-a1i/archify · MIT License · Copyright (c) 2026 tt-a1i (Archify)。本包只分发其**产物**，不包含其代码。

## 重渲染 Codex 版

两张图是单文件 HTML（内联 SVG + 少量 JS），双击打开即可；导出 3× 无损 PNG 用页面右上角按钮，或：

```powershell
$edge = '<your-edge-path>'
$uri = ([System.Uri]"docs/diagrams/system-radial.html").AbsoluteUri
& $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=3 `
  --window-size=1680,1440 "--screenshot=docs/diagrams/system-radial@3x.png" $uri
```
## 从内核 README 迁入的来源与复现说明

以下为历史生成与维护记录，不是安装前置步骤；本次文档工单未执行。Archify 版本兼容性、四道闸门的当前结果及适配包问题均未重新验证。维护者使用时读取自己的技能说明，在隔离副本中操作。

### Archify 引用说明

- 使用版本：**Archify 3.2.0**（skill 路径 `~/.agents/skills/archify`，与 Codex 共用同一份安装）。
- 上游：`https://github.com/tt-a1i/archify`，许可 **MIT License, Copyright (c) 2026 tt-a1i (Archify)**。
- 本包只分发它 **生成出来的产物**（`architecture.html` / `architecture.png` / `architecture.candidate.json`），**不包含也不依赖 Archify 的代码**；运行时不需要装 Archify。
- 重新渲染（在本包根目录执行，需 Node ≥ 18 与 Chromium/Edge）：

  ```powershell
  $env:ARCHIFY_CHROME = '<你的 Edge 或 Chromium 可执行文件>'  # Windows 通常在 Program Files (x86)\Microsoft\Edge\Application\ 下
  node "$env:USERPROFILE\.agents\skills\archify\bin\archify.mjs" finalize architecture `
    docs/diagrams/architecture.candidate.json docs/diagrams/architecture.html --quality showcase --json
  ```

  `finalize` 会依次跑 validate → deliver → check → browser-check 四道闸门，四项全 `pass` 才算成功（本包这份就是这样过的）。改了候选 JSON 后重跑要给新证据目录：加 `--out-dir review-2`。

- 两个坑（踩过）：① **不要装** `@tt-a1i/archify-dsh` 适配包（自带 3.0.1 会盖掉 3.2.0，还有让个人技能消失的已知 bug）；② 沙箱会拦子进程导致 `spawn EPERM`，必要时把这一条命令按完全放开权限跑一次。

> 为什么两代都留着：Codex 版视觉更好（现在 README 用这两张），Archify 版带引导视图 / 路径高亮适合交互讲解，所以作为存档保留、并可一键重渲染。

