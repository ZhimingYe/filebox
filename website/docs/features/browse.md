# 浏览文件

侧栏选中 Agent 后进入 **Files**：左侧 Agent 与导航，中间虚拟滚动文件列表，右侧（桌面）多标签预览。

![Files 根目录](/screenshots/01-files-browse.png)

## 界面结构

| 区域 | 内容 |
|------|------|
| 侧栏 Agents | 已连接机器、在线状态、延迟；点选切换当前 Agent |
| 侧栏 Workspace | Files / Explorer / Collections / Transfer / Terminal / Search / Settings / System |
| 根下拉 | 切换已启用的 root（如 `demo`） |
| 工具栏 | 刷新、过滤、排序、树面板、钉选、复制路径等 |
| 地址栏 / 面包屑 | 当前路径；支持粘贴路径与补全 |
| 文件列表 | 名称、修改时间、大小；类型徽章；最近修改高亮 |
| 预览栏 | 点击文件即预览；桌面[多标签](/features/tabs) |

![侧栏总览](/screenshots/00-sidebar-overview.png)

![figures 目录](/screenshots/01b-files-figures.png)

![reports 长文件名列表](/screenshots/01c-files-reports.png)

## 逐步操作

1. 选中 Agent → 点 **Files**。
2. 用根下拉选择已 Add 的 root。
3. 单击目录进入；点 `..` 或面包屑返回。
4. 单击文件：右侧打开预览标签（图片、PDF、代码、Markdown、CSV 等）。
5. 需要时可在工具栏打开目录树面板，或 **Pin** 当前文件夹到侧栏 Pinned。

## 常用技巧

- **过滤**：按文件名模式、修改时间过滤大目录。
- **排序**：点表头按名称 / 修改时间 / 大小排序。
- **位置记忆**：刷新后回到上次目录；Pin 可一键跳转。
- **下载**：预览栏 **Download**；浏览本身不改远端文件。
- **手机**：抽屉侧栏；列表与预览全屏切换。见 [首次登录 · 手机](/guide/first-login)。

## 与预览、Explorer 的关系

- 预览类型细节：[预览](./preview)
- 树形为主的浏览：[Explorer](./explorer)
- 还没根目录？先 [Add Root](/guide/first-login)
