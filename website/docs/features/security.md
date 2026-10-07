# 安全与敏感文件

filebox 的默认姿态是：**浏览只读、路径牢笼、敏感文件拒绝**。两个写能力（Transfer、Terminal）是显式例外，且默认需要能力开启 / 本地配置。

![侧栏总览 — 能力入口一目了然](/screenshots/00-sidebar-overview.png)

## 只读协议

浏览路径没有写 / 删 / 重命名 / 任意 exec 消息。

| 例外 | 作用域 | 防护 |
|------|--------|------|
| **Transfer** | 仅 Agent 专用 scratch 目录 | 配额、禁覆盖、不作为普通 root |
| **Terminal** | Agent 本机 shell（**非沙箱**） | Agent 本地 TOTP；密钥不进 Hub |

## 敏感文件默认拒绝（节选）

即使根目录已授权，匹配项仍不可读：

```text
.git/  .ssh/  .gnupg/  .aws/  .kube/
.env*  *.pem  *.key  id_*  credentials*.json  *.sqlite*
```

以及 shell history 等常见凭证位置。具体规则以当前版本实现为准。

## 路径牢笼

浏览严格限制在已添加的 root 内；`..`、符号链接逃逸等会被挡住。

## 认证与信任

- 用户登录在 Hub；每台机器用独立 Agent token（Hub 只存 hash）。
- Agent 出站连 Hub；目标机无需入站。
- 生产环境务必 HTTPS，保护 token 与会话。

## 架构向说明

更底层的 Hub↔Agent 信任边界、token、限流等见仓库内开发文档
[`docs/hub-agent-security-model.md`](https://github.com/ZhimingYe/filebox/blob/main/docs/hub-agent-security-model.md)（中文）。
