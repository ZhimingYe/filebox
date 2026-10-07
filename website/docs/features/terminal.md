# 远程终端 Terminal

可选功能：在浏览器里开 Agent 本机的交互式 shell。**未沙箱**——能做该 OS 用户能做的一切。务必只在可信环境启用。

![Remote Terminal](/screenshots/05-terminal.png)

## 启用 2FA（Agent 本机）

密钥只存在 Agent 上；Hub **只转发**验证码做本地校验，从不保存 TOTP 密钥。

```bash
./agent --setup-terminal-2fa
# 或指定配置：
./agent --setup-terminal-2fa --config /path/agent.toml
```

按向导把密钥写入 Authenticator 后，**重启 Agent**。也可用环境变量 `FILEBOX_AGENT_TERMINAL_TOTP_SECRET`（base32，至少 16 字节；环境变量优先；无效值会导致启动失败，不会静默降级）。

每次打开 / 恢复会话都要提交新的 TOTP。

## 会话

- 浏览导航、断线、Hub 重启、空闲后 shell 仍可 **Resume**。
- 用 Sessions → **Resume** 重连，或 **End** 结束。
- Agent **进程重启**会丢失会话；回放最近约 **256 KiB** 输出。

## 安全提醒

- 终端能力等于该 Agent 的 OS 用户权限。
- 不要在共享或不信任的机器上启用。
- 版本对齐：Hub / Agent / 前端大版本建议一起升（见 release notes）。

相关：[安全与敏感文件](./security) · [Agent 运维](/ops/agent)
