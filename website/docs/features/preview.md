# 预览

点击文件即可在工作区内预览，无需先下载到笔记本。桌面为多标签工作区；手机上预览全屏切换。

## 图片

缩放、平移；工具条可调缩放比例。

![图片预览 plot.png](/screenshots/08-preview-image.png)

## Markdown / 文本

Markdown 渲染；纯文本与代码走语法高亮编辑器（只读：查找、换行）。

![Markdown 预览](/screenshots/08b-preview-markdown.png)

![代码预览 hello.py](/screenshots/08c-preview-code.png)

## PDF

内置 PDF 查看器，支持 Adaptive / 百分比缩放。

![PDF 预览](/screenshots/08d-preview-pdf.png)

## CSV / TSV

表格渲染，显示行列数与分隔符；可切换 Raw / Copy。

![CSV 预览](/screenshots/08e-preview-csv.png)

## Office（可选）

Word / PowerPoint 经 Agent 上 LibreOffice 转为 PDF 后预览；表格导出为每 sheet 一份 CSV。需配置 `FILEBOX_AGENT_SOFFICE`，见 [Office 预览](/ops/office)。

![PowerPoint → PDF 预览](/screenshots/08f-preview-office.png)

Settings 里有 **Office preview** 开关（浏览器本地偏好，默认开）。

## 支持类型一览

| 类型 | 行为 |
|------|------|
| 图片 | 缩放平移（含 TIFF） |
| PDF | 内置查看器 |
| Markdown | 渲染 |
| 代码 / 文本 / 日志 | Monaco 只读 |
| HTML | 沙箱会话 |
| CSV / TSV | 表格 |
| Word / PPT | 可选：Agent 侧 → PDF |
| Excel / ODS | 可选：每 sheet → CSV |

## 提示

- 桌面多标签；可关闭、切换；支持键盘快捷键。
- 过大文件会先询问，避免拖死浏览器。
- 预览栏可直接 **Download**。
- 无 `soffice` 时 Office 仍可下载，预览入口不可用。
