# Agent 配置与更新

Agent 装在每台要浏览的机器上，主动出站连 Hub。安装步骤见 [部署 Agent](/zh/guide/install-agent)。

## 状态与配置

- 配置文件：`agent.toml`（`--init-config` 创建，权限 0600）。
- 状态目录默认在系统 data dir 下的 `filebox`（可用 `FILEBOX_AGENT_DATA_DIR`）。
- 根目录、钉选、合集经 UI 下发并持久化；坏的更新不会毁掉上一份好配置。
- 断线后永久重连，身份不变、不产生重复侧栏条目。
- 多实例必须使用不同的 `FILEBOX_AGENT_DATA_DIR`。

## 环境变量摘要

| 变量 | 含义 |
|------|------|
| `FILEBOX_AGENT_HUB` | Hub URL（`https://` / `wss://`） |
| `FILEBOX_AGENT_TOKEN` | Agent token |
| `FILEBOX_AGENT_NAME` | 侧栏显示名 |
| `FILEBOX_AGENT_DATA_DIR` | 状态目录 |
| `FILEBOX_AGENT_TRUSTED_PORTS` | Agent 本地的可信 Web 端口；覆盖 TOML `trusted_ports`，包括空值覆盖（全部拒绝）；重启后生效 |
| `FILEBOX_AGENT_AI_AGENTS_ENABLED` | 在此 Agent 上启用或禁用 AI Agents |
| `FILEBOX_AGENT_AI_AGENTS_BACKEND` | 将 AI Agents 锁定到指定后端类型 |
| `FILEBOX_AGENT_HC` | 指定 hc 可执行文件路径（试验性后端；未设置时搜索 PATH） |
| `FILEBOX_ALLOW_INSECURE_HUB` | 允许明文 Hub（仅开发） |
| `FILEBOX_AGENT_SOFFICE` / `_DIR` | LibreOffice（可选） |
| `FILEBOX_AGENT_STATS_TTL_SECS` | sysinfo 缓存 TTL（默认 60） |
| `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS` | 目录缓存 re-stat 冷却 |

Office 相关上限见 [Office 预览](./office)。

## 可信 Web 端口 {#trusted-web-ports}

Web 转发默认拒绝所有端口。在 Agent 机器的 `agent.toml` 中添加字符串配置：

```toml
trusted_ports = "3080,8888,9000-9010"
```

也可设置 `FILEBOX_AGENT_TRUSTED_PORTS="3080,8888,9000-9010"`。环境变量覆盖 TOML，包括空值；修改后需重启 Agent。语法为逗号分隔的十进制端口（1–65535）或包含两端的升序范围，允许空白。未设置或为空时拒绝所有端口；格式错误会阻止启动。不区分大小写的 `"all"` 允许所有回环端口，会记录警告且**不推荐**，请优先指定明确列表。不支持 TOML 数组。

策略仅保留在 Agent 本地，不向 Hub 公布。Agent 会无损拒绝不可信的转发更新，并拒绝打开不可信的隧道。已有转发仍保存在 `agent_state.json`；Ports 将其标记为 **Not trusted by agent**，禁用 Open，并展示 Agent 拒绝消息。不可信转发的代理请求返回 403。Hub 只能获取每个已配置转发的信任标记，无法获知允许的端口列表。请同时升级 Agent 和 Hub：旧 Agent 无法执行该策略，新 Hub 将缺失的信任标记视为不可信。

只转发可信应用：它们保留本地能力（包括写文件、执行代码），且与 Hub 共享来源，脚本可用当前登录用户身份调用 Filebox API。`FILEBOX_AGENT_PORT_FORWARD=off` 可完全关闭转发。

## 试验性 hc 后端 {#experimental-hc-backend}

在 Agent 机器安装 [herdr-core](https://github.com/herdrdev/herdr-core#install)，
让 Filebox Agent 能找到 `hc`。自动接入通过 OSC 7501 报告非空 `status.app`
的本地运行中终端，使用 hc 终端名称；标签不影响接入或名称。

```sh
hc run --bg --name frontend -- claude
hc run --bg --name backend -- claude
```

在各自工作目录启动编码代理。列表和详情保留终端 ID，同名不会改变操作目标。
每次读取、发送 prompt 或按键前都会重新检查接入条件。

在 Agent Settings 选择 **hc (experimental)**；同时安装两种后端时，自动选择仍优先 Herdr。
`FILEBOX_AGENT_AI_AGENTS_BACKEND=hc` 可锁定选择。hc 沿用 Agent 进程的 hc session/config 环境，
`hc connect` 可自动启动本地 core。状态只来自程序的 OSC 7501 报告，无状态的终端不接入；
prompt 审核链路不变。不接入无状态的普通 shell、已结束或远端机器的终端。取消不能撤回 hc 已接受的输入，
重试前请先检查输出。已验证 hc 0.1.17、API generation 1。

## 更新

```bash
./agent --update
```

校验校验和后原地替换。建议与 Hub、前端大版本一起升。

## 可选能力开关

| 能力 | 配置入口 |
|------|----------|
| Office 预览 | [Office 预览](./office) |
| Transfer | 能力位 `temp_upload`；规则见 [Transfer](/zh/features/transfer) |

在 UI **Settings** 可确认连接状态与已启用 roots：

![Settings](/screenshots/11-settings.png)
