# Hub 配置与 HTTPS

Hub 是唯一需要被浏览器与 Agent 都可达的中心服务。生产环境务必在前面加 TLS 反代。

## 快速回顾

1. `./bin/hub --init-config` → 生成 `config/hub.json`，**打印一次** Agent token  
2. 反代终止 TLS，转发 WebSocket（见下方）  
3. Agent 的 Hub URL 使用 `https://filebox.example.com`  
4. `./bin/hub --update` 原地升级  

更完整的安装步骤见 [部署 Hub](/guide/install-hub)。

## 配置字段

| 字段 | 含义 | 默认 |
|------|------|------|
| `listen_addr` | 监听地址 | `0.0.0.0:3000` |
| `agent_token_hash` | Agent token 的 bcrypt hash | 初始化时写入 |
| `users` | 登录账号 | 初始化时写入 |

## HTTPS 与 WebSocket

Hub 进程本身是 HTTP。nginx 最小示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
}
```

缺了 WebSocket 升级时，侧栏会看不到 Agent 或频繁断线。

开发本机可用 `FILEBOX_ALLOW_INSECURE_HUB=1` 让 Agent 连 `http://`；**不要**用于生产。

## 登录审计

侧栏 **Audit**：成功 / 失败 / 限流与登出记录在 Hub 旁 JSONL，约 2000 条滚动。不依赖当前选中的 Agent。

## 健康

演示页有独立 **Health** 视图；真实部署也可通过侧栏状态与 Agent 延迟判断连通性。

![Health（演示）](/screenshots/07-health.png)
