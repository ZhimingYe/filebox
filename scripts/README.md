# scripts/

Helper scripts that live alongside the source. None of them are required to
use filebox — pre-built binaries and step-by-step instructions live on the
[Releases page](https://github.com/ZhimingYe/filebox/releases). These are
developer-facing tools.

## What's here

| Script | Who runs it | What it does |
|---|---|---|
| `release.sh` | Maintainer, on dev machine | Bumps workspace version, commits, tags `v{version}`, pushes. The pushed tag triggers `.github/workflows/release.yml` which builds the musl binaries and publishes a GitHub Release. |
| `gen_config.sh` | Anyone with the binary already downloaded | Generates `hub.json` or `agent.toml` from interactive prompts and prints to stdout. Uses `openssl` + `mkpasswd` for bcrypt hashing — no Python, no pip pollution. |
| `gen_notice.sh` | Maintainer, before a release | Generates the third-party license attribution manifests (`NOTICE` summary + `NOTICE.csv` per-package) for Rust (`Cargo.lock`) and the frontend (`package-lock.json`). Required because release binaries strip the upstream `LICENSE` files. |

## Releasing a new version

```bash
./scripts/release.sh v0.3.0
```

The script:
1. Bumps `version = "..."` under `[workspace.package]` in `Cargo.toml` (awk-tracked so it doesn't touch `[workspace.dependencies]`)
2. Refreshes `Cargo.lock` via `cargo check`
3. Commits "Release v0.3.0", tags `v0.3.0`, pushes both

GitHub Actions then builds `x86_64-unknown-linux-musl` binaries for hub and
agent, bundles the frontend into the hub tarball, generates `SHA256SUMS.txt`,
and publishes a Release with auto-generated notes. The whole flow takes
~5-8 minutes on a warm cache.

## Generating a config (after downloading a release tarball)

```bash
# Hub config — prints hub.json to stdout, prompts on stderr
./gen_config.sh hub > ~/.local/share/filebox/config/hub.json

# Agent config
./gen_config.sh agent > ~/filebox-agent/agent.toml
```

Requirements:
- `openssl` (for random token)
- `mkpasswd` (from the `whois` package, for bcrypt hashing)

If `mkpasswd` isn't installed, the script prints install hints for the
common package managers and exits.

## Regenerating the license attribution manifests

```bash
./scripts/gen_notice.sh              # both Rust + frontend
./scripts/gen_notice.sh rust         # Cargo.lock only  -> ./NOTICE(.csv)
./scripts/gen_notice.sh frontend     # package-lock.json only -> frontend/NOTICE(.csv)
```

This refreshes `NOTICE` + `NOTICE.csv` (Rust, repo root) and
`frontend/NOTICE` + `frontend/NOTICE.csv` (frontend). Run it whenever
`Cargo.lock` or `frontend/package-lock.json` changes meaningfully —
ideally as part of the release checklist.

Why this matters: filebox statically links its Rust dependencies into a
single binary and bundles the frontend through Vite, so the per-package
`LICENSE` files that crates.io / npm ship are no longer present in the
distributed artifact. The wide licenses used here (MIT, Apache-2.0, BSD,
ISC) literally require "include the license text in copies", and this
manifest is the lightweight way to stay compliant.

Requirements:
- `python3` (stdlib only — `urllib`, `json`, `re`, `concurrent.futures`)
- `npx` (for the frontend; pulls `license-checker` on first run)
- network access to `crates.io` for Rust license metadata

The project's own packages (`filebox-*`, `frontend`) are excluded from
the counts since they are MIT-licensed by the repo `LICENSE`.
`license-checker` misreports the `private: true` root package as
`UNLICENSED`; the script strips that row so the manifest reflects only
real third-party packages.

## What's NOT here anymore

The old `serve_at_server.sh` / `serve_at_client.sh` (build-from-source)
and `install_hub.sh` / `install_agent.sh` (download-from-release) scripts
were removed once the GitHub Release pipeline was in place. To install
filebox now:

1. Download the appropriate tarball from the
   [latest release](https://github.com/ZhimingYe/filebox/releases/latest)
2. Extract: `tar xzf filebox-{hub,agent}-VERSION-x86_64-musl.tar.gz`
3. Generate config: `./gen_config.sh {hub,agent} > config-file`
4. Run the binary

After installation, future manual upgrades can be done in place:

```bash
./bin/hub --update
./agent --update

# Or use a mirror / accelerator that exposes the same release files
./bin/hub --update --update-base-url https://your-mirror.example.com/filebox/releases/latest/download
./agent --update --update-base-url https://your-mirror.example.com/filebox/releases/latest/download

# Plain HTTP mirrors require an explicit override
./bin/hub --update --update-base-url http://your-mirror.example.com/filebox/releases/latest/download --allow-insecure-update
```

Downgrades are blocked by default. If you intentionally need to roll back to
an older release, add `--allow-downgrade`.

The release tarballs bundle a per-package `README.md` and a config
example (`hub.json.example` / `agent.toml.example`) that walk through
the specifics.
