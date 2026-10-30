# Herdr compatibility

The integration is checked against the official **Herdr v0.9.5** CLI release.
Filebox invokes that CLI; Herdr owns the socket protocol and its version check.
The CLI and running Herdr server should have matching versions. Herdr's main
branch can change its argument parser before a release, so validate against
the released binary as well as the documentation.

## Command contract

| Operation | Arguments after `herdr` | Output |
| --- | --- | --- |
| Probe | `--version` | Version text |
| List | `agent list` | JSON envelope containing `result.agents` |
| Bottom screen (UI default) | `agent read TARGET --source detection --lines 120` | Plain terminal text |
| Screen after explicit keys | `agent read TARGET --source visible --lines 120` | Plain terminal text |
| History (legacy clients) | `agent read TARGET --source recent-unwrapped --lines 120` | Plain terminal text |
| Working/blocked fallback | `agent read TARGET --source visible` | Plain terminal text |
| Prompt | `agent prompt TARGET TEXT` | JSON result |
| Prompt and wait | `agent prompt TARGET TEXT --wait --timeout 60000` | JSON result |
| Keys | `agent send-keys TARGET KEY [KEY ...]` | JSON result |

- In v0.9.5, prompt target and text are consumed positionally **before** flags.
  Do not put `--` before text or move wait flags before it. A text argument of
  `--`, `--help`, or multiline Unicode is literal prompt text. Filebox passes
  arguments directly without a shell.
- Read output may itself contain JSON. Do not decode it as a socket envelope.
  History and its `agent_not_idle` fallback share one 20-second deadline.
- `--wait` returns for idle, done, or blocked; it does not promise successful
  completion. Stopping the Filebox wait kills the local CLI request, not work
  Herdr has already accepted. The UI retains the draft and does not resubmit.
- `server_not_running`, `protocol_mismatch`, and `agent_name_not_found` /
  `pane_not_found` become distinct unavailable, incompatible, and missing-agent
  errors. Malformed list responses are incompatible, not empty lists.
- `completion_seq` is optional. Changes show a refresh hint; status polling never
  fetches output. Older payloads still deserialize. Explicit key actions read
  the visible viewport; ordinary UI reads use the detection/bottom screen.
- Null foreground metadata falls back to the pane's cwd/title. Prompt limits
  count UTF-8 bytes (32 KiB), matching the Agent and Hub validation.
- The CLI is probed at Agent startup when Herdr is effectively enabled.
  Enabling Herdr from Agent settings probes again if no client is cached;
  installing the CLI on the running Agent's PATH can be detected with
  **Check installation**. Changing the Agent process's PATH or
  `FILEBOX_AGENT_HERDR` requires an Agent restart.

## Attention reminders

The App monitors enabled, online Herdr-capable backends while the page is open,
including when browsing Files or another view. Background checks only call
`agent list`, with at most two concurrent requests and 30 seconds after each
backend's completed check. Disabling or selecting one backend does not cancel
another backend's checks or reset its cadence. The active Herdr panel checks status every 30 seconds and supplies its results;
it is not polled a second time. Slow backends and browser timer throttling can
increase notification delay. This is not an OS notification or a closed-page
monitoring service.

Blocked agents produce an input-needed reminder. Two consecutive unknown
observations or failed status checks after observing live coding agents produce
a cannot-determine/check notice; `agent_busy` is ignored. Offline warnings only
apply to backends with previously observed coding agents. Stopped/unavailable or
unsupported Herdr clears reminders quietly. Other failures retain known questions
until a successful list resolves them. Later acknowledges one episode and Close acknowledges all current
unread episodes. Dismissed reminders leave no banner or placeholder; the same
episode stays quiet across polling and view changes until the page is reloaded.
A resolved-then-blocked agent or a different pane reusing a name produces a fresh reminder. View navigates
only on a user click and selects the affected coding agent.

Herdr's screen detection can miss new question UI shapes and report idle. These
reminders do not guarantee every question is detected. Blocked text replies and
other unsupported interactions remain available through Herdr itself, and the
panel directs the user there rather than implying the question was answered.

## Refresh controls and compatibility limits

The integration is controlled per **Filebox Agent**. The Agent settings page
can disable or re-enable it without a restart. This boolean is stored as
`herdr_enabled` in the Agent's existing `data_dir/agent_state.json`, alongside
roots, pins, collections, and their revisions. Older state files that omit the
field default to enabled. Updates use the same direct `agent_state.json` save
path as the other Agent settings; no separate settings file is created.

```sh
export FILEBOX_AGENT_HERDR_ENABLED=0
# Restart the Filebox Agent with this environment.
```

The web setting takes effect immediately. Disabling cancels active Herdr
requests through their cancellation flags and rejects later Herdr commands, but
does not stop the Herdr server or coding agents. Re-enabling probes for the CLI
when no client is cached; a missing or failing CLI leaves the setting enabled
but Herdr unavailable until a later retry or Agent restart. Other Filebox
Agents are unaffected.

An explicit `0`/`false` disables Herdr and skips executable discovery and
`herdr --version`; `1`/`true` enables probing even if the saved setting is
disabled. The values `off`/`no` and `on`/`yes` are also accepted, case-insensitively.
An invalid or empty value fails closed as disabled. While this variable is set,
the web toggle is locked and its API returns `409 herdr_environment_override`;
remove the variable to control the saved setting from the web.

`capabilities.herdr` reports effective enablement plus a successful local CLI
probe; `capabilities.herdr_settings` reports the effective setting and any
environment override, including when Herdr is unavailable. The Hub rejects
commands when Herdr is unavailable, and the Agent independently rejects direct
commands while disabled. Settings are unsupported on legacy Agents that omit
`herdr_settings` (HTTP 501), and cannot be changed while an Agent is offline
(HTTP 503). Environment changes require an Agent restart.

Upgrade the Filebox Agent binary to one that supports persisted settings;
updating only the Hub/frontend cannot change Herdr on an older Agent. The
former browser preference is not used; the web setting now persists on its
Agent.

Each selected coding window has its own Refresh output button and auto-refresh
switch in Herdr settings (1 minute by default; manual-only when off). Inactive windows are not
polled. Switching back restores one of at most eight cached snapshots; settings
and caches are scoped to the mounted panel. Manual list refresh does not read
output unless the selected target has been replaced by a different pane. Cached
snapshots, drafts, reminder acknowledgements, and input completion handling are
bound to pane identity, so reusing an agent name cannot restore an earlier pane's
state. Reads and input use the pane id when available and recheck identity before
queued dispatch; input also rechecks before a busy retry. Shortcut profiles reset
when the pane identity or detected agent kind changes; ordinary status refreshes
preserve a manually selected profile. Stop waiting releases the composer immediately
and cancels only that input operation and its follow-up output/status requests,
leaving independent reads and status checks alone. Submitted input may still run.
Sending input refreshes its target
once; completion changes only show a
hint until the next output refresh. Status keeps running every 30 seconds during
prompt waits. A bounded priority queue allows two requests, eight waiting entries,
and a ten-second queue deadline. Manual input wins over queued background work;
HTTP and CLI deadlines still bound running operations. Slow reads have cancellation
and an eight-second notice, and superseded replies cannot paint another window.
Output snapshots retain at most 256 KiB of terminal text plus an explicit
`… truncated` marker on overflow. The marker is preserved even when the discarded
tail is whitespace; UTF-8 characters are not split at the boundary.

For multiple windows, the list supports local name/kind/folder/pane search and
status filtering without changing the selected window or fetching output. A Draft
label identifies unsent messages. The output toolbar shows snapshot time and
automatic/manual refresh mode; status changes offer an explicit refresh action.
Copy copies only the displayed snapshot, not the draft or remote input. Latest
scrolls only Filebox's snapshot without requesting output or sending keys; automatic
refresh preserves the reading position when scrolled up. Message fields grow to a
bounded height and explain blocked submission, with larger touch controls on mobile.

See [remote navigation and shortcut research](herdr-shortcuts.md) for the
bottom-screen read strategy, per-agent profiles, the Herdr v0.9.5 navigation-key
limitation, and an optional upstream source patch. New key allowlisting and read
modes require updating Filebox Hub and Agent together with the frontend. Older
Agents ignore the optional read mode and retain their old reading behavior.

## Verification

Run the focused regressions:

```sh
cargo test -p filebox-agent herdr::
cargo test -p filebox-hub herdr_proxy::
cargo test -p filebox-protocol herdr
npm --prefix frontend test -- src/components/HerdrView.test.tsx src/api/client.test.ts
npm --prefix frontend test -- src/hooks/useHerdrAttention.test.tsx src/components/HerdrAttention.test.tsx
npm --prefix frontend run build
```

The original release compatibility checks used the official macOS arm64 v0.9.5
binary with an isolated Unix socket implementing controlled protocol-22
responses, both directly and through the real Filebox Hub and Agent. This
covered list metadata, literal-JSON output, history fallback, Unicode and
dash-prefixed prompts, wait, eleven UI key shortcuts, and protocol errors.
Browser checks cover desktop and 390-pixel phone layouts, per-agent drafts,
blocked input controls, and stopping a pending wait.

The refresh/navigation follow-up adds fake-clock regressions for the 1-minute
output/30-second status split, independent snapshots, cancellation and queue
bounds, plus read-source validation and unsupported-key mapping. A fresh isolated
Hub/Agent with a controlled CLI fixture verified detection/visible reads and
navigation-key errors end to end. Desktop and 390-pixel browser checks verified
manual refresh, shortcut profiles, slow-read cancellation and disable/re-enable.
The optional Herdr patch passes a dry-run application against v0.9.5 source;
it has not been built or tested against a live coding session.

These checks validate CLI parsing and Filebox's relay/UI contract. They do not
exercise a real Herdr TUI or a real coding model's approval/completion detection.
When upgrading Herdr, repeat a live-session check for those upstream behaviors.
