# filebox 用户文档站（VitePress）

中文 how-to 文档，构建后部署到 GitHub Pages 的 `/filebox/docs/`，与 gh-pages 根目录的交互演示并存。

- 文档：https://zhimingye.github.io/filebox/docs/
- 演示：https://zhimingye.github.io/filebox/

## 开发

```bash
cd website
npm install
npm run dev
```

## 构建

```bash
npm run build   # 输出 docs/.vitepress/dist
```

## 发布（短期方案）

不改 Pages 分支规则时：

1. `npm run build`
2. 将 `docs/.vitepress/dist/*` 复制到 **gh-pages** 分支的 `docs/`
3. 推送 `gh-pages`；现有 `pages.yml` 自动部署

详见 [GH_PAGES_INTEGRATION.md](./GH_PAGES_INTEGRATION.md)。

## 截图

```bash
# 依赖本机 Chrome + 临时 puppeteer-core（见 scripts 注释）
npm run screenshots
```

截图写入 `docs/public/screenshots/`，主要来自
https://zhimingye.github.io/filebox/ 的 mock UI。清单见 [SHOT_LIST.md](./SHOT_LIST.md)。

仓库根目录 `docs/` 仍保留给开发者 runbook（local-debugging、安全模型），不经过本站点。
