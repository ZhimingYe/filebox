# Preview

Click a file to preview it in the workspace without downloading to your laptop first. Desktop uses a [multi-tab workspace](/features/tabs); on phones preview swaps full-screen.

## Images

Zoom and pan; the toolbar adjusts scale.

![Image preview plot.png](/screenshots/08-preview-image.png)

## Markdown / text

Markdown is rendered; plain text and code use a syntax-highlighted editor (read-only: find, wrap).

![Markdown preview](/screenshots/08b-preview-markdown.png)

![Code preview hello.py](/screenshots/08c-preview-code.png)

## Quarto / R Markdown

`.qmd`, `.rmd`, and `.rmarkdown` open in the same read-only Monaco viewer with a custom `quarto` language — not download-only. Highlighting covers YAML / Quarto front matter, fenced chunks such as `{r}` / `{python}` (and plain fence language tags), optional `:::` fenced divs, and inline `` `r …` `` / `` `python …` ``. Chunk bodies reuse Monaco’s built-in highlighters for R, Python, Julia, SQL, shell, YAML, and similar. Plain `.md` still uses the rendered Markdown preview. A rich knitr-aware rendered Rmd view is a follow-up — this release is source highlighting only. File-list badges use the R colour category (RMD / QMD).

![Quarto source preview qc-methods.qmd](/screenshots/08g-preview-quarto.png)

## PDF

Built-in PDF viewer with Adaptive / percentage zoom (50 %–200 %) and continuous multi-page scrolling. The demo dataset’s `demo-report.pdf` is a 6-page synthetic lab report (tables, multi-panel figures, a correlation heatmap, equations) so the preview looks realistically dense.

![PDF preview](/screenshots/08d-preview-pdf.png)

## CSV / TSV

Table rendering with row/column counts and delimiter; toggle Raw / Copy.

![CSV preview](/screenshots/08e-preview-csv.png)

## Office (optional)

Word / PowerPoint convert to PDF on the Agent via LibreOffice; spreadsheets export one CSV per sheet. Requires `FILEBOX_AGENT_SOFFICE` — see [Office preview](/ops/office).

![PowerPoint → PDF preview](/screenshots/08f-preview-office.png)

Settings has an **Office preview** toggle (browser-local preference, on by default).

## HTML

`.html` / `.htm` open in a **sandboxed preview session** (directory-scoped bearer token, TTL, per-session request/byte limits) — not a raw same-origin iframe. In document mode the Hub injects a locked absolute `<base>`, CSP and charset meta, and fixes anchors on navigation so relative links between files and in-page `#fragment` links work inside the sandbox; `../` is a hard boundary. Subresource / HEAD / XHR stay in locked-down raw mode. Document-mode CSP allows `data:` on `script-src` and `style-src`, so self-contained Quarto / Pandoc `data:text/css` stylesheets and `data:application/javascript` module scripts render with their intended fonts and layout (network egress remains limited to the tokenized preview origin). Use **Source** for the HTML source; open-in-new-window uses the same sandboxed pattern. Documents over 64 MiB are refused; like other HTML-class previews, files at or above 2 MiB ask for confirmation before loading.

![HTML preview quarto-user.html](/screenshots/08i-preview-html.png)

## Jupyter notebook (`.ipynb`)

Notebooks open through Filebox’s sandboxed HTML preview: the Hub washes nbformat JSON into a self-contained HTML document (markdown cells, code cells with execution counts, stream / error text with ANSI stripped, and png / jpeg / svg outputs). Mid-size png/jpeg payloads (decoded above ~350 KiB) get mild server-side recompression / downscale before embedding; payloads that remain above ~1.5 MiB are omitted with a note. Raw HTML, widgets, and JavaScript outputs are not rendered. This is **not** an interactive Jupyter runtime — read-only preview only. Large notebooks may ask for confirmation before loading (same oversized-file gate as other HTML-class previews).

![Jupyter notebook preview qc-recovery.ipynb](/screenshots/08h-preview-ipynb.png)

## Supported types

| Type | Behavior |
|------|----------|
| Images | Zoom / pan (including TIFF) |
| PDF | Built-in viewer |
| Markdown | Rendered |
| Code / text / logs | Monaco read-only |
| Quarto / R Markdown (`.qmd` / `.rmd` / `.rmarkdown`) | Monaco source view (`quarto` language; YAML + chunks; not rendered) |
| HTML (`.html` / `.htm`) | Sandboxed session (locked `<base>` + CSP; relative / `#fragment` links; `data:` CSS/JS for self-contained Quarto/Pandoc; 64 MiB hard cap; 2 MiB confirm) |
| Jupyter notebook (`.ipynb`) | Hub-washed HTML in the same sandboxed session (read-only; mid-size png/jpeg mildly recompressed; oversized omitted; no widgets/JS) |
| CSV / TSV | Table |
| Word / PPT | Optional: Agent-side → PDF |
| Excel / ODS | Optional: each sheet → CSV |

## Tips

- Desktop multi-tab: keep several files open, switch, pin, close in bulk; `Esc` closes the active tab, `←` / `→` step through the folder. See [Multi-tab preview](/features/tabs).
- Very large files ask before loading so the browser stays responsive.
- Click the path in the preview header to jump the file browser to that file's containing folder.
- Use **Download** from the preview bar.
- Without `soffice`, Office files remain downloadable but preview is unavailable.
