# 合集 Collections

合集是**虚拟引用列表**：把分散在不同目录（甚至不同 root）里的文件收进一个命名列表，不复制、不移动。列表存在 Agent 上。

![Collections：watchlist](/screenshots/03-collections.png)

![从合集打开预览](/screenshots/03b-collections-watchlist.png)

## 怎么用

1. 侧栏打开 **Collections**。
2. 用下拉选择已有合集，或 **+ New** 创建。
3. 在 **Files** / 预览里把文件加入合集（合集选择器）。
4. 在合集视图中：并排查看、移除项、或跳回原始路径。
5. **Delete** 只删除合集本身，不动真实文件。

## 说明

- 合集项按 `(root, path)` 引用文件；源文件移动后该项不再指向它，磁盘内容保持不变。
- Agent 离线时 Hub 会把变更标为 pending，重连后再应用。
- 需要 Agent 具备 `collections` 能力（当前发布版默认具备）。
