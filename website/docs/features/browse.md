# Browse files

After selecting an Agent, open **Files**: Agents and nav on the left, a virtualized file list in the middle, and (on desktop) multi-tab preview on the right.

![Files root](/screenshots/01-files-browse.png)

## Layout

| Area | Contents |
|------|----------|
| Sidebar Agents | Connected machines, online status, latency; click to switch Agent |
| Sidebar Workspace | Files / Explorer / Collections / Transfer / Terminal / Search / Settings / System |
| Root dropdown | Switch enabled roots (e.g. `demo`) |
| Toolbar | Refresh, filter, sort, tree panel, pin, copy path, … |
| Address / breadcrumbs | Current path; paste paths and completion supported |
| File list | Name, modified time, size; type badges; recent-change highlight |
| Preview pane | Click a file to preview; [multi-tab](/features/tabs) on desktop |

![Sidebar overview](/screenshots/00-sidebar-overview.png)

![figures directory](/screenshots/01b-files-figures.png)

![reports long filenames](/screenshots/01c-files-reports.png)

## Step by step

1. Select an Agent → click **Files**.
2. Pick an added root from the dropdown.
3. Click a folder to enter; use `..` or breadcrumbs to go up.
4. Click a file: a preview tab opens on the right (image, PDF, code, Markdown, CSV, …).
5. Optionally open the tree panel from the toolbar, or **Pin** the current folder to the sidebar.

## Tips

- **Filter**: narrow large directories by name pattern or modified time.
- **Sort**: click column headers for name / modified / size.
- **Remember location**: refresh returns to the last directory; Pins jump in one click.
- **Download**: use **Download** in the preview pane; browsing never modifies remote files.
- **Mobile**: drawer sidebar; list and preview swap full-screen. See [First login · Mobile](/guide/first-login).

## Related

- Preview types: [Preview](./preview)
- Tree-first browsing: [Explorer](./explorer)
- No roots yet? [Add Root](/guide/first-login)
