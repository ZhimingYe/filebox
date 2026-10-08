# Security & sensitive files

filebox’s default posture: **read-only browse, path jail, sensitive files denied**. Two write capabilities (Transfer, Terminal) are explicit exceptions and need capability / local configuration.

![Sidebar capability entries](/screenshots/00-sidebar-overview.png)

## Read-only protocol

Browse paths have no write / delete / rename / arbitrary exec messages.

| Exception | Scope | Protections |
|-----------|-------|-------------|
| **Transfer** | Agent scratch directory only | Quotas, no overwrite, not a normal root |
| **Terminal** | Agent host shell (**not sandboxed**) | Agent-local TOTP; secret never enters the Hub |

## Sensitive files denied by default (excerpt)

Even inside authorized roots, matching paths are unreadable:

```text
.git/  .ssh/  .gnupg/  .aws/  .kube/
.env*  *.pem  *.key  id_*  credentials*.json  *.sqlite*
```

plus common credential locations such as shell history. Exact rules follow the current release implementation.

## Path jail

Browse is strictly limited to added roots; `..` and symlink escapes are blocked.

## Auth and trust

- User login happens on the Hub (PoW + session cookie + CSRF).
- Each machine uses its own Agent token (Hub stores only a hash).
- Agents dial out to the Hub; targets need no inbound exposure.
- Production must use HTTPS to protect tokens and sessions.
- Login events appear under sidebar **Audit**.

![Login audit](/screenshots/12-audit.png)

## Architecture notes

Deeper Hub↔Agent trust boundaries, tokens, and rate limits live in the repo developer doc
[`docs/hub-agent-security-model.md`](https://github.com/ZhimingYe/filebox/blob/main/docs/hub-agent-security-model.md) (Chinese).
