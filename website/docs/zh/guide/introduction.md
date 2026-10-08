# 什么是 filebox

filebox 是面向实验室 / HPC / 自建服务器的**只读远程文件浏览器**：在每台机器上装一个小 Agent，在你控制的机器上跑一个 Hub，用浏览器打开一个 HTTPS 页面，就能浏览文件、预览图表与数据集、搜索工作区、查看系统负载。

```text
浏览器 ──HTTPS──▶ Hub ◀──WSS（出站）── Agent ──▶ 本地文件
```

![filebox 界面总览（真实 Hub + Agent）](/screenshots/00-sidebar-overview.png)

- **浏览器**：只访问 Hub，不直连 Agent。
- **Hub**：认证用户、托管前端、把请求路由到对应机器。
- **Agent**：装在目标机上，**主动出站**连到 Hub。目标机不需要公网 IP、入站端口、VPN 或端口映射。断线后会自动重连，身份不变、侧栏不产生重复条目。

## 适合谁

研究者、分析师、数据科学家：结果以文件形式散落在共享服务器上，需要随时用手机或笔记本**看一眼图、表、日志**，而不想为了瞄一眼就 `scp` 一整份大文件。

filebox 不是网盘同步工具，也不是完整的远程桌面——它是「结果文件的前门」：打开、预览、搜索、偶尔传一个小临时文件或开一扇受 TOTP 保护的终端。

## 能做什么（v2.1.0）

| 能力 | 说明 | 文档 |
|------|------|------|
| **Files** | 大目录流畅列表、面包屑、过滤、钉选、[多标签预览](/zh/features/tabs) | [浏览文件](/zh/features/browse) |
| **Explorer** | 树形展开式浏览，与 Files 共享当前位置 | [Explorer](/zh/features/explorer) |
| **Search** | 文件名或内容正则；浮窗 / 底部 sheet | [搜索](/zh/features/search) |
| **Collections** | 跨目录的虚拟文件合集，不复制、不移动 | [合集](/zh/features/collections) |
| **Transfer** | 唯一可写的临时上传目录（配额、禁覆盖） | [Transfer](/zh/features/transfer) |
| **Terminal** | 可选；Agent 本地 TOTP 守护的交互式 shell（**非沙箱**） | [Terminal](/zh/features/terminal) |
| **Settings** | 管理根目录、Office 预览开关 | [首次登录](/zh/guide/first-login) |
| **System** | CPU / 内存 / 负载 / 按用户占用 / 进程表 | [系统监控](/zh/features/stats) |
| **Audit** | 登录审计（Hub 级，不依赖选中 Agent） | [Hub 运维](/zh/ops/hub) |

## 默认安全边界

- 浏览协议**只读**：不能改、删、重命名远端文件。
- 敏感路径（`.ssh/`、`.env*`、`*.pem` 等）默认拒绝，即使在允许的根目录内。
- 浏览严格限制在已添加的 root 内；`..`、符号链接逃逸等会被挡住。
- 两个显式例外（需能力开启 / 本地配置）：
  - **Transfer**：仅写入 Agent 专用临时目录。
  - **Terminal**：Agent 本地 TOTP 守护的交互式 shell（**非沙箱**，能做 OS 用户能做的一切）。

详见 [安全与敏感文件](/zh/features/security)。

## 从哪里开始

陌生人也能按文档端到端装好并用起来：先读 [快速开始](./quick-start)，再按 [部署 Hub](./install-hub) → [部署 Agent](./install-agent) → [首次登录与添加目录](./first-login) 走完。
