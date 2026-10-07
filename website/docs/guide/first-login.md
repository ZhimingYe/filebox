# 首次登录与添加目录

跑通 Hub 与 Agent 之后，剩下的是在浏览器里登录、选机器、声明可浏览根目录。

![Hub Health（演示）](/screenshots/07-health.png)

## 步骤

1. 打开 Hub 的 HTTPS 地址。
2. 使用 `--init-config` 时创建的用户名 / 密码登录。
   - 真实应用有 PoW + CSRF；[在线演示](https://zhimingye.github.io/filebox/)无登录页。
3. 在侧栏 **Agents** 选择已连接的机器（在线状态、延迟会显示）。
4. 打开 **Settings → Add Root**，输入绝对路径或 `~/项目名`。
5. 无效路径会被拒绝，不会破坏已有配置。
6. 回到 **Files** / **Explorer** 浏览。

![Files 浏览](/screenshots/01-files-browse.png)

## 侧栏视图一览

| 视图 | 作用 | 文档 |
|------|------|------|
| Files | 面包屑 + 列表浏览，多标签预览 | [浏览文件](/features/browse) |
| Explorer | 树形展开式浏览（可选） | [Explorer](/features/explorer) |
| Search | 工作区文件名 / 内容搜索（真实应用为浮窗） | [搜索](/features/search) |
| Collections | 跨目录的虚拟文件合集 | [合集](/features/collections) |
| Transfer | 唯一可写的临时上传目录 | [Transfer](/features/transfer) |
| Terminal | 可选，TOTP 守护的远程 shell | [Terminal](/features/terminal) |
| Settings | 管理根目录等 | — |
| System / Stats | CPU / 内存 / 进程 | [系统监控](/features/stats) |
| Audit | 登录审计（不依赖选中 Agent） | [Hub 运维](/ops/hub) |
| Health | Hub / Agent 健康（演示页有独立入口） | — |

## 小提示

- 手机（视口宽度小于 768px）用抽屉侧栏；列表与预览全屏切换。
- 根目录、钉选、合集存在 Agent 状态里，随身份持久化。
- 演示侧栏有 Files / Search / Collections / Transfer / Terminal / Stats / Health；真实应用还包含 Explorer、Settings、Audit 等。

常见问题见 [FAQ](/ops/faq)。
