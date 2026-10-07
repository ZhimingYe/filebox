# 发布到 GitHub Pages（`/filebox/docs/`）

目标：保留现有演示 `https://zhimingye.github.io/filebox/`（gh-pages 根目录
`index.html`），同时把本 VitePress 站点挂到
`https://zhimingye.github.io/filebox/docs/`。

## 当前采用的短期方案（不改 Pages 分支规则）

1. 在 `main` 维护 `website/` 源码。
2. `cd website && npm ci && npm run build`
3. 将 `docs/.vitepress/dist/*` **复制**到 **gh-pages** 分支的 `docs/`
4. 推送 `gh-pages`；现有 `.github/workflows/pages.yml`（push gh-pages）自动部署整站 artifact

演示根目录 `index.html` 保留不动（可另加「文档」导航链到 `/filebox/docs/`）。

本地预览：

```bash
cd website && npm run build
npx vitepress preview docs --base /filebox/docs/
# 或：python -m http.server -d docs/.vitepress/dist
```

## 可选：合并进 CI（草案）

见 `pages-docs.workflow.draft.yml`。触发建议：

- `push` to `gh-pages`（演示变更）
- `push` to `main` paths `website/**`（文档变更）
- `workflow_dispatch`

注意：当前 Settings → Pages 部署分支只允许 gh-pages。若 workflow 改从 main
触发，必须同步放宽 Environment deployment branches，或继续用「只在 gh-pages
上提交已构建的 `docs/`」双步发布。

## 尚未截的图（需本地 Hub+Agent）

- 登录页（PoW）
- Explorer 树视图
- Settings / Add Root
- Audit 登录审计
- 真实 Search 浮窗（非 mock 面板）
- Office → PDF 预览标签
- 手机抽屉布局

脚本：`npm run screenshots`（打公开演示 mock）。清单见 [SHOT_LIST.md](./SHOT_LIST.md)。
