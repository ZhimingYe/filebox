# 工作区搜索

在侧栏打开 **Search**。真实应用为浮窗 / 手机底部 sheet，**不打断**当前 Files 视图；演示页把 Search 做成独立主面板以便展示。

![Workspace Search](/screenshots/02-search.png)

## 模式

- **Files**：按文件名子串查找（类似 `fd`）。
- **Content**：内容正则（类似 `rg`，带上下文行）。

## 范围与限制

- 选定一个 root，可选子目录。
- 可按扩展名过滤；可忽略 `node_modules` / `venv` 等目录名；可限深度。
- 实时进度 + 取消；单 Agent 同时只跑一个搜索；有扫描 / 结果上限。
- 结果列表可再做客户端「过滤结果」框（不重新查 Agent）。

## 跳转

点击命中可跳到父目录；在 Explorer 下会 locate 到树节点。

大树请收窄 root、加深忽略目录、降低深度；卡住时随时 Cancel。更多见 [FAQ](/ops/faq)。
