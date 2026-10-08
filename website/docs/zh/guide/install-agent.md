# 部署 Agent

在每台需要被浏览的机器上安装 Agent。它主动连出到 Hub，不需要公网 IP 或入站端口。

## 安装

```bash
tar xzf filebox-agent-*-x86_64-musl.tar.gz
cd filebox-agent-*
./agent --init-config
./agent
```

`--init-config` 会创建 `agent.toml`（权限 0600），引导你：

1. 粘贴 Hub `--init-config` 打印的 **token**
2. 填写 Hub URL（生产用 `https://filebox.example.com`）
3. 设置显示名、数据目录等

## 环境变量（可选）

适合 systemd、容器或编排：

| 变量 | 含义 |
|------|------|
| `FILEBOX_AGENT_HUB` | Hub URL（`https://` 或 `wss://`） |
| `FILEBOX_AGENT_TOKEN` | Hub 初始化时打印的 token |
| `FILEBOX_AGENT_NAME` | 侧栏显示名（默认 `default-agent`） |
| `FILEBOX_AGENT_DATA_DIR` | 状态目录（根目录、合集、临时传输、agent_id 等） |
| `FILEBOX_ALLOW_INSECURE_HUB` | 允许明文 `ws://` / `http://`（仅开发） |
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

开发本机连明文 Hub：

```bash
FILEBOX_AGENT_HUB="ws://127.0.0.1:3000" \
FILEBOX_AGENT_TOKEN="dev-token" \
FILEBOX_AGENT_NAME="lab-server" \
FILEBOX_ALLOW_INSECURE_HUB=1 \
FILEBOX_AGENT_DATA_DIR="/tmp/fbx-agent-data" \
./agent
```

## 连上之后

1. 打开 Hub，登录后侧栏 **Agents** 应出现该机器（绿点 Online、延迟、roots 数）。
2. 还需要在 UI 里 **Settings → Add Root** 才会有可浏览目录。见 [首次登录与添加目录](./first-login)。

![Settings：已连接 Agent 与 roots](/screenshots/11-settings.png)

断线后 Agent 会永久重连；`agent_id` 持久化在数据目录，不会在侧栏产生重复条目。

> 同一数据目录不要起两个 Agent 进程，否则会争用同一身份。多 Agent 请给各自独立的 `FILEBOX_AGENT_DATA_DIR`。

## 可选能力

| 能力 | 如何启用 |
|------|----------|
| Office 预览 | 安装 LibreOffice 并设置 `FILEBOX_AGENT_SOFFICE`，见 [Office 预览](/zh/ops/office) |
| Terminal | 在 Agent 本机运行 `./agent --setup-terminal-2fa` 后重启，见 [远程终端](/zh/features/terminal) |
| Transfer | 能力位 `temp_upload`（当前发布版默认具备）；写入仅限专用 scratch 目录 |

启用 Terminal 与 Office 后，侧栏会出现对应入口，Settings 里也会显示 Office preview 开关：

![Terminal 入口与会话](/screenshots/05-terminal.png)

## systemd 示例（可选）

```ini
[Unit]
Description=filebox Agent
After=network.target

[Service]
Type=simple
Environment=FILEBOX_AGENT_HUB=https://filebox.example.com
Environment=FILEBOX_AGENT_TOKEN=REPLACE_ME
Environment=FILEBOX_AGENT_NAME=hpc-node-01
Environment=FILEBOX_AGENT_DATA_DIR=/var/lib/filebox
ExecStart=/opt/filebox-agent/agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 更新

```bash
./agent --update
```

校验校验和后原地替换。Hub / Agent / 前端大版本建议一起升；Terminal 等能力对三端版本有对齐要求（见 release notes）。

更多运维细节：[Agent 配置与更新](/zh/ops/agent)
