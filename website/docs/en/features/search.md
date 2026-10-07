# Workspace search

Sidebar **Search** opens a floating panel (desktop) or bottom sheet (phone) and **does not replace** the main view. Search by filename, or regex over file contents.

![Filename search: REWIND → 5 hits](/screenshots/02b-search-results.png)

## Filename search (Find)

1. Open Search, mode **Files**.
2. Choose root and subpath (`/` means the whole root).
3. Enter a name fragment (e.g. `REWIND`), click **Search**.
4. Results show hits / scanned; you can Filter results further.
5. Preview with the eye icon, or open the file’s location.

## Content search (Content)

Switch mode to **Content** and enter a regex (e.g. `TODO|FIXME`). Hits show path, line number, and context with matches highlighted.

![Content search TODO|FIXME](/screenshots/02c-search-content.png)

## Options (optional)

Expand Options to set:

- Extension filters (comma / space separated, not globs)
- Context line count (Content mode)
- Max depth
- Ignored directory names (e.g. `node_modules`, `venv`, `renv`)

## Behavior and limits

- One search at a time per Agent; you can **Cancel** anytime.
- For large trees, narrow the path, add ignores, and limit depth.
- Progress streams over SSE; closing the panel does not force-kill a running request (use Cancel).
- Older Agents without `workspace_search` capability report unsupported.

Related: [Browse files](./browse) · [Collections](./collections)
