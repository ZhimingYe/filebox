# 发布到 GitHub Pages（站点根目录 `/filebox/`）

文档站即首页：`https://zhimingye.github.io/filebox/`（English，默认）与 `https://zhimingye.github.io/filebox/zh/`（中文）。
旧地址由 gh-pages 上的跳转页重定向（保留子路径、查询串与锚点）：

| 旧地址 | 新地址 |
|--------|--------|
| `/filebox/en/<p>` | `/filebox/<p>` |
| `/filebox/docs/en/<p>` | `/filebox/<p>` |
| `/filebox/docs/<p>` | `/filebox/zh/<p>` |

## 当前采用的方案（不改 Pages 分支规则）

1. 在 `main` 维护 `website/` 源码（VitePress `base: '/filebox/'`；英文在 `docs/`，中文在 `docs/zh/`）。
2. `cd website && npm ci && npm run build`
3. 在 **gh-pages** 分支：根目录内容替换为 `docs/.vitepress/dist/*`，保留 `.github/workflows/pages.yml` 与 `.nojekyll`。
4. 生成旧地址跳转页：`node scripts/gen-legacy-redirects.mjs docs/.vitepress/dist <gh-pages 目录>`（写入 `docs/**` 与 `en/**`）。
5. 修复 GitHub Pages 对 cleanUrls 尾斜杠的 404：`node scripts/fix-clean-url-slashes.mjs <gh-pages 目录>`（为每个页面写入 `page/index.html` 跳转到无尾斜杠 URL，并为 `guide/` / `features/` / `ops/` 写入栏目首页跳转）。
6. 推送 `gh-pages`。

跳转页内容：`<link rel="canonical">` + `<meta http-equiv="refresh">` + 一段 JS（保留 `?query` 与 `#hash`）。
未列出的旧路径落到根 `404.html`，其内联脚本（`.vitepress/config.mts` 的 `LEGACY_REDIRECT`）按上表转发。

本地预览：

```bash
cd website && npm run build
npx vitepress preview docs   # http://localhost:4173/filebox/
```

## 可选：合并进 CI（草案）

见 `pages-docs.workflow.draft.yml`。注意：当前 Settings → Pages 部署分支只允许 gh-pages。若 workflow 改从 main
触发，必须同步放宽 Environment deployment branches，或继续用「只在 gh-pages 上提交已构建站点」双步发布。
