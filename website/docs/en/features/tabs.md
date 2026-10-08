# Multi-tab preview

On desktop the preview area is a **multi-tab workspace**: keep a PDF report, figures, code, tables, Markdown, and Office documents open side by side, then switch, pin, and close them like browser tabs — no more bouncing back to the file list.

![Multi-tab preview: six tabs, active PDF report (correlation heatmap + QC table)](/screenshots/14-tabs-pdf.png)

## Opening tabs

- Click a file in **Files**, **Explorer**, or **Collections** to open it as a tab in the preview pane. Clicking another file **appends** a new tab and switches to it.
- A file (same Agent + root + path) **never gets two tabs**: clicking it again just re-activates its tab and does **not** reset where you were reading.
- **Open in preview pane** on a [workspace search](/en/features/search) hit also opens a tab; if the file already has one, it is re-fetched so you never look at stale content.
- With **one** tab there is no tab bar (it looks exactly like a single preview); the bar appears from the second tab on.
- All three views share the same tabs: tabs opened in Files are still there in Explorer / Collections.

## Switching tabs

![Switched to the code tab qc_pipeline.py (Monaco, read-only)](/screenshots/14b-tabs-code.png)

- **Click a tab** to switch; the active tab has a thin accent line on top. Tabs show the file name; hover for the full `root/path`.
- When tabs overflow, the strip scrolls horizontally and the active tab is always scrolled into view.
- The **count + ⌄** button at the right end of the strip (e.g. `6 ⌄`) opens the **Open previews** list with every open file name and full path — click to jump. Keyboard: `↑` / `↓` to move, `Home` / `End` for first / last, `Enter` to open, `Esc` to close.

![Open previews jump list](/screenshots/14e-tabs-picker.png)

![Switched to the image tab growth-kinetics.png (pinned)](/screenshots/14c-tabs-image.png)

## Pinning tabs

Each tab has a **pin** button next to its name:

| State | When you switch away and back |
|-------|-------------------------------|
| Unpinned (default) | The preview reloads: PDFs return to page 1, zoom and scroll reset. Background tabs cost nothing. |
| Pinned (pin turns solid accent) | The preview stays **mounted in the background** — switching back is instant and keeps PDF page / zoom, image zoom, code scroll position, etc. |

- Or right-click a tab → **Pin tab / Unpin tab**.
- Pinning is per tab; every pinned tab keeps using memory (HTML previews especially), so pin only what you compare repeatedly.
- Pinned tabs show a small pin in the Open previews list.

::: warning Known issue in v2.1.0
A pinned **PDF** tab can show through the active preview after you switch to another tab. If that happens, unpin the PDF (or close and reopen it); pinned tabs of other types are not affected.
:::

## Closing tabs

![Right-click tab menu](/screenshots/14d-tabs-context-menu.png)

- **×** on a tab closes that tab.
- **×** at the right of the preview header (tooltip *Close (Esc)*) closes the active tab.
- **Right-click a tab** for:
  - **Pin tab / Unpin tab**
  - **Close tab**
  - **Close tabs to the left** (disabled on the first tab)
  - **Close tabs to the right** (disabled on the last tab)
  - **Close all tabs**
- Closing the active tab activates its **neighbour** (the right one first, like browsers).

## Keyboard shortcuts

Active in Files / Explorer / Collections when focus is not in a text field:

| Key | Action |
|-----|--------|
| `Esc` | Close the active tab (closes the Search window first if open; with the tab menu / jump list open it only closes that) |
| `←` / `→` | **Files view only**: show the previous / next file of the same folder in the current tab (the list must be showing that folder). If the target already has a tab it is activated — your other tabs are never removed |
| `↑` `↓` `Home` `End` `Enter` `Esc` | Navigate the Open previews jump list |

## Preview width

Drag the divider between the file list and the preview pane (list 20 %–80 %); the ratio is stored in your browser. Widen the preview when you keep many tabs so more of the strip is visible.

## Behaviour and limits

- **Desktop only** (window ≥ 768 px wide). Phones / narrow windows keep the single-file "list ↔ full-screen preview" model without a tab bar.
- Tabs live in the current page only: **a reload or closing the page does not restore them**.
- **Switching Agent** closes all tabs (previews never outlive their machine); disabling / removing a root in Settings closes that root's tabs.
- No hard tab limit — unpinned background tabs hold no viewer resources; only pinned ones stay resident.
- The header's *Refresh preview* button re-reads the active tab's file; **Download** and copy-full-server-address act on the active tab.
- Tabs cannot be reordered by dragging; order is opening order.

## Related

- [Preview (image / PDF / code / tables)](/en/features/preview)
- [Browse files](/en/features/browse) · [Explorer](/en/features/explorer) · [Collections](/en/features/collections)
