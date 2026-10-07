# 预览

点击文件即可在工作区内预览，无需先下载到笔记本。桌面为多标签工作区；手机上预览全屏切换。

![预览加载示意](/screenshots/08-preview-stream.png)

![内联图片预览（Files）](/screenshots/01-files-browse.png)

## 支持类型

| 类型 | 行为 |
|------|------|
| 图片 | 缩放平移（含 TIFF） |
| PDF | 内置查看器 |
| Markdown | 渲染 |
| 代码 / 文本 / 日志 | Monaco 只读（查找、换行、高亮） |
| HTML | 沙箱会话 |
| CSV / TSV | 表格 |
| Word / PPT | 可选：Agent 侧 LibreOffice → PDF |
| Excel / ODS | 可选：每 sheet 导出 CSV |

## 提示

- 桌面多标签；可批量关闭、跳转标签；支持键盘快捷键。
- 过大文件会先询问，避免拖死浏览器。
- 预览栏可直接 Download。
- Office 需在 Agent 上配置 `soffice`，见 [Office 预览](/ops/office)。无 `soffice` 时 Office 文件仍可下载，预览入口不可用。

演示页会模拟流式加载进度条；真实应用对大文件同样有进度与取消。
