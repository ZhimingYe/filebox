# FAQ

## No Agent in the sidebar?

Check in order:

1. Is the Agent process running (`ps` / systemd status)?
2. Can the Agent resolve the Hub hostname: on the Agent host `curl -v https://filebox.example.com/api/health`.
3. Is the Hub URL `https://` (or for dev, explicit `FILEBOX_ALLOW_INSECURE_HUB=1` + `ws://`)?
4. Does the token match what Hub `--init-config` printed (Hub stores only a hash — mismatch means re-issue / reconfigure)?
5. Does the reverse proxy upgrade WebSockets (`Upgrade` / `Connection`)? See [Hub ops](./hub).

## Agent online but empty file list?

Add a readable directory under **Settings → Add Root**. Invalid paths are rejected without harming existing config. See [First login](/en/guide/first-login).

![Add Root](/screenshots/11b-settings-add-root.png)

## Login stuck on Solving / Continue disabled?

PoW must finish first (Verification → Ready). If stuck: refresh the challenge, check `/api/pow/challenge` reachability, and whether IP rate limiting kicked in. See [First login](/en/guide/first-login).

![Login PoW](/screenshots/09-login.png)

## Search slow / cancelled?

For large trees, narrow the root, deepen ignore lists (`node_modules` / `venv`), lower depth; Cancel anytime. One search at a time per Agent. See [Search](/en/features/search).

## Some files won’t open?

Sensitive paths (`.ssh/`, `.env*`, `*.pem`, …) are denied by default even inside authorized roots. See [Security & sensitive files](/en/features/security).

## Office preview greyed out / failing?

Is a usable `soffice` configured on the Agent? See [Office preview](./office). Without LibreOffice you can still Download.

## Terminal asks for a code?

Complete `./agent --setup-terminal-2fa` on the Agent host (or set `FILEBOX_AGENT_TERMINAL_TOTP_SECRET`) and restart. The Hub never stores the secret. Every Open / Resume needs a fresh code. See [Terminal](/en/features/terminal).

## No Transfer entry?

Transfer appears only when the Agent advertises `temp_upload`. Current releases have it by default; custom builds that disable the capability will hide it.

## How does the live demo relate to these screenshots?

The [live demo](https://zhimingye.github.io/filebox/) is a static marketing page for layout exploration. **Screenshots on this user docs site come from a live Hub + Agent** — the same UI you get after deploying (login PoW, Search float, Settings, Audit, Terminal TOTP, …).

## Local debugging?

See [`docs/local-debugging.md`](https://github.com/ZhimingYe/filebox/blob/main/docs/local-debugging.md) in the repo (`FILEBOX_DEV_MODE=1`, etc.). Repo-root `docs/` is developer runbooks and is **not** part of this user docs site.
