# Hub ↔ Agent 安全模型

> 说明：本文基于当前代码（`crates/hub/src/ws.rs`、`crates/hub/src/auth.rs`、
> `crates/hub/src/state.rs`、`crates/agent/src/connection.rs`、
> `crates/agent/src/config.rs`、`crates/agent/src/fs.rs`、
> `crates/agent/src/temp_store.rs`、`crates/protocol/src/message.rs`）整理，
> 描述 **Agent 出站拨号到 Hub** 这条链路的实际安全机制与信任边界。

## 1. 架构与信任边界

```text
浏览器 ──HTTPS──▶ [nginx] ──HTTP──▶ Hub ◀──WSS(出站)── Agent ──▶ 本地文件 + 系统信息
                    (TLS 终止)                     (TLS 由 Agent 发起)
```

- 连接方向永远是 **Agent 主动出站** 拨号 Hub（`/ws/agent`）。Agent 不需要公网
  IP、入站端口或端口映射；Hub 永不主动连接 Agent。
- Hub 自身是普通 HTTP（axum，无 TLS 监听）。生产部署假定由 nginx 之类的反代
  终止 TLS（见 `docs/local-debugging.md` 与仓库根 CLAUDE.md 的部署章节）。
  默认监听 `0.0.0.0:3000`，dev 模式默认 `127.0.0.1:3000`。
- 因此**端到端加密只覆盖「Agent ↔ nginx」段**；nginx ↔ Hub 之间默认是
  本机/内网明文。把 Hub 监听在非回环地址上时，必须自己用防火墙把它和
  nginx 隔开。

## 2. 传输安全（TLS）

| 环节 | 机制 | 代码位置 |
|---|---|---|
| TLS 客户端 | Agent 用 `tokio-tungstenite` 的 `rustls-tls-webpki-roots` feature，rustls 做 TLS，**内置 Mozilla 根证书集，不依赖 OS 证书库** | `crates/agent/Cargo.toml` |
| URL 强制 | 配置只接受 `https://` / `wss://`（`is_secure_hub_url`），`http://` / `ws://` 直接 FATAL 退出，除非显式设 `FILEBOX_ALLOW_INSECURE_HUB=1`（仅限本地开发，启动时打印警告） | `crates/agent/src/config.rs` |
| URL 转换 | `http(s)://hub` → `ws(s)://hub/ws/agent` | `crates/agent/src/connection.rs::build_ws_url` |
| 证书校验 | webpki-roots 校验服务端证书链，校验失败连接直接失败，无任何"跳过校验"开关（`FILEBOX_ALLOW_INSECURE_HUB` 只放开明文，不放宽证书） | 同上 |

要点：

- Agent 不做 mTLS、不用客户端证书。身份只靠第 3 节的共享 token。
- `FILEBOX_ALLOW_INSECURE_HUB=1` 时整条链路是明文，token 和文件内容都可被
  嗅探——这是开发逃生门，不是部署选项。

## 3. 身份认证（Agent Token）

### 凭据的存放

- **Agent 侧**：token 明文存在 `agent.toml`（或 `FILEBOX_AGENT_TOKEN` env），
  `--init-config` 写入时权限 0600。
- **Hub 侧**：`hub.json` 只存 token 的 **bcrypt hash**（`agent_token_hash`，
  成本 12，`updater --init-config` 生成）。Hub 任何地方都没有 token 明文，
  泄漏 `hub.json` 不能直接得到 token。
- 注意：token 走 `bcrypt::verify` 校验，受 bcrypt 72 字节输入上限约束，
  token 有效长度应控制在 72 字节以内（生成随机 token 时留意长度）。

### 握手时序（每步都有 10s 超时）

```text
Agent                                    Hub
  │  1. 建立 WSS（TLS + WS 升级）           │
  │  2. AgentMessage::Auth { token }  ───▶ │
  │                                        │ 3. bcrypt::verify(token)
  │  4. ◀─── HubMessage::AuthResult        │    失败 → AuthResult{success:false} 并断开
  │          { success: true, agent_id }   │    成功 → 记录审计 agent_auth_failed 的逆（成功）
  │  5. AgentMessage::Register {           │
  │        agent_id, name, resource_       │ 6. 注册进 agent_registry
  │        revision, roots, collections,   │    同 agent_id 已在线 → abort 旧连接（见 §5）
  │        capabilities, temp_root } ───▶ │    记录审计 agent_registered
  │  7. 进入主消息循环（心跳/请求/响应）      │
```

细节：

- Auth 必须是连接后第一条 WS 消息；不是合法 JSON 或不是 `Auth` 变体 → 直接
  断开，不返回任何信息。
- token **只在 Auth 这一条消息里出现一次**，走 TLS，之后任何消息都不再携带。
- 握手完成后，若再收到 `Auth` / `Register`（重放），Hub 只打 debug 日志且
  **刻意不记录消息内容**——防止 token 被写进日志（代码注释明确说明了这一点）。
- Hub 侧每个 Agent 连接的读循环一旦开始处理业务消息，就不再接受第二次认证。

### 预认证限流

- `ws_rate_limiter`：**每 IP 300 次 / 30s**（`state.rs`）。TCP 升级成功即计数
  （不管是否发 Auth），成功认证后清零。
- 阈值放宽到 300 是为了容纳 NAT 后同 IP 的一群 Agent 在 Hub 重启后同时重连
  （见代码注释），但仍给未认证的暴力尝试一个硬上限。

## 4. 消息通道与消息级校验

- **单条 JSON over WS**，`serde(tag="type")` 标签化枚举（`message.rs`）。
  未知/无法解析的消息被忽略（debug 日志），不影响连接。
- **消息大小上限**：Hub 收 Agent 消息 24 MiB（`MAX_AGENT_WS_MESSAGE_SIZE`），
  兼容滚动升级期间老 Agent 发 4 MiB 的 FileChunk，同时封死恶意大消息。
- **请求-响应关联（req_id）**：Agent 的每个响应都带 `req_id`。Hub 取回 pending
  响应时必须同时满足：① 该连接仍是该 agent_id 的当前连接
  （`is_current_connection`）；② pending 条目登记的 `agent_id` 和
  `connection_id` 与消息来源一致。不匹配 → 忽略并警告。这防止**旧连接或
  冒名连接**把响应塞给新连接/别人的请求。
- **下线竞态防护**：`unregister` 用 `same_channel()` 校验注册表里的 sender 与
  调用者是否是同一个 channel，否则不把状态打回 Offline——慢死的老连接不能
  把刚接上的新连接状态冲掉。
- **Token 重放/握手重放**：见 §3，握手后 Auth/Register 一律忽略。

## 5. 连接生命周期与冒充检测

- **同一 `agent_id` 重复注册**：Hub 允许替换（真实重连必须能工作），但会
  打印警告（旧连接是否 Online、距上次心跳多久），然后 `abort_notify.notify_one()`
  唤醒旧连接读循环使其干净退出（`tokio::select!` 的 abort 分支，见 `ws.rs`）。
  - 由于所有 Agent 默认**共享同一个 token**，任何持有 token 的进程都可以用
    任意 `agent_id` 注册来"冒充"某台机器。Hub 只警告、不拒绝——这是当前
    设计的有意取舍（简单部署），代价是**冒名者能看到该 agent_id 收到的所有
    请求，也能替它响应**。要真正隔离，需要在 `hub.json` 给不同 Agent 配不同
    token（代码支持，因为校验只比对 bcrypt hash，不绑定 agent_id）。
- **断开清理**：连接退出时 `fail_pending_for_connection` 把所有挂在该
  连接的 pending 请求以"agent 断开"错误回复给前端；只有正常关闭（非
  abort）才广播 `agent_disconnected` SSE，避免重连轮换让 UI 状态闪动。

## 6. 双方信任模型（谁信谁什么）

这是整份文档最关键的部分——**信任是不对称的**：

| 方向 | 信任内容 | 被攻破的后果 |
|---|---|---|
| Hub → Agent（数据面） | Hub **信任 Agent 返回的文件/搜索/系统信息数据**。list/stat/chunk/search/stats 全部由 Agent 产生，Hub 只做中继和限流 | Agent 被攻破 = 可以返回任意内容（它本来就持有读权限）；但 Agent 拿不到 Hub 的会话、密码、token hash |
| Agent → Hub（控制面） | Agent **信任 Hub 下发的控制消息**：`ResourcesSetDesired`（roots/pins）、`CollectionsSetDesired`、`FsListRequest`、`FileReadRequest`、`WorkspaceSearchRequest`、`TempUpload` 等 | Hub 被攻破 = 可以指挥所有 Agent 读取其 root 内任意文件、篡改 roots/collections、往 temp 目录写文件 |
| Agent → Hub（身份面） | Agent 信任「持有有效 token 的 WSS 连接」就是 Hub。证书校验失败或 token 错误 → 连接失败，不产生任何副作用 | 一个伪造的"Hub"（能拿到合法 token 或用户被骗指向恶意地址）可以下发恶意 roots/搜索请求 |

推论：

1. **保护 Hub 的登录就是保护 Agent**。所有指挥 Agent 的 HTTP API
   （`/api/agents/*`、`/api/fs/*`、`/api/file/*`、`/api/agents/{id}/workspace-search`
   等）都在 session + CSRF 保护之下（HttpOnly/Secure/SameSite=Strict cookie、
   X-CSRF-Token 同步 token、登录 PoW、per-IP 登录限流，见 `auth.rs` / `pow.rs` /
   `routes.rs`）。`/ws/agent` 是唯一公开的 Agent 端点——因为 Agent 是出站方。
2. **Agent 侧防御纵深**（即使 Hub 被攻破，或 root 里混入恶意文件）：

   - **Roots 是动态 allowlist**：路径绝对或 `~` 相对，Agent 用自己 `$HOME`
     展开并拒绝逃逸；坏更新被拒绝时**保留最后一份好状态**（原子 apply，
     `resources.rs`）。
   - **路径安全 7 步**（`fs.rs::resolve_path`）：解析 root → join → 规范化 →
     `canonicalize()`（消解 symlink 与 `..`）→ 验证仍在 root 内 → 拒绝
     symlink 逃逸 → denylist → **只读打开**。任何一步失败都返回明确错误码，
     不区分"不存在"与"拒绝"交给上层判断。
   - **敏感文件 denylist**（`protocol/src/denylist.rs`）：`.git/`、`.ssh/`、
     `.gnupg/`、`.env*`、shell rc/history、云厂商凭据目录、私钥、`*.sqlite*`
     等默认拒绝；denied 条目可以显示"存在"但永远不可预览/读取。
   - **唯一写路径 = temp 上传文件夹**（`temp_store.rs`）：文件名必须是单个
     路径组件（`protocol/src/temp.rs` 校验：无 `/` `\` NUL `..`，≤255 字节），
     发布用 `hard_link`（原子、存在即失败，冲突自动 ` (2)` 后缀）、配额
     （单文件默认 20 MiB、目录默认 1 GiB，预留制记账）、`O_NOFOLLOW` 防
     symlink、0700 目录 0600 文件、清理永不跟随 symlink。除此之外 Agent
     没有任何写路径。
   - **Capabilities 门控**：`pinned_folders` / `collections` /
     `workspace_search` / `temp_upload` 等以 `Capabilities` 在 Register 时
     上报；Hub 对不支持的特性返回 `400 unsupported_feature`，不会硬推。
3. **"读"能力本身是产品功能**：任何持有登录会话的用户都能读已配置 root 内
   的非敏感文件。安全模型不防"合法用户读文件"，防的是路径逃逸、越权写、
   凭据泄漏。

**远程终端（显式批准的例外，2FA 门控的唯一命令执行通道）**：

- Agent `terminal.rs` 在 unix 上用 `portable-pty` 起 PTY（`$SHELL`，
  cwd 为 Agent 用户的 home，注入 `TERM=xterm-256color`），最多 8 个并发
  会话；`capabilities.terminal` 门控，非 unix / 老 Agent 一律
  `unsupported_feature`。Hub 侧全局上限 16 个会话。
- 浏览器侧强制 TOTP（RFC 6238，HMAC-SHA1，30s ±1 步）：secret 按用户存
  在 Hub 配置旁的 `totp-secrets.json`（0600，原子写）。`verify` 成功只发
  一个 **30 分钟内存 ticket**（256-bit 随机，绑定 `principal_id` 与
  `agent_id`，不落盘）；页内每 5 分钟 `renew` 续期（不需要新码，session
  + CSRF 已是边界）；前端只把 ticket 放组件 state（不写 localStorage），
  浏览器刷新即失效 → 每次刷新都要重新输码。verify 有独立 per-IP 限流
  （5/30s，仅失败计数）。
- 终端 WS 端点 `/api/agents/{id}/terminal/ws?ticket=…` 在 session 中间件
  之外（同 preview 资源的理由：WS 握手无法带 CSRF header），handler 同时
  校验 session cookie 与 ticket 且 principal 必须一致，ticket 兼作 CSRF
  证明。
- **Agent 侧二次校验（可选，按 agent 开启）**：在 agent.toml 配置
  `terminal_totp_secret`（base32，或 env
  `FILEBOX_AGENT_TERMINAL_TOTP_SECRET`）后，agent 上报
  `capabilities.terminal_agent_2fa`，并要求 `TerminalOpen` 携带
  `agent_totp_code`——用户验证器里**另一个条目**的当前 6 位码，由 hub
  透传、agent 用共享的 `protocol::totp` 本地校验。防重放：只接受 30s
  计数器严格大于上次已接受值的码（水位线挂在 `TerminalManager` 上，跨
  重连存活）。拒绝码：`terminal_2fa_required` / `terminal_2fa_invalid`。
  开启后 **hub 被攻破也无法随意开终端**——每次开都需要用户的新鲜验证码，
  且不能重放。残余风险：hub 能在传输途中看到码，可在该码的约 90s 有效
  窗口内搭便车，但 agent 防重放把它限制在"用户刚用过的那个码"上。
- 审计事件：`terminal_2fa_bound` / `terminal_2fa_failed` /
  `terminal_opened` / `terminal_closed`（含 username、IP、UA），与登录
  审计同一 JSONL 通道。

## 7. 活性检测与资源边界（防僵死 / 防 DoS）

### 超时（双向）

| 常量 | 值 | 语义 |
|---|---|---|
| `CONNECT_TIMEOUT`（Agent） | 10s | TCP+TLS+WS 升级总上限，黑洞路由不挂死 |
| `AUTH_TIMEOUT`（Agent） | 10s | 等 `AuthResult` 的上限 |
| Hub 等首条 Auth / Register | 各 10s | 超时静默断开 |
| `NO_MESSAGE_TIMEOUT`（Agent） | 45s | 收不到任何消息（含 Ping）即重连；Hub 每 15s Ping |
| `NO_AGENT_MESSAGE_TIMEOUT`（Hub） | 90s | Agent 每 15s Heartbeat，90s = 6 次心跳静默即断开 |
| `WS_WRITE_TIMEOUT`（双向） | 10s | 写阻塞超 10s 断开，防半开 TCP 的 send buffer 卡死 |
| `STABLE_CONNECTION_THRESHOLD`（Agent） | 30s | 存活 ≥30s 的连接算"稳定"，断开后退避重置 1s |

### 退避与重连

- 1s 起、每次不稳定翻倍、上限 300s、加最多一半 base 的 jitter——防一群
  Agent 在 Hub 重启后同步重连（惊群）。
- 每次重连前尽量发干净的 `Close` 帧，让 Hub 立刻感知而不是等 TCP 超时。

### 并发 / 队列上限

- Hub：预认证 WS 300/30s/IP；raw 文件流信号量 96；temp 上传并发 4；
  每 Agent 资源更新串行锁；HTTP body 1 MiB。
- Agent：FS 32 worker / 256 inflight；目录列表 4/32；工作区搜索同时 1 个
  （9 min deadline）；temp 写队列 16；所有 FS 任务带 cancel 标志，连接断开
  即取消。

### 心跳

- Hub 每 15s 对所有在线 Agent 发 `Ping`；Agent 回 `Pong`；Agent 自己每 15s
  发 `Heartbeat`。两套心跳让任何一端的半开连接都能在分钟内被发现并重建。

## 8. 审计

Agent 通道相关的审计事件（`audit.rs`，JSONL 侧文件，0600）：

- `agent_auth_failed`（ip）
- `agent_registered`（ip、agent_id、name）
- 远程终端：`terminal_2fa_bound`、`terminal_2fa_failed`、
  `terminal_opened`、`terminal_closed`（username、ip、UA）
- 与登录审计同一通道，只读 API `GET /api/audit/logins` 暴露（session+CSRF
  保护）。

## 9. 已知边界与威胁清单

| # | 现状 | 风险 | 缓解/说明 |
|---|---|---|---|
| 1 | 所有 Agent 默认共享一个 token | 拿到 token 即可冒充任意 agent_id 注册，Hub 只警告 | 生产为每台 Agent 配独立 token；冒充只会被审计记录，不拒绝 |
| 2 | token 明文存在于 Agent 机器 | Agent 机器被 root 拿下 = token 泄漏 | 0600 文件；token 与用户密码分离 |
| 3 | 静态 token，无轮换机制 | 长期有效，泄漏后难以吊销单台 | 轮换 = 改 hub.json 的 hash + 所有 Agent 配置，属运维动作 |
| 4 | 无 mTLS / 无客户端证书 | 无 per-agent 强身份 | 共享 token 是当前身份模型 |
| 5 | Hub 自身不终止 TLS | nginx↔Hub 段明文 | 反代与本机回环部署；生产把 Hub 绑回环地址或防火墙隔离 |
| 6 | `FILEBOX_ALLOW_INSECURE_HUB=1` | 明文链路，token/文件内容可嗅探 | 仅本地开发；生产不得设置 |
| 7 | Hub 信任 Agent 的文件数据 | Agent 返回什么前端看到什么 | 读权限本来就是 Agent 的；信任边界在 Agent 主机 |
| 8 | 无逐请求的 Hub→Agent 消息签名 | 仅 TLS 完整性保护 | 依赖 TLS 通道本身（webpki-roots 校验） |
| 9 | token 受 bcrypt 72 字节限制 | 超长 token 校验行为不直观 | 生成 token 时控制长度 ≤72 字节 |
| 10 | 远程终端存在（2FA 门控） | 未配 agent 侧 secret 时，Hub 被攻破 = 在 Agent 主机执行任意命令；即使配了，Hub 可在码的 ~90s 窗口内搭便车 | agent.toml 设 `terminal_totp_secret` 开启 agent 本地校验 + 防重放；审计四个 terminal_* 事件；提高 Hub 本体防护 |

## 10. 一句话总结

> Agent 用「出站 WSS + rustls 证书校验 + 共享 bcrypt 校验的静态 token」向
> Hub 自证身份；Hub 用「会话 + CSRF + PoW」向浏览器自证身份；两者之间的
> 信任不对称——Agent 完全信任 Hub 的控制消息，Hub 完全信任 Agent 的数据
> 响应，而**真正的纵深防御在 Agent 侧**：root 白名单、canonicalize 防逃逸、
> denylist、只读打开、唯一写路径（temp 文件夹）+ 配额。唯一的命令执行通道
> 是 2FA 门控的远程终端（ticket 校验在浏览器侧，Agent 不验 2FA）。整条
> 链路的健壮性靠双向心跳、分层超时、退避重连和资源上限兜底。
