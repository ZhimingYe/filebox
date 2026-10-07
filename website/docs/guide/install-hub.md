# 部署 Hub

Hub 跑在你控制的中心机上（小 VPS、内网机或容器）。浏览器与 Agent 都只连它；Hub 自带前端静态资源，用户只需记一个 URL。

## 安装

```bash
tar xzf filebox-hub-*-x86_64-musl.tar.gz
cd filebox-hub-*
./bin/hub --init-config
./bin/hub
```

`--init-config` 会引导你设置监听地址、管理员账号，并生成 Agent token：

- 配置写入 `config/hub.json`
- Agent token **只打印一次**（Hub 只存 bcrypt hash）
- 请立刻把 token 存到密码管理器或 Agent 配置里；之后无法从 Hub 再读出明文

## 关键配置字段

| 字段 | 含义 | 默认 |
|------|------|------|
| `listen_addr` | 监听地址 | `0.0.0.0:3000` |
| `agent_token_hash` | Agent token 的 hash | 初始化时写入 |
| `users` | 登录账号 | 初始化时写入 |

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

## 更新

```bash
./bin/hub --update
```

会下载最新 release、校验校验和并原地替换。Hub / Agent / 前端大版本建议一起升。

## 登录审计

侧栏 **Audit** 记录成功 / 失败 / 限流与登出；日志在 Hub 旁 JSONL，约 2000 条滚动。详见 [Hub 运维](/ops/hub)。

下一篇：[部署 Agent](./install-agent)
