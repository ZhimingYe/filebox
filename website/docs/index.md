---
layout: home
title: filebox 文档
hero:
  name: filebox
  text: 从任意浏览器，看服务器上的结果
  tagline: 只读远程文件浏览器 · Hub + Agent · 无需公网 IP / 入站端口 / VPN
  image:
    src: /screenshots/00-sidebar-overview.png
    alt: filebox 界面总览（演示）
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 功能导览
      link: /features/browse
    - theme: alt
      text: 在线演示
      link: https://zhimingye.github.io/filebox/
features:
  - title: 浏览与预览
    details: 大目录流畅列表、面包屑、钉选；图 / PDF / 代码 / Markdown / CSV / Office 就地预览，不必先 scp 一整份。
  - title: 搜索与合集
    details: 按文件名或内容正则搜索；用合集把分散路径里的文件虚拟编组，无需复制或移动。
  - title: 安全默认
    details: 协议只读；敏感文件默认拒绝；可选 Transfer 与 TOTP 终端，密钥只留在 Agent。
---

## 一眼看懂架构

```text
浏览器 ──HTTPS──▶ Hub ◀──WSS（出站）── Agent ──▶ 本地文件
```

| 组件 | 作用 |
|------|------|
| **浏览器** | 只访问 Hub，不直连 Agent。桌面 / 手机 / 平板均可。 |
| **Hub** | 认证用户、托管前端、把请求路由到对应机器。 |
| **Agent** | 装在目标机上，**主动出站**连 Hub。目标机无需公网 IP、入站端口或 VPN。 |

## 文档怎么读

1. [什么是 filebox](/guide/introduction) — 定位与安全边界  
2. [快速开始](/guide/quick-start) — 四步跑通  
3. [怎么用](/features/browse) — 带截图的功能说明  
4. [运维](/ops/hub) — HTTPS、更新、Office、FAQ  

当前版本对齐 **v2.1.0**（Hub + Agent）。截图主要来自[在线演示](https://zhimingye.github.io/filebox/)的 mock UI；与真实前端的差异会在各页注明。
