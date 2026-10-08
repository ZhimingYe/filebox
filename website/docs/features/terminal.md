# Terminal

Optional: open an interactive shell on the Agent host from the browser. **Not sandboxed** — anything that OS user can do is possible. Enable only in trusted environments.

![Terminal: waiting for TOTP](/screenshots/05-terminal.png)

![Enter 6-digit code](/screenshots/05b-terminal-code.png)

![Session open with commands](/screenshots/05d-terminal-session.png)

## Enable 2FA (on the Agent host)

The secret stays on the Agent; the Hub **only forwards** codes for local verification and never stores the TOTP secret.

```bash
./agent --setup-terminal-2fa
# or with an explicit config:
./agent --setup-terminal-2fa --config /path/agent.toml
```

Follow the wizard into your Authenticator app, then **restart the Agent**.

Or use an environment variable (automation-friendly; env wins; invalid values fail startup instead of silently disabling):

```bash
export FILEBOX_AGENT_TERMINAL_TOTP_SECRET="BASE32SECRET……"  # ≥16 bytes after decode
```

## Open / resume a session

1. Sidebar **Terminal**.
2. Enter the current 6-digit TOTP → **Open terminal** (or Resume).
3. Every open / resume needs a **fresh** code; reused codes are rejected until the next 30s window.
4. **Sessions** supports Refresh, Resume, End.
5. **New session** opens another shell.

## Session lifecycle

- After browse navigation, disconnects, Hub restarts, or idle time, shells can still **Resume**.
- **Agent process restart** drops sessions; about **256 KiB** of recent output is replayed.
- Browser logout detaches but the shell can keep running until End or Agent restart.

## Security notes

- Terminal power equals that OS user’s privileges on the Agent host.
- Do not enable on shared or untrusted machines.
- Prefer upgrading Hub / Agent / frontend major versions together (see release notes).

Related: [Security & sensitive files](./security) · [Agent ops](/ops/agent)
