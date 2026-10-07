# Explorer 树形视图

**Explorer** 是与 Files 并列的可选工作区：以树展开目录，复用同一套预览、合集与路径复制。适合需要同时看见多层目录结构的场景。

![Files 布局参考（Explorer 与之共享预览与路径）](/screenshots/01-files-browse.png)

## 特点

- 虚拟滚动、并发目录加载上限、展开节点与 LRU 缓存有界。
- 离开视图会取消未完成加载，避免后台空转。
- 与 Files 共享「当前目录」位置：在一边导航，另一边会对齐。
- 搜索命中可 locate 到树节点（见 [工作区搜索](./search)）。

## 截图说明

当前 [在线演示](https://zhimingye.github.io/filebox/) 的 mock 侧栏未单独做 Explorer 页；上图为 Files 三栏布局，真实 Hub 前端的 Explorer 以树展开为主。后续可补真实机截图。

相关：[浏览文件](./browse) · [预览](./preview)
