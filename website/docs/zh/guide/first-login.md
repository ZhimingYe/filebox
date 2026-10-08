# 首次登录与添加目录

跑通 Hub 与 Agent 之后，在浏览器里完成：登录（含 PoW）→ 选机器 → Add Root → 开始浏览。

## 1. 打开登录页

访问 Hub URL。登录页包含：

- Username / Password
- **Verification（PoW）**：后台求解 challenge，显示 Solving… → **Ready**
- Keep me signed in 30 days（可选）
- **Continue**

![Sign in：PoW Ready](/screenshots/09-login.png)

![已填写凭据](/screenshots/09c-login-filled.png)

生产账号使用 `--init-config` 时创建的用户名 / 密码。开发模式默认 `admin` / `dev-password`。

若 Verification 失败或限流，点刷新图标重新拉取 challenge，稍后再试。

## 2. 选择 Agent

登录成功后，若尚未选中机器，主区会提示 **Select an agent**。在侧栏 **Agents** 点击目标机器（显示 Online、延迟、roots 数）。

选中后，侧栏出现 **Workspace** 导航：Files、Explorer、Collections、Transfer、Terminal、Search、Settings、System；以及 **Hub → Audit**。

## 3. Settings → Add Root

打开 **Settings**：

1. 确认 Connection 卡片：Online、Round-trip、Enabled roots。
2. 在 **Workspace roots** 下的 **Add root** 填写：
   - **NAME**：侧栏 / 地址栏里显示的短名（如 `demo`、`projects`）
   - **PATH ON AGENT**：Agent 本机上的绝对路径，或 `~/…`
3. 点 **Add root**。过宽路径（如 `/`、家目录根）会弹出确认，需明确同意。

![Settings 总览](/screenshots/11-settings.png)

![Add root 表单](/screenshots/11b-settings-add-root.png)

无效路径会被拒绝，**不会**破坏已有配置。根目录、钉选、合集存在 Agent 状态里，随身份持久化。

## 4. 进入 Files 浏览

回到 **Files**，用根下拉框切换 root，点进目录，点击文件即可右侧预览。

![Files 根目录列表](/screenshots/01-files-browse.png)

![reports 目录（长文件名）](/screenshots/01c-files-reports.png)

## 侧栏视图一览

| 视图 | 作用 | 文档 |
|------|------|------|
| Files | 面包屑 + 列表浏览，多标签预览 | [浏览文件](/zh/features/browse) |
| Explorer | 树形展开式浏览 | [Explorer](/zh/features/explorer) |
| Search | 工作区文件名 / 内容搜索（桌面浮窗 / 手机底部 sheet） | [搜索](/zh/features/search) |
| Collections | 跨目录的虚拟文件合集 | [合集](/zh/features/collections) |
| Transfer | 唯一可写的临时上传目录 | [Transfer](/zh/features/transfer) |
| Terminal | 可选，TOTP 守护的远程 shell | [Terminal](/zh/features/terminal) |
| Settings | 管理根目录、Office 预览开关 | 本文 |
| System | CPU / 内存 / 进程 | [系统监控](/zh/features/stats) |
| Audit | 登录审计（不依赖选中 Agent） | [Hub 运维](/zh/ops/hub) |
| 版本号 | 点击打开 About / Diagnostics | — |

![Audit](/screenshots/12-audit.png)

![About / Diagnostics](/screenshots/07-health.png)

## 手机

视口宽度小于约 768px 时使用抽屉侧栏；列表与预览全屏切换。顶部有菜单与 Search 入口。

![手机 Files](/screenshots/13-mobile-files.png)

![手机侧栏抽屉](/screenshots/13b-mobile-drawer.png)

常见问题见 [FAQ](/zh/ops/faq)。
