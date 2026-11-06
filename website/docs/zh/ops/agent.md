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
| `FILEBOX_AGENT_AI_AGENTS_ENABLED` | 在此 Agent 上启用或禁用 AI Agents |
| `FILEBOX_AGENT_AI_AGENTS_BACKEND` | 将 AI Agents 锁定到指定后端类型 |
| `FILEBOX_AGENT_HC` | 指定 hc 可执行文件路径（试验性后端；未设置时搜索 PATH） |
| `FILEBOX_ALLOW_INSECURE_HUB` | 允许明文 Hub（仅开发） |
| `FILEBOX_AGENT_SOFFICE` / `_DIR` | LibreOffice（可选） |
| `FILEBOX_AGENT_STATS_TTL_SECS` | sysinfo 缓存 TTL（默认 60） |
| `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS` | 目录缓存 re-stat 冷却 |

Office 相关上限见 [Office 预览](./office)。

## 试验性 hc 后端 {#experimental-hc-backend}

在 Agent 机器安装 [herdr-core](https://github.com/herdrdev/herdr-core#install)，
让 Filebox Agent 能找到 `hc`。在各自工作目录启动终端，用 `fb=名称` 或 `filebox=名称`
指定它在 Filebox 中的显示名称；只接入带这些标记的本地运行中终端：

```sh
hc run --bg --label fb=frontend -- claude
hc run --bg --label Filebox=backend -- claude
hc label t7 fb=review       # 接入已有终端，或修改它在 Filebox 中的名称
hc label t7 fb=             # 移除此标签，撤销接入
```

将 `t7` 换成实际终端地址，`claude` 换成要运行的程序。
标签决定终端是否接入，里面运行编码代理、shell 或其他程序均可，不额外判断程序类型。
标签键不区分大小写：`fb`、`FB`、`filebox`、`Filebox`、`FILEBOX` 及混合大小写均可；
值是客户自定的名称，不是固定口令，空值或纯空白不接入。名称可包含中文或空格，
含空格时给整个标签加引号，例如 `--label 'fb=Code review'`。
原来的 `filebox=ai-agent` 仍可接入，并保留 hc 终端原名；同时有两种标签时，优先使用 `fb` 的名称。
列表和详情保留终端 ID，同名或改名不会改变操作目标；刷新列表后更新名称，选中项和草稿不变。
这些名称不修改 hc 自身的终端名。撤销接入时，需删除所有受支持的标签，删除命令保留原键名大小写，
例如 `hc label t7 Filebox=` 删除 `Filebox=backend`，不会删除另一个 `fb` 或 `FILEBOX` 标签。

在 Agent Settings 选择 **hc (experimental)**；同时安装两种后端时，自动选择仍优先 Herdr。
`FILEBOX_AGENT_AI_AGENTS_BACKEND=hc` 可锁定选择。hc 沿用 Agent 进程的 hc session/config 环境，
`hc connect` 可自动启动本地 core。状态只来自程序的 OSC 7501 报告，没有报告则显示 Unknown；
prompt 审核链路不变。不接入未标记、已结束或远端机器的终端。取消不能撤回 hc 已接受的输入，
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
