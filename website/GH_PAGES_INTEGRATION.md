# 发布到 GitHub Pages（站点根目录 `/filebox/`）

文档站即首页：`https://zhimingye.github.io/filebox/`（中文）与 `https://zhimingye.github.io/filebox/en/`（English）。
旧的静态演示页已移除；旧链接 `https://zhimingye.github.io/filebox/docs/...` 由 gh-pages 上的跳转页重定向到新地址（保留子路径、查询串与锚点）。

## 当前采用的方案（不改 Pages 分支规则）

1. 在 `main` 维护 `website/` 源码（VitePress `base: '/filebox/'`）。
2. `cd website && npm ci && npm run build`
3. 在 **gh-pages** 分支：根目录内容替换为 `docs/.vitepress/dist/*`，保留：
   - `.github/workflows/pages.yml`（push gh-pages 自动部署）
   - `.nojekyll`
   - `docs/`：旧地址跳转页（每个页面一个 `docs/<path>.html` + `docs/<path>/index.html`，以及 `docs/404.html` 兜底）
4. 推送 `gh-pages`。

跳转页内容：`<link rel="canonical">` + `<meta http-equiv="refresh">` + 一段 JS，把 `/filebox/docs/<rest>` 改写为 `/filebox/<rest>`（含 `/docs/en/...`）。
未列出的旧路径落到根 `404.html`，其内联脚本同样会把 `/filebox/docs/...` 转到新地址。

本地预览：

```bash
cd website && npm run build
npx vitepress preview docs   # http://localhost:4173/filebox/
```

## 可选：合并进 CI（草案）

见 `pages-docs.workflow.draft.yml`。注意：当前 Settings → Pages 部署分支只允许 gh-pages。若 workflow 改从 main
触发，必须同步放宽 Environment deployment branches，或继续用「只在 gh-pages 上提交已构建站点」双步发布。
