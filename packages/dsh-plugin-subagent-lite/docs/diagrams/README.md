# 图表来源与复现（docs/diagrams）

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
$env:ARCHIFY_CHROME = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node "$env:USERPROFILE\.agents\skills\archify\bin\archify.mjs" finalize architecture `
  docs/diagrams/architecture.candidate.json docs/diagrams/architecture.html --quality showcase --json
```

Archify：https://github.com/tt-a1i/archify · MIT License · Copyright (c) 2026 tt-a1i (Archify)。本包只分发其**产物**，不包含其代码。

## 重渲染 Codex 版

两张图是单文件 HTML（内联 SVG + 少量 JS），双击打开即可；导出 3× 无损 PNG 用页面右上角按钮，或：

```powershell
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$uri = ([System.Uri]"docs/diagrams/system-radial.html").AbsoluteUri
& $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=3 `
  --window-size=1680,1440 "--screenshot=docs/diagrams/system-radial@3x.png" $uri
```