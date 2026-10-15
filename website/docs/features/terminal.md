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

## Phones and tablets

- **Focus** expands the existing terminal into the visible screen, including above the software keyboard. **Exit focus** restores navigation without reconnecting. Touch controls remain available in landscape and on tablets.
- **Keyboard** focuses the terminal (or the text field); **Hide** dismisses the keyboard. **Latest** returns to the newest output without sending input.
- Swipe the terminal to scroll history. New output does not pull a scrolled-back view to the bottom. History scrolling has bounded momentum (disabled with reduced motion); a new touch or keyboard action stops it. Full-screen terminal apps receive xterm's wheel behavior without momentum after release. Pinch zoom remains available.
- **Text input** opens a native field for Chinese/other IMEs and paste. **Insert** sends the completed text, without adding Enter. Press the separate **Enter** key to submit a command. Existing pasted line breaks can execute commands when the shell does not support bracketed paste. Drafts remain in this pane if sending is rejected; copy them before leaving the view or reauthorizing.
- Esc, Tab, Ctrl, Alt, Ctrl+C, Backspace, Enter and arrows have touch targets. Ctrl/Alt apply once; arrows respect application cursor mode used by terminal programs.
- Session lists scroll independently. When a connection is lost after an app switch or screen lock, Filebox shows the reason and requires a fresh Agent code to resume; it never automatically resends input.

## Session lifecycle

- After browse navigation, disconnects, Hub restarts, or idle time, shells can still **Resume**.
- **Agent process restart** drops sessions; about **256 KiB** of recent output is replayed.
- Browser logout detaches but the shell can keep running until End or Agent restart.

## Security notes

- Terminal power equals that OS user’s privileges on the Agent host.
- Do not enable on shared or untrusted machines.
- Prefer upgrading Hub / Agent / frontend major versions together (see release notes).

Related: [Security & sensitive files](./security) · [Agent ops](/ops/agent)
