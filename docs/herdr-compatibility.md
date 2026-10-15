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
| History | `agent read TARGET --source recent-unwrapped --lines 120` | Plain terminal text |
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
- `completion_seq` is optional. When present, it triggers a read for a turn
  completed entirely between polls. Older payloads still deserialize.
- Null foreground metadata falls back to the pane's cwd/title. Prompt limits
  count UTF-8 bytes (32 KiB), matching the Agent and Hub validation.
- The CLI is probed once when the Filebox Agent starts. Restart that Agent
  after installing Herdr or changing `FILEBOX_AGENT_HERDR`.

## Attention reminders

The App monitors all online Herdr-capable backends while the page is open,
including when browsing Files or another view. Background checks only call
`agent list`, with at most two concurrent requests and 15 seconds between
completed rounds. The active Herdr panel supplies its existing polling results;
it is not polled a second time. Slow backends and browser timer throttling can
increase notification delay. This is not an OS notification or a closed-page
monitoring service.

Blocked agents produce an input-needed reminder. Two consecutive unknown
observations or failed status checks produce an honest cannot-determine/check
notice; `agent_busy` is ignored. Offline backends are marked unavailable.
Known questions remain visible through failed checks until a successful list
resolves them. Later acknowledges one episode and Close acknowledges all current
unread episodes. Dismissed reminders leave no banner or placeholder; the same
episode stays quiet across polling and view changes until the page is reloaded.
A resolved-then-blocked agent produces a fresh reminder. View navigates
only on a user click and selects the affected coding agent.

Herdr's screen detection can miss new question UI shapes and report idle. These
reminders do not guarantee every question is detected. Blocked text replies and
other unsupported interactions remain available through Herdr itself, and the
panel directs the user there rather than implying the question was answered.

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

Release compatibility was also checked using the official macOS arm64 v0.9.5
binary with an isolated Unix socket implementing controlled protocol-22
responses, both directly and through the real Filebox Hub and Agent. This
covered list metadata, literal-JSON output, history fallback, Unicode and
dash-prefixed prompts, wait, eleven UI key shortcuts, and protocol errors.
Browser checks cover desktop and 390-pixel phone layouts, per-agent drafts,
blocked input controls, and stopping a pending wait.

These checks validate CLI parsing and Filebox's relay/UI contract. They do not
exercise a real Herdr TUI or a real coding model's approval/completion detection.
When upgrading Herdr, repeat a live-session check for those upstream behaviors.
