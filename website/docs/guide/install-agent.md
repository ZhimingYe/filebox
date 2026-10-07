# 部署 Agent

在每台需要被浏览的机器上安装 Agent。它主动连出到 Hub，不需要公网 IP、入站端口或 VPN。

## 安装

```bash
tar xzf filebox-agent-*-x86_64-musl.tar.gz
cd filebox-agent-*
./agent --init-config
./agent
```

`--init-config` 会创建 `agent.toml`（权限 0600），引导你粘贴 Hub 打印的 token 并填写 Hub URL。

## 环境变量（可选）

适合 systemd、容器或编排：

| 变量 | 含义 |
|------|------|
| `FILEBOX_AGENT_HUB` | Hub URL（`https://` 或 `wss://`） |
| `FILEBOX_AGENT_TOKEN` | Hub 初始化时打印的 token |
| `FILEBOX_AGENT_NAME` | 侧栏显示名（默认 `default-agent`） |
| `FILEBOX_AGENT_DATA_DIR` | 状态目录（根目录、合集、临时传输等） |
| `FILEBOX_AGENT_SOFFICE` | LibreOffice `soffice` 路径（可选 Office 预览） |
| `FILEBOX_AGENT_SOFFICE_DIR` | 含 `soffice` 的目录 |
| `FILEBOX_AGENT_TERMINAL_TOTP_SECRET` | Terminal 2FA 的 base32 密钥（可选；环境变量优先） |

示例：

```bash
export FILEBOX_AGENT_HUB="https://filebox.example.com"
export FILEBOX_AGENT_TOKEN="the-token-from-hub"
export FILEBOX_AGENT_NAME="web-01"
export FILEBOX_AGENT_DATA_DIR="/var/lib/filebox"
./agent
```

## 连上之后

侧栏出现 Agent 后，还需要在 UI 里 **Settings → Add Root** 才会有可浏览目录。见 [首次登录与添加目录](./first-login)。

断线后 Agent 会永久重连；身份持久化，不会在侧栏产生重复条目。

## 可选能力

| 能力 | 如何启用 |
|------|----------|
| Office 预览 | 安装 LibreOffice 并设置 `FILEBOX_AGENT_SOFFICE`，见 [Office 预览](/ops/office) |
| Terminal | 在 Agent 本机运行 `./agent --setup-terminal-2fa` 后重启，见 [远程终端](/features/terminal) |
| Transfer | 由能力位控制是否在 UI 显示；写入仅限专用 scratch 目录 |

## 更新

```bash
./agent --update
```

校验校验和后原地替换。Hub / Agent / 前端大版本建议一起升；Terminal 等能力对三端版本有对齐要求（见 release notes）。

更多运维细节：[Agent 配置与更新](/ops/agent)
