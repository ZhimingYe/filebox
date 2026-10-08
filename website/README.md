# filebox user docs (VitePress)

Bilingual how-to docs (中文 default + English `/en/`), built and published as the GitHub Pages site root.

- Docs (zh): https://zhimingye.github.io/filebox/
- Docs (en): https://zhimingye.github.io/filebox/en/
- Old `https://zhimingye.github.io/filebox/docs/...` links redirect to the matching page (stubs on gh-pages).

## Develop

```bash
cd website
npm install
npm run dev
```

## Build

```bash
npm run build   # output: docs/.vitepress/dist  (base: /filebox/)
```

## Publish (short-term)

Without changing Pages branch rules:

1. `npm run build`
2. On the **gh-pages** branch, replace everything at the root with `docs/.vitepress/dist/*`
   — but keep `.github/`, `.nojekyll`, and the `docs/` redirect stubs
3. Push `gh-pages`; existing `pages.yml` deploys

See [GH_PAGES_INTEGRATION.md](./GH_PAGES_INTEGRATION.md).

## Screenshots

```bash
# Needs local Chrome + puppeteer-core (see scripts) and a live dev Hub+Agent
/tmp/pdfvenv/bin/python scripts/gen-demo-report-pdf.py   # rich PDF + figures/*.png (reportlab + matplotlib)
python3 scripts/gen-demo-extras.py                       # code / CSV / Markdown for multi-tab shots
npm run screenshots                                      # general UI shots
node scripts/capture-tabs.mjs                            # multi-tab shots, 08d PDF, homepage hero (WebP via Pillow)
```

Screenshots land in `docs/public/screenshots/` from a **live** Hub+Agent (`FILEBOX_DEV_MODE`). List: [SHOT_LIST.md](./SHOT_LIST.md).

The homepage hero is rendered by `docs/.vitepress/theme/HeroShot.vue` from the `heroShot` frontmatter in
`docs/index.md` / `docs/en/index.md`: a full-width framed screenshot under the hero text, with a tighter
preview-pane crop served to phones (`<picture>` art direction) so it stays legible on mobile.

Repo-root `docs/` remains developer runbooks (local-debugging, security model) and is not part of this site.
