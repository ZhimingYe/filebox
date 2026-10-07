---
layout: home
title: filebox Docs
hero:
  name: filebox
  text: See server results from any browser
  tagline: Read-only remote file browser · Hub + Agent · No public IP / inbound ports / VPN
  image:
    src: /screenshots/00-sidebar-overview.png
    alt: filebox real UI overview (Hub + Agent)
  actions:
    - theme: brand
      text: Quick start
      link: /en/guide/quick-start
    - theme: alt
      text: Feature tour
      link: /en/features/browse
    - theme: alt
      text: GitHub
      link: https://github.com/ZhimingYe/filebox
features:
  - title: Browse & preview
    details: Smooth large-directory listing, breadcrumbs, pins; preview images / PDF / code / Markdown / CSV / Office in place — no need to scp an entire tree first.
  - title: Search & collections
    details: Search by filename or content regex; group files across scattered paths into virtual collections without copying or moving them.
  - title: Secure by default
    details: Read-only protocol; sensitive paths denied by default; optional Transfer and TOTP-gated Terminal keep secrets on the Agent.
---

## Architecture at a glance

```text
Browser ──HTTPS──▶ Hub ◀──WSS (outbound)── Agent ──▶ local files
```

| Component | Role |
|-----------|------|
| **Browser** | Talks only to the Hub, never directly to Agents. Desktop / phone / tablet all work. |
| **Hub** | Authenticates users, serves the frontend, routes requests to the right machine. |
| **Agent** | Runs on each target host and **dials out** to the Hub. Targets need no public IP, inbound ports, or VPN. |

## How to read these docs

1. [What is filebox](/en/guide/introduction) — positioning and security boundaries  
2. [Quick start](/en/guide/quick-start) — four steps to a working setup  
3. [First login](/en/guide/first-login) — PoW login, pick an Agent, Add Root  
4. [How to use](/en/features/browse) — feature guides with real UI screenshots  
5. [Ops](/en/ops/hub) — HTTPS, updates, Office, FAQ  

Docs align with **v2.1.0** (Hub + Agent). Screenshots on this site were captured from a live Hub + Agent session — the same product you get after deploying.
