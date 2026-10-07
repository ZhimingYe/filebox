# 常见问题

## 侧栏没有 Agent？

- Agent 进程是否在跑、能否解析 Hub 主机名。
- Hub URL 是否为 `https://`（或开发时显式 `FILEBOX_ALLOW_INSECURE_HUB=1`）。
- token 是否与 Hub `--init-config` 打印的一致（Hub 只存 hash，对不上只能重新发 / 重新配）。
- 反代是否正确升级 WebSocket（`Upgrade` / `Connection`，见 [Hub 运维](./hub)）。

## 有 Agent 但文件列表空？

需要在 **Settings → Add Root** 添加可读目录。无效路径会被拒绝且不破坏已有配置。见 [首次登录](/guide/first-login)。

## 搜索很慢 / 被取消？

大树请收窄 root、加深忽略目录（如 `node_modules` / `venv`）、降低深度；可随时 Cancel。单 Agent 同时只跑一个搜索。

## 打不开某些文件？

敏感路径（`.ssh/`、`.env*`、`*.pem` 等）默认拒绝，即使在已授权 root 内。见 [安全与敏感文件](/features/security)。

## Office 预览灰掉 / 失败？

Agent 上是否配置了可用的 `soffice`？见 [Office 预览](./office)。无 LibreOffice 时仍可 Download。

## Terminal 要验证码？

必须在 Agent 本机完成 `./agent --setup-terminal-2fa`（或设置 `FILEBOX_AGENT_TERMINAL_TOTP_SECRET`）并重启。Hub 不保存密钥。见 [远程终端](/features/terminal)。

## 演示页和真实 UI 不一样？

演示是单页 mock，用于营销与布局预览：

| 演示 | 真实应用 |
|------|----------|
| 无登录页 | PoW + CSRF 登录 |
| Search 替换主视图 | Search 浮窗 / 底部 sheet |
| 无独立 Explorer 页 | 有 Explorer 树视图 |
| 无 Settings / Audit | 有 Add Root、登录审计等 |

文档截图优先演示可复现视图，并逐步补真实机截图。

## 开发联调？

见仓库 [`docs/local-debugging.md`](https://github.com/ZhimingYe/filebox/blob/main/docs/local-debugging.md)（`FILEBOX_DEV_MODE=1` 等）。仓库根目录 `docs/` 是开发者 runbook，**不**并入本用户文档站。
