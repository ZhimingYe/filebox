# 工作区搜索

侧栏 **Search** 打开浮窗（桌面）或底部 sheet（手机），**不替换**主视图。可按文件名查找，或用正则搜文件内容。

![文件名搜索：REWIND → 5 hits](/screenshots/02b-search-results.png)

## 文件名搜索（Find）

1. 打开 Search，模式选 **Files**。
2. 选择 root 与子路径（`/` 表示整个 root）。
3. 输入名称片段（如 `REWIND`），点 **Search**。
4. 结果区显示 hits / scanned；可再 Filter results。
5. 用眼睛图标预览，或打开文件所在位置。

## 内容搜索（Content）

模式切到 **Content**，输入正则（如 `TODO|FIXME`）。命中会显示路径、行号与上下文，匹配词高亮。

![内容搜索 TODO\|FIXME](/screenshots/02c-search-content.png)

## Options（可选）

展开 Options 可设置：

- 扩展名过滤（逗号 / 空格分隔，不是 glob）
- 上下文行数（Content 模式）
- 最大深度
- 忽略的目录名（如 `node_modules`、`venv`、`renv`）

## 行为与限制

- 单 Agent 同时只跑一个搜索；可随时 **Cancel**。
- 大树请收窄路径、加忽略、限深度。
- 进度经 SSE 推送；关闭浮窗不会强制杀掉已在跑的请求（可用 Cancel）。
- 旧版 Agent 若不支持 `workspace_search` 能力，会提示 unsupported。

相关：[浏览文件](./browse) · [合集](./collections)
