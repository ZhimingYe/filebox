# Preview

Click a file to preview it in the workspace without downloading to your laptop first. Desktop uses a [multi-tab workspace](/features/tabs); on phones preview swaps full-screen.

## Images

Zoom and pan; the toolbar adjusts scale.

![Image preview plot.png](/screenshots/08-preview-image.png)

## Markdown / text

Markdown is rendered; plain text and code use a syntax-highlighted editor (read-only: find, wrap).

![Markdown preview](/screenshots/08b-preview-markdown.png)

![Code preview hello.py](/screenshots/08c-preview-code.png)

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

## Supported types

| Type | Behavior |
|------|----------|
| Images | Zoom / pan (including TIFF) |
| PDF | Built-in viewer |
| Markdown | Rendered |
| Code / text / logs | Monaco read-only |
| Quarto / R Markdown (`.qmd` / `.rmd`) | Monaco source view |
| HTML | Sandboxed session |
| Jupyter notebook (`.ipynb`) | Hub-washed HTML in the same sandboxed session (read-only; mid-size png/jpeg mildly recompressed; oversized omitted) |
| CSV / TSV | Table |
| Word / PPT | Optional: Agent-side → PDF |
| Excel / ODS | Optional: each sheet → CSV |

## Tips

- Desktop multi-tab: keep several files open, switch, pin, close in bulk; `Esc` closes the active tab, `←` / `→` step through the folder. See [Multi-tab preview](/features/tabs).
- Very large files ask before loading so the browser stays responsive.
- Use **Download** from the preview bar.
- Without `soffice`, Office files remain downloadable but preview is unavailable.
