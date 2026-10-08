# 常见问题

## 侧栏没有 Agent？

按顺序排查：

1. Agent 进程是否在跑：`ps` / systemd status。
2. 能否解析 Hub 主机名：在 Agent 机 `curl -v https://filebox.example.com/api/health`。
3. Hub URL 是否为 `https://`（或开发时显式 `FILEBOX_ALLOW_INSECURE_HUB=1` + `ws://`）。
4. token 是否与 Hub `--init-config` 打印的一致（Hub 只存 hash，对不上只能重新发 / 重新配）。
5. 反代是否正确升级 WebSocket（`Upgrade` / `Connection`），见 [Hub 运维](./hub)。

## 有 Agent 但文件列表空？

需要在 **Settings → Add Root** 添加可读目录。无效路径会被拒绝且不破坏已有配置。见 [首次登录](/zh/guide/first-login)。

![Add Root](/screenshots/11b-settings-add-root.png)

## 登录一直 Solving / Continue 灰掉？

登录前必须完成 PoW（Verification → Ready）。若卡住：刷新 challenge、检查 `/api/pow/challenge` 是否可达、是否触发 IP 限流。见 [首次登录](/zh/guide/first-login)。

![登录 PoW](/screenshots/09-login.png)

## 搜索很慢 / 被取消？

大树请收窄 root、加深忽略目录（如 `node_modules` / `venv`）、降低深度；可随时 Cancel。单 Agent 同时只跑一个搜索。见 [搜索](/zh/features/search)。

## 打不开某些文件？

敏感路径（`.ssh/`、`.env*`、`*.pem` 等）默认拒绝，即使在已授权 root 内。见 [安全与敏感文件](/zh/features/security)。

## Office 预览灰掉 / 失败？

Agent 上是否配置了可用的 `soffice`？见 [Office 预览](./office)。无 LibreOffice 时仍可 Download。

## Terminal 要验证码？

必须在 Agent 本机完成 `./agent --setup-terminal-2fa`（或设置 `FILEBOX_AGENT_TERMINAL_TOTP_SECRET`）并重启。Hub 不保存密钥。每次 Open / Resume 都要新码。见 [远程终端](/zh/features/terminal)。

## Transfer 找不到入口？

侧栏仅在 Agent 声明 `temp_upload` 能力时显示 Transfer。当前发布版默认具备；若自定义构建关闭了该能力则不会出现。

## 有没有在线演示？文档截图是真实界面吗？

没有托管的在线演示——filebox 需要你自己的 Hub 和 Agent 才能浏览真实文件，按 [快速开始](/zh/guide/quick-start) 几分钟即可在本机跑通。**本文档站的截图全部来自真实运行的 Hub + Agent**，与你部署后看到的界面一致（含登录 PoW、多标签预览、Search 浮窗、Settings、Audit、Terminal TOTP 等）。

## 开发联调？

见仓库 [`docs/local-debugging.md`](https://github.com/ZhimingYe/filebox/blob/main/docs/local-debugging.md)（`FILEBOX_DEV_MODE=1` 等）。仓库根目录 `docs/` 是开发者 runbook，**不**并入本用户文档站。
