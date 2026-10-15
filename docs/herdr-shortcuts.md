# Herdr remote navigation and shortcuts

Checked on 2026-10-15 against the official Herdr **v0.9.5** sources and the
upstream agent documentation linked below. Agent keybindings are customizable;
these presets describe defaults, not a guarantee for every version or screen.

## Getting the newest screen

There are three independent scroll positions: Filebox's text box, Herdr's
terminal scrollback, and the coding application's own transcript.

For Filebox's read-only output refresh, prefer:

```sh
herdr agent read TARGET --source detection --lines 120
```

`detection` reads the bottom-buffer snapshot, independently of Herdr's viewport.
It does not send input, change focus, or move the remote application's transcript.
`visible` reads the current viewport and is used after an explicit shortcut, so
paging/navigation shows the screen the user just requested. Omitted `read_source`
keeps Filebox's existing recent-unwrapped/history fallback for older clients.
See [Herdr's reading API](https://herdr.ink/docs/socket-api#reading-panes) and
[the v0.9.5 snapshot implementation](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api_helpers.rs).

A Claude banner such as `4 new messages (ctrl+End)` means **the application's
own transcript** is scrolled up. A bottom-buffer read cannot reveal messages
that application has not rendered. Modern fullscreen Codex and pi also use
Ctrl+End for following their transcript. Filebox does not expose a remote-scroll
button or the unsupported Home/End/PageUp/PageDown/Delete presets. Refresh reads
the latest snapshot and moves only Filebox's output view to its end; it never
sends a remote scrolling key.

Herdr v0.9.5 has no public `pane.scroll_to_bottom`/`agent.scroll_to_bottom` API.
Its `agent send-keys` uses a shared parser which omits Home, End, PageUp,
PageDown, and Delete (including their modified forms). Thus `ctrl+end` returns
`invalid_key` before any input is written. This is an upstream limitation;
Filebox reports `herdr_key_unsupported` with a clear explanation. It never
substitutes repeated Down/Enter or pastes escape sequences into a live prompt.
See [key parser](https://github.com/herdrdev/herdr/blob/v0.9.5/src/config/keybinds.rs)
and [agent.send_keys validation](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api/agents.rs).

[herdr-navigation-keys.patch](herdr-navigation-keys.patch) is a small optional
**upstream Herdr source patch**, with parser tests, based on v0.9.5. It adds those
missing key names while retaining Herdr's runtime-dependent keyboard encoding.
It is not automatically installed or applied by Filebox. In a separate Herdr
v0.9.5 source checkout, review/apply the patch, run its parser tests, and build
using Herdr's own build instructions; both CLI and running server must use the
compatible build. Patch application was checked against the released source;
a full patched Herdr build and live model sessions were not validated here.

## Common agent defaults

| Program | Useful controls | Different meanings to watch |
| --- | --- | --- |
| pi | Esc interrupts; Ctrl+O expands tools; Ctrl+T expands thinking; Ctrl+L selects a model; Ctrl+P / Ctrl+Shift+P cycle models; Alt+Enter queues a follow-up; Alt+Up retrieves queued input | Shift+Tab changes thinking level. `/hotkeys` shows effective bindings. Fullscreen Ctrl+Home/End addresses the transcript. |
| Claude Code CLI | Esc interrupts/closes; Ctrl+O opens the transcript; Ctrl+T shows the checklist; Ctrl+B backgrounds work; Ctrl+R searches prompts; Ctrl+S stashes input; Alt+P selects a model | Shift+Tab changes permission mode or a session-level approval choice. Esc twice may open rewind. Ctrl+X then Ctrl+S sends queued input on recent releases. |
| Codex CLI | Esc interrupts; Ctrl+T opens the pager; Ctrl+R / Ctrl+S search prompt history; Shift+Up/Down change reasoning; Alt+Up edits queued input | Tab can queue input; Shift+Tab changes collaboration mode. Ctrl+End addresses fullscreen transcript, while End addresses the separate pager. |

Sources: [pi keybindings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/keybindings.md),
[Claude interactive controls](https://code.claude.com/docs/en/interactive-mode),
[Codex default keymap](https://github.com/openai/codex/blob/main/codex-rs/tui/src/keymap.rs),
[Codex fullscreen announcement](https://github.com/openai/codex/discussions/49129).

Filebox keeps Enter, Esc and Up/Down visible and groups additional
shortcuts under **Keys**. Detection selects a profile; the user can
correct it. Each labeled shortcut sends only when clicked; opening the keyboard
or changing its profile sends nothing. Numbered choices, editing keys, navigation, and multi-key sequences
all pass the same bounded Hub/Agent allowlist. Keys affect the remote input,
not Filebox's unsent local draft. Ctrl+C/Ctrl+D may exit; Ctrl+Z suspends on Unix.
Clipboard, voice, and arbitrary raw key/text injection are not added.
