---
layout: home
title: filebox Docs
hero:
  name: filebox
  text: See server results from any browser
  tagline: Read-only remote file browser · Hub + Agent · No public IP or inbound ports
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: Feature tour
      link: /features/browse
    - theme: alt
      text: GitHub
      link: https://github.com/ZhimingYe/filebox
heroShot:
  alt: Real filebox UI with six preview tabs open; the active tab is a multi-page PDF lab report with a correlation heatmap and QC table
  caption: Real Hub + Agent UI · PDF, figure, code, CSV, Markdown and PPT open side by side in tabs
  link: /features/tabs
  linkText: See multi-tab preview
features:
  - title: Browse & preview
    details: Smooth large-directory listing, breadcrumbs, pins; preview images / PDF / code / Markdown / Quarto·Rmd / HTML / Jupyter notebooks / CSV / Office in place — no need to scp an entire tree first.
    link: /features/preview
    linkText: Preview types
  - title: Multi-tab workspace
    details: Keep reports, figures, code and tables open together; switch, pin and bulk-close them like browser tabs. Esc closes, ← / → steps through the folder.
    link: /features/tabs
    linkText: Using tabs
  - title: Search & collections
    details: Search by filename or content regex; group files across scattered paths into virtual collections without copying or moving them.
    link: /features/search
    linkText: Search & collections
  - title: Secure by default
    details: Read-only protocol; sensitive paths denied by default; optional Transfer and TOTP-gated Terminal keep secrets on the Agent.
    link: /features/security
    linkText: Security model
---

## Architecture at a glance

```text
Browser ──HTTPS──▶ Hub ◀──WSS (outbound)── Agent ──▶ local files
```

| Component | Role |
|-----------|------|
| **Browser** | Talks only to the Hub, never directly to Agents. Desktop / phone / tablet all work. |
| **Hub** | Authenticates users, serves the frontend, routes requests to the right machine. |
| **Agent** | Runs on each target host and **dials out** to the Hub. Targets need no public IP or inbound ports. |

## How to read these docs

1. [What is filebox](/guide/introduction) — positioning and security boundaries  
2. [Quick start](/guide/quick-start) — four steps to a working setup  
3. [First login](/guide/first-login) — PoW login, pick an Agent, Add Root  
4. [How to use](/features/browse) — feature guides with real UI screenshots  
5. [Ops](/ops/hub) — HTTPS, updates, Office, FAQ  

Docs align with **v2.2.0** (Hub + Agent). Screenshots on this site were captured from a live Hub + Agent session — the same product you get after deploying.
