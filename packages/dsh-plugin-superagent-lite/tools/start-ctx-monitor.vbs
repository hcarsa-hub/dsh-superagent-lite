' start-ctx-monitor.vbs — 后台启动 ctx-monitor（无窗口），目录用 %~dp0 定位，不写死任何绝对路径
' 用法：双击本文件，或用 `cscript //nologo start-ctx-monitor.vbs` 运行
' 停止：删掉 pid 文件对应的进程，或用面板「上下文监测」区的「停止」按钮

Option Explicit

Dim sh, fso, here, nodeExe, scriptPath, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 本脚本所在目录（含结尾反斜杠），用它拼路径 —— 包被放到哪都能跑
here = fso.GetParentFolderName(WScript.ScriptFullName) & "\"
scriptPath = here & "ctx-monitor.mjs"

' node 解释器：优先环境变量 DSH_CTX_NODE；否则用 PATH 里的 node
nodeExe = sh.ExpandEnvironmentStrings("%DSH_CTX_NODE%")
If nodeExe = "%DSH_CTX_NODE%" Or nodeExe = "" Then
  nodeExe = "node"
End If

If Not fso.FileExists(scriptPath) Then
  WScript.Echo "找不到脚本：" & scriptPath
  WScript.Quit 1
End If

sh.CurrentDirectory = here
cmd = """" & nodeExe & """ """ & scriptPath & """ --daemon"
' 0 = 隐藏窗口，False = 不等待
sh.Run cmd, 0, False
