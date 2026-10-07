# 系统监控

侧栏 **System** 打开 System Monitor：查看 Agent 主机的 CPU、内存、负载、用户与进程。

![System Monitor Overview](/screenshots/06-stats.png)

## 标签页

| 标签 | 内容 |
|------|------|
| Overview | 用户数、进程数、uptime、CPU / 内存卡片与进度条、load average |
| Users | 按用户的资源占用 |
| Processes | 进程表与详情 |
| Host | 主机信息 |

点 **Refresh** 手动刷新；数据来自 Agent 的 sysinfo（有短缓存 TTL）。

相关：点击侧栏版本号可看 Hub / Agent Diagnostics（[About](/guide/first-login)）。
