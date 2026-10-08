# 临时传输 Transfer

**Transfer** 是 Agent 上唯一允许写入的路径：专用 scratch 目录。浏览协议仍然只读；这里只用于临时上传小文件（草稿、截图、给同事丢个配置等）。

![Transfer 空状态 / 拖放区](/screenshots/04-transfer.png)

![已上传 plain.txt](/screenshots/04b-transfer-uploaded.png)

## 怎么用

1. 侧栏打开 **Transfer**（需 Agent `temp_upload` 能力）。
2. 拖文件到虚线框，或点击选择；也可粘贴图片。
3. 上传进度显示在列表上方；成功后出现在下方表格。
4. 可 **Copy path**、下载；**Clean** 清空临时目录。
5. 页面顶部会显示 Agent 上的真实文件夹路径。

## 规则

| 规则 | 说明 |
|------|------|
| 单文件上限 | 默认约 20 MiB（以 Agent 能力 / 配置为准） |
| 总配额 | 默认约 1 GiB |
| 覆盖 | 禁止同名覆盖 |
| 可见性 | 该目录**不会**作为普通 root 出现在 Files 里 |

相关：[安全与敏感文件](./security)
