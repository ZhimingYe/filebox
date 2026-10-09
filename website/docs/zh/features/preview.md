# 预览

点击文件即可在工作区内预览，无需先下载到笔记本。桌面为[多标签工作区](/zh/features/tabs)；手机上预览全屏切换。

## 图片

缩放、平移；工具条可调缩放比例。

![图片预览 plot.png](/screenshots/08-preview-image.png)

## Markdown / 文本

Markdown 渲染；纯文本与代码走语法高亮编辑器（只读：查找、换行）。

![Markdown 预览](/screenshots/08b-preview-markdown.png)

![代码预览 hello.py](/screenshots/08c-preview-code.png)

## PDF

内置 PDF 查看器，支持 Adaptive / 百分比缩放（50%–200%），多页连续滚动。演示数据里的 `demo-report.pdf` 为 6 页合成实验报告（表格、多面板图、相关性热图、公式），便于看出预览效果。

![PDF 预览](/screenshots/08d-preview-pdf.png)

## CSV / TSV

表格渲染，显示行列数与分隔符；可切换 Raw / Copy。

![CSV 预览](/screenshots/08e-preview-csv.png)

## Office（可选）

Word / PowerPoint 经 Agent 上 LibreOffice 转为 PDF 后预览；表格导出为每 sheet 一份 CSV。需配置 `FILEBOX_AGENT_SOFFICE`，见 [Office 预览](/zh/ops/office)。

![PowerPoint → PDF 预览](/screenshots/08f-preview-office.png)

Settings 里有 **Office preview** 开关（浏览器本地偏好，默认开）。

## 支持类型一览

| 类型 | 行为 |
|------|------|
| 图片 | 缩放平移（含 TIFF） |
| PDF | 内置查看器 |
| Markdown | 渲染 |
| 代码 / 文本 / 日志 | Monaco 只读 |
| Quarto / R Markdown（`.qmd` / `.rmd`） | Monaco 源码视图 |
| HTML | 沙箱会话 |
| Jupyter 笔记本（`.ipynb`） | Hub 清洗为 HTML，走同一沙箱会话（只读；中等 png/jpeg 轻度重压缩；过大省略） |
| CSV / TSV | 表格 |
| Word / PPT | 可选：Agent 侧 → PDF |
| Excel / ODS | 可选：每 sheet → CSV |

## 提示

- 桌面多标签：同时打开多个文件、切换、固定、批量关闭，`Esc` 关闭当前标签、`←` / `→` 切同目录上一个 / 下一个文件。详见 [多标签预览](/zh/features/tabs)。
- 过大文件会先询问，避免拖死浏览器。
- 预览栏可直接 **Download**。
- 无 `soffice` 时 Office 仍可下载，预览入口不可用。
