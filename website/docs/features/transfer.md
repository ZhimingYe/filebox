# 临时传输 Transfer

**Transfer** 是 Agent **唯一允许写入**的路径：把小文件拖到页面（或进入 Transfer 视图），写入专用 scratch 目录。不要把它当成网盘同步盘。

![Temp Transfer](/screenshots/04-transfer.png)

## 规则（摘要）

- 单组件文件名校验；默认单文件约 **20 MiB**、目录合计约 **1 GiB** 配额。
- **禁止覆盖**：冲突时自动加后缀。
- 一键清空；该目录**不会**作为普通 root 出现在 Files 里。
- 支持粘贴图片上传（剪贴板）。
- 由能力位 `temp_upload` 控制是否在 UI 显示。

## 和只读模型的关系

Files 浏览协议仍然只读。写文件只发生在 Transfer；任意 shell 只发生在 [Terminal](./terminal)。详见 [安全与敏感文件](./security)。
