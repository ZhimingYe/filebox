# filebox user docs (VitePress)

Bilingual how-to docs (中文 default + English `/en/`), built and published to GitHub Pages at `/filebox/docs/`, alongside the interactive demo at `/filebox/`.

- Docs (zh): https://zhimingye.github.io/filebox/docs/
- Docs (en): https://zhimingye.github.io/filebox/docs/en/
- Demo: https://zhimingye.github.io/filebox/

## Develop

```bash
cd website
npm install
npm run dev
```

## Build

```bash
npm run build   # output: docs/.vitepress/dist
```

## Publish (short-term)

Without changing Pages branch rules:

1. `npm run build`
2. Copy `docs/.vitepress/dist/*` into the **gh-pages** branch `docs/`
3. Push `gh-pages`; existing `pages.yml` deploys

See [GH_PAGES_INTEGRATION.md](./GH_PAGES_INTEGRATION.md).

## Screenshots

```bash
# Needs local Chrome + puppeteer-core (see scripts)
npm run screenshots
```

Screenshots land in `docs/public/screenshots/` from a **live** Hub+Agent (`FILEBOX_DEV_MODE`), not the Pages mock. List: [SHOT_LIST.md](./SHOT_LIST.md).

Generate the rich demo PDF used in preview shots:

```bash
# needs reportlab + matplotlib (venv ok)
python scripts/gen-demo-report-pdf.py
# writes /tmp/fbx_demo/reports/demo-report.pdf
```

Repo-root `docs/` remains developer runbooks (local-debugging, security model) and is not part of this site.
