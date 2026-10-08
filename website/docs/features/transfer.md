# Transfer

**Transfer** is the only path the Agent allows writes to: a dedicated scratch directory. The browse protocol stays read-only; use this for temporary small uploads (drafts, screenshots, dropping a config for a colleague).

![Transfer empty / drop zone](/screenshots/04-transfer.png)

![Uploaded plain.txt](/screenshots/04b-transfer-uploaded.png)

## How to use

1. Open **Transfer** (requires Agent `temp_upload` capability).
2. Drop files on the dashed box, click to choose, or paste images.
3. Upload progress shows above the list; successes appear in the table below.
4. **Copy path**, download, or **Clean** the scratch folder.
5. The page header shows the real folder path on the Agent.

## Rules

| Rule | Detail |
|------|--------|
| Per-file limit | ~20 MiB by default (Agent capability / config) |
| Total quota | ~1 GiB by default |
| Overwrite | Same-name overwrite forbidden |
| Visibility | This directory **does not** appear as a normal root in Files |

Related: [Security & sensitive files](./security)
