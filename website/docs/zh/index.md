---
layout: home
title: filebox 文档
hero:
  name: filebox
  text: 从任意浏览器，看服务器上的结果
  tagline: 只读远程文件浏览器 · Hub + Agent · 无需公网 IP 或入站端口
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/quick-start
    - theme: alt
      text: 功能导览
      link: /zh/features/browse
    - theme: alt
      text: GitHub
      link: https://github.com/ZhimingYe/filebox
heroShot:
  alt: filebox 真实界面：6 个预览标签同时打开，当前为多页 PDF 实验报告（相关性热图与 QC 表格）
  caption: 真实 Hub + Agent 界面 · 多标签同时打开 PDF、图、代码、CSV、Markdown 与 PPT
  link: /zh/features/tabs
  linkText: 了解多标签预览
features:
  - title: 浏览与预览
    details: 通过面包屑与钉选浏览大目录，就地预览图片、文档、代码、笔记本与表格。
    link: /zh/features/preview
    linkText: 预览类型
  - title: 多标签工作区
    details: 同时打开报告、图、代码与表格，使用熟悉的标签操作切换、固定和关闭预览。
    link: /zh/features/tabs
    linkText: 多标签用法
  - title: 搜索与合集
    details: 按文件名或内容正则搜索，将不同路径的文件归入合集，无需复制或移动。
    link: /zh/features/search
    linkText: 搜索与合集
  - title: AI Agents 编码代理
    details: 读取编码代理输出、发送经审核的提示词、使用快捷键配置，按 Agent 管理集成。
    link: /zh/features/ai-agents
    linkText: 使用编码代理
  - title: 安全默认
    details: 只读浏览，敏感路径默认拒绝访问。Transfer 使用专用临时目录；AI Agents 为独立的后端集成。
    link: /zh/features/security
    linkText: 安全模型
---

## 一眼看懂架构

```text
浏览器 ──HTTPS──▶ Hub ◀──WSS（出站）── Agent ──▶ 本地文件
```

| 组件 | 作用 |
|------|------|
| **浏览器** | 只访问 Hub，不直连 Agent。桌面 / 手机 / 平板均可。 |
| **Hub** | 认证用户、托管前端、把请求路由到对应机器。 |
| **Agent** | 装在目标机上，**主动出站**连 Hub。目标机无需公网 IP 或入站端口。 |

## 文档怎么读

1. [什么是 filebox](/zh/guide/introduction) — 定位与安全边界  
2. [快速开始](/zh/guide/quick-start) — 四步跑通  
3. [首次登录](/zh/guide/first-login) — PoW 登录、选 Agent、Add Root  
4. [怎么用](/zh/features/browse) — 带真实界面截图的功能说明  
5. [运维](/zh/ops/hub) — HTTPS、更新、Office、FAQ  

当前版本对齐 **v3.1.0**（Hub + Agent）。本站截图全部来自本地真实运行的 Hub + Agent 界面，与你部署后看到的产品一致。
