# Preview

Click a file to preview it in the workspace without downloading to your laptop first. Desktop uses a multi-tab workspace; on phones preview swaps full-screen.

## Images

Zoom and pan; the toolbar adjusts scale.

![Image preview plot.png](/screenshots/08-preview-image.png)

## Markdown / text

Markdown is rendered; plain text and code use a syntax-highlighted editor (read-only: find, wrap).

![Markdown preview](/screenshots/08b-preview-markdown.png)

![Code preview hello.py](/screenshots/08c-preview-code.png)

## PDF

Built-in PDF viewer with Adaptive / percentage zoom. The demo dataset’s `demo-report.pdf` is a multi-page synthetic lab report (tables, multi-panel figures, equations) so the preview looks realistically dense.

![PDF preview](/screenshots/08d-preview-pdf.png)

## CSV / TSV

Table rendering with row/column counts and delimiter; toggle Raw / Copy.

![CSV preview](/screenshots/08e-preview-csv.png)

## Office (optional)

Word / PowerPoint convert to PDF on the Agent via LibreOffice; spreadsheets export one CSV per sheet. Requires `FILEBOX_AGENT_SOFFICE` — see [Office preview](/en/ops/office).

![PowerPoint → PDF preview](/screenshots/08f-preview-office.png)

Settings has an **Office preview** toggle (browser-local preference, on by default).

## Supported types

| Type | Behavior |
|------|----------|
| Images | Zoom / pan (including TIFF) |
| PDF | Built-in viewer |
| Markdown | Rendered |
| Code / text / logs | Monaco read-only |
| HTML | Sandboxed session |
| CSV / TSV | Table |
| Word / PPT | Optional: Agent-side → PDF |
| Excel / ODS | Optional: each sheet → CSV |

## Tips

- Desktop multi-tab; close/switch; keyboard shortcuts supported.
- Very large files ask before loading so the browser stays responsive.
- Use **Download** from the preview bar.
- Without `soffice`, Office files remain downloadable but preview is unavailable.
