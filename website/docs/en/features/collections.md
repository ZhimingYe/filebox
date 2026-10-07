# Collections

A collection is a **virtual reference list**: group files from different directories (even different roots) under one name without copying or moving. Lists live on the Agent.

![Collections: watchlist](/screenshots/03-collections.png)

![Open preview from a collection](/screenshots/03b-collections-watchlist.png)

## How to use

1. Open **Collections** in the sidebar.
2. Pick an existing collection from the dropdown, or **+ New**.
3. From **Files** / preview, add files via the collection picker.
4. In the collection view: browse side by side, remove items, or jump to the original path.
5. **Delete** removes only the collection, not real files.

## Notes

- Items point at `(root, path)`; if the source moves, the item goes stale without touching disk.
- While the Agent is offline, Hub marks changes pending and applies them on reconnect.
- Requires Agent `collections` capability (on by default in current releases).
