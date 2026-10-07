# Agent 配置与更新

Agent 装在每台要浏览的机器上，主动出站连 Hub。安装步骤见 [部署 Agent](/guide/install-agent)。

## 状态与配置

- 配置文件：`agent.toml`（`--init-config` 创建，权限 0600）。
- 状态目录默认在系统 data dir 下的 `filebox`（可用 `FILEBOX_AGENT_DATA_DIR`）。
- 根目录、钉选、合集经 UI 下发并持久化；坏的更新不会毁掉上一份好配置。
- 断线后永久重连，身份不变、不产生重复侧栏条目。

## 环境变量摘要

| 变量 | 含义 |
|------|------|
| `FILEBOX_AGENT_HUB` | Hub URL（`https://` / `wss://`） |
| `FILEBOX_AGENT_TOKEN` | Agent token |
| `FILEBOX_AGENT_NAME` | 侧栏显示名 |
| `FILEBOX_AGENT_DATA_DIR` | 状态目录 |
| `FILEBOX_AGENT_SOFFICE` / `_DIR` | LibreOffice（可选） |
| `FILEBOX_AGENT_TERMINAL_TOTP_SECRET` | Terminal 2FA（可选） |

## 更新

```bash
./agent --update
```

校验校验和后原地替换。建议与 Hub、前端大版本一起升。

## 可选能力开关

| 能力 | 配置入口 |
|------|----------|
| Office 预览 | [Office 预览](./office) |
| Terminal 2FA | `./agent --setup-terminal-2fa` 或环境变量，见 [Terminal](/features/terminal) |
| Transfer | 能力位 `temp_upload`；规则见 [Transfer](/features/transfer) |
