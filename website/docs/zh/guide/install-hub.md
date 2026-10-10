# 部署 Hub

Hub 跑在你控制的中心机上（小 VPS、内网机或容器）。浏览器与 Agent 都只连它；Hub 自带前端静态资源，用户只需记一个 URL。

## 前置条件

- Linux x86_64（发布包为 musl 静态链接，多数发行版可直接跑）
- 能被浏览器访问的地址（生产请准备 TLS 证书）
- 出站能力：Agent 要能连到 Hub 的 443（或你反代的端口）

## 安装

```bash
# 从 https://github.com/ZhimingYe/filebox/releases/latest 下载
tar xzf filebox-hub-*-x86_64-musl.tar.gz
cd filebox-hub-*
./bin/hub --init-config
./bin/hub
```

`--init-config` 会引导你设置：

1. **监听地址**（默认 `0.0.0.0:3000`）
2. **管理员用户名 / 密码**
3. **Agent token**（明文只打印一次；配置里只存 bcrypt hash）

写入：

- `config/hub.json` — 运行时配置
- 前端静态资源已在包内 `frontend/dist/`，Hub 启动时直接托管

请立刻把 Agent token 存到密码管理器或 Agent 配置里；之后无法从 Hub 再读出明文。

## 关键配置字段

| 字段 | 含义 | 默认 |
|------|------|------|
| `listen_addr` | 监听地址 | `0.0.0.0:3000` |
| `agent_token_hash` | Agent token 的 hash | 初始化时写入 |
| `users` | 登录账号 | 初始化时写入 |

也可用环境变量覆盖部分行为（开发常用）：

| 变量 | 作用 |
|------|------|
| `FILEBOX_DEV_MODE=1` | 本机不安全默认：`admin` / `dev-password`，token `dev-token`，绑定 `127.0.0.1` |
| `FILEBOX_LISTEN_ADDR` | 覆盖监听地址 |
| `FILEBOX_FRONTEND_DIR` | 绝对路径指向 `frontend/dist` |
| `FILEBOX_CONFIG_PATH` | `hub.json` 路径 |
| `FILEBOX_TRUST_XFF` | 信任 `X-Forwarded-For`（登录限流 IP） |

## HTTPS（生产必做）

Hub 本身是明文 HTTP；生产用反代终止 TLS。Agent 配置的 Hub URL 必须是 `https://` / `wss://`（除非显式 `FILEBOX_ALLOW_INSECURE_HUB=1`，仅限本机开发）。

HTTPS 才能在传输中保护 Agent token，生产环境务必终止 TLS。

### nginx 示例

```nginx
server {
    listen 443 ssl;
    server_name filebox.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket（Agent 连接）与实时状态
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
    }
}
```

要点：

- `proxy_http_version 1.1` + `Upgrade` / `Connection`（Agent WebSocket）
- `proxy_buffering off`（实时状态）
- Caddy / Traefik 亦可，只要同样支持 WebSocket 升级

缺了 WebSocket 升级时，侧栏会看不到 Agent 或频繁断线。

## systemd 示例（可选）

```ini
[Unit]
Description=filebox Hub
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/filebox-hub
ExecStart=/opt/filebox-hub/bin/hub
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 验证 Hub 已起来

```bash
curl -s http://127.0.0.1:3000/api/health
# {"hub":{"status":"ok","uptime_sec":…,"version":"2.2.0"}}
```

浏览器打开 Hub URL，应看到登录页：

![登录页](/screenshots/09-login.png)

点击侧栏底部版本号可打开 About / Diagnostics（Hub 状态、Agent 列表）：

![About / Health](/screenshots/07-health.png)

## 登录审计

侧栏 **Audit** 记录成功 / 失败 / 限流与登出；日志在 Hub 旁 JSONL，约 2000 条滚动。

![Audit](/screenshots/12-audit.png)

## 更新

```bash
./bin/hub --update
```

会下载最新 release、校验校验和并原地替换。Hub / Agent / 前端大版本建议一起升。

下一篇：[部署 Agent](./install-agent)
