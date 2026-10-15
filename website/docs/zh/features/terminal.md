# 远程终端 Terminal

可选功能：在浏览器里开 Agent 本机的交互式 shell。**未沙箱**——能做该 OS 用户能做的一切。务必只在可信环境启用。

![Terminal：等待 TOTP](/screenshots/05-terminal.png)

![输入 6 位验证码](/screenshots/05b-terminal-code.png)

![已打开会话并执行命令](/screenshots/05d-terminal-session.png)

## 启用 2FA（Agent 本机）

密钥只存在 Agent 上；Hub **只转发**验证码做本地校验，从不保存 TOTP 密钥。

```bash
./agent --setup-terminal-2fa
# 或指定配置：
./agent --setup-terminal-2fa --config /path/agent.toml
```

按向导把密钥写入 Authenticator 后，**重启 Agent**。

也可用环境变量（适合自动化；环境变量优先；无效值会导致启动失败，不会静默降级）：

```bash
export FILEBOX_AGENT_TERMINAL_TOTP_SECRET="BASE32SECRET……"  # ≥16 字节解码后
```

## 打开 / 恢复会话

1. 侧栏 **Terminal**。
2. 输入当前 6 位 TOTP → **Open terminal**（或 Resume）。
3. 每次打开 / 恢复都要**新的**验证码；用过的码会被拒绝，等下一个 30s 窗口。
4. **Sessions** 可 Refresh、Resume、End。
5. **New session** 再开一个 shell。

## 手机和平板

浅色工具栏使用带无障碍名称和桌面悬停提示的图标：文本输入、键盘、最新输出和专注模式。桌面默认收起辅助键，点击 **Terminal keys** 展开；手机的 **New session** 使用加号图标。

- **Focus** 将当前终端扩展到可见屏幕，随软键盘调整高度；**Exit focus** 返回普通布局，过程中不重新连接。横屏和平板仍保留触控按键。
- **Keyboard** 聚焦终端或文本框，**Hide** 收起键盘，**Latest** 回到最新输出，不向远端发送输入。
- 手指滑动终端可翻阅历史，新增输出不会把已上翻的视图强行拉回底部。历史滚动有短暂惯性（遵循“减少动态效果”设置），再次触摸或键盘操作会停止惯性；全屏终端程序使用 xterm 的滚轮行为，松手后不再惯性发送。保留双指缩放。
- **Text input** 提供原生文本框，方便中文等输入法和粘贴。**Insert** 发送已完成的文本，不额外添加回车；另点 **Enter** 提交命令。如果 shell 不支持括号粘贴模式，粘贴内容已有的换行仍可能执行命令。发送被拒绝时草稿保留在当前面板；离开页面或重新验证前请先复制草稿。
- Esc、Tab、Ctrl、Alt、Ctrl+C、退格、Enter 和方向键排成紧凑单行；左右滑动按键条可找到其余按键。控件统一为紧凑的 28px，不额外增加隐藏的触控留白。Ctrl／Alt 单次生效，方向键适配终端程序的应用光标模式。
- 会话列表独立滚动。切换 App 或锁屏后连接失效，会显示原因并要求新的 Agent 验证码恢复，不会自动重发输入。

## 会话生命周期

- 浏览导航、断线、Hub 重启、空闲后 shell 仍可 **Resume**。
- Agent **进程重启**会丢失会话；回放最近约 **256 KiB** 输出。
- 登出浏览器会断开附着，但 shell 可继续跑，直到 End 或 Agent 重启。

## 安全提醒

- 终端能力等于该 Agent 的 OS 用户权限。
- 不要在共享或不信任的机器上启用。
- Hub / Agent / 前端大版本建议一起升（见 release notes）。

相关：[安全与敏感文件](./security) · [Agent 运维](/zh/ops/agent)
