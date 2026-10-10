# 截图清单

来源：本地真实 Hub + Agent（`FILEBOX_DEV_MODE=1`，`http://localhost:3000`）  
设备像素比 2，视口 1440×900（手机 390×844）  
脚本：`node scripts/capture-real-screenshots.mjs`（通用）· `node scripts/capture-tabs.mjs`（多标签 + 首页 hero + 08d）  
演示数据：`/tmp/pdfvenv/bin/python scripts/gen-demo-report-pdf.py`（PDF + figures）· `python3 scripts/gen-demo-extras.py`（代码 / CSV / Markdown）

| 文件 | 说明 |
|------|------|
| 00-sidebar-overview.png | Files + 侧栏总览 |
| 01-files-browse.png | Files 根目录列表 |
| 01b-files-figures.png | figures 目录 |
| 01c-files-reports.png | reports 长文件名 |
| 02-search.png / 02b-search-results.png | 文件名搜索结果 |
| 02c-search-content.png | 内容正则搜索 |
| 03-collections.png / 03b-… | Collections |
| 04-transfer.png / 04b-… | Transfer 与上传后 |
| 05-terminal.png … 05d-… | Terminal TOTP 与会话输出 |
| 06-stats.png | System Monitor |
| 07-health.png | About / Diagnostics |
| 08-preview-*.png | 图 / MD / 代码 / PDF（多页合成报告） / CSV / Office / Quarto·Rmd（08g） / Jupyter ipynb（08h） |
| 09-login*.png | 登录与 PoW |
| 10-explorer*.png | Explorer 树 |
| 11-settings*.png | Settings / Add Root |
| 12-audit.png | 登录审计 |
| 13-mobile*.png | 窄屏 |
| 14-tabs-pdf.png | 多标签：6 个标签，当前 PDF（热图 + QC 表），图标签已固定；视口 1600×1000 |
| 14b-tabs-code.png / 14c-tabs-image.png | 多标签：切到代码 / 图片标签 |
| 14d-tabs-context-menu.png | 标签右键菜单（Pin / Close / 左侧 / 右侧 / 全部） |
| 14e-tabs-picker.png | Open previews 跳转列表 |
| hero-tabs-pdf-{1600,2400}.webp | 首页 hero（桌面，源自 14-tabs-pdf.png） |
| hero-tabs-pdf-mobile-{800,1200}.webp | 首页 hero（手机：预览区裁切，标签与表格更易读） |

**零 demo-mock 截图。** 旧的静态演示页及其截图脚本已移除。
