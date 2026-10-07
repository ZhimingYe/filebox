# 快速开始

大约四步：下载 → 初始化 Hub → 启动 Hub → 初始化并连接 Agent。完成后在浏览器里登录、Add Root，即可浏览。

![侧栏与 Files 总览](/screenshots/00-sidebar-overview.png)

## 1. 下载

从 [Releases](https://github.com/ZhimingYe/filebox/releases/latest) 取最新 musl 静态包：

- `filebox-hub-<ver>-x86_64-musl.tar.gz` — 放在你能暴露 HTTPS 的机器上
- `filebox-agent-<ver>-x86_64-musl.tar.gz` — 放在每台要浏览的后端机上

多数用户不需要从源码编译。

## 2. 初始化并启动 Hub

```bash
tar xzf filebox-hub-*-x86_64-musl.tar.gz
cd filebox-hub-*
./bin/hub --init-config   # 监听地址、管理员账号、Agent token（只打印一次）
./bin/hub                 # 默认 :3000，自带前端静态资源
```

`--init-config` 会生成 `config/hub.json`，并**只打印一次** Agent token（Hub 只存 bcrypt hash）。请立刻保存 token，之后无法从 Hub 再读出明文。

生产环境请在前面加 nginx / Caddy / Traefik 终止 TLS。详见 [Hub 配置与 HTTPS](/ops/hub)。

## 3. 初始化并启动 Agent

在后端机上：

```bash
tar xzf filebox-agent-*-x86_64-musl.tar.gz
cd filebox-agent-*
./agent --init-config     # 粘贴 Hub 打印的 token，填写 Hub URL（https://…）
./agent
```

也可用环境变量（适合 systemd / 容器）：

```bash
export FILEBOX_AGENT_HUB="https://filebox.example.com"
export FILEBOX_AGENT_TOKEN="the-token-from-hub"
export FILEBOX_AGENT_NAME="hpc-node-01"
export FILEBOX_AGENT_DATA_DIR="/var/lib/filebox"
./agent
```

Agent **只出站**；防火墙无需为它开入站。连上后侧栏会出现该机器。

## 4. 登录并添加根目录

1. 浏览器打开 Hub URL，用 `--init-config` 时设置的账号登录。
2. 侧栏应出现已连接的 Agent。
3. **Settings → Add Root**，填绝对路径或 `~/…`。
4. 进入 **Files** 开始浏览。

![文件浏览](/screenshots/01-files-browse.png)

## 接下来

| 想做… | 去看 |
|------|------|
| 更细的 Hub / HTTPS | [部署 Hub](./install-hub) · [Hub 运维](/ops/hub) |
| 多机 Agent、环境变量 | [部署 Agent](./install-agent) · [Agent 运维](/ops/agent) |
| 首次登录与各视图 | [首次登录与添加目录](./first-login) |
| 搜索 / 合集 / 传输 / 终端 | [功能导览](/features/browse) |
| Word / PPT / Excel 预览 | [Office 预览](/ops/office) |
