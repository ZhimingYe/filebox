# Experimental hc backend

`hc` is a separate AI Agents backend for
[herdr-core](https://github.com/herdrdev/herdr-core). The existing `herdr`
backend still invokes herdr-cli and is unchanged. Automatic selection prefers
Herdr when both executables are detected; select **hc (experimental)** in
Agent Settings to use hc instead. Selection and enablement use the existing
Agent state, not a second config file.

## Set up on the Agent machine

Install hc using the upstream installation guide. Make `hc` available on the
Filebox Agent process's PATH, or set `FILEBOX_AGENT_HC` to the executable path
(`herdr-core` is also valid as an explicit path). Restart the Filebox Agent or
use **Check installation**. An explicit invalid path does not fall back to PATH.

Start agents from their project directories, choosing their names in Filebox:

```sh
hc run --bg --label fb=frontend -- claude
hc run --bg --label Filebox=backend -- claude
# Or opt in an existing coding-agent terminal, using its actual address:
hc label t7 fb=review
# Revoke future Filebox access:
hc label t7 fb=
```

Replace `claude` with the coding agent you use; Filebox does not detect brands.
The label key is `fb` or `filebox`, matched case-insensitively: `FB`, `Filebox`,
`FILEBOX` and mixed-case spellings also work. The value is your chosen display
name, not a fixed activation code. Names preserve their case and can include
Unicode or spaces (quote the whole label, e.g. `--label 'fb=Code review'`).
Empty or whitespace-only values do not opt in a terminal. hc requires
`key=value`; bare `--label fb` is not valid.

Updating the label renames the agent in Filebox on the next list refresh,
without changing its terminal ID, selected pane or draft. Names need not be
unique: the list and detail show hc terminal IDs, and reads, prompts and keys
always target those IDs, never the display name. These labels do not rename
the terminal inside hc itself.

The original `filebox=ai-agent` marker remains supported and keeps the hc
terminal's original name. A named `fb` label takes precedence over a `filebox`
label when both exist; each terminal is listed once. To revoke access, remove
**every** supported label on that terminal, using the exact key spellings you
added: for example, `hc label t7 Filebox=` removes `Filebox`, not `fb` or
`FILEBOX`. hc itself treats label keys as case-sensitive.

Only **local, live** opted-in terminals are exposed. Filebox filters one
terminal-list snapshot locally for the supported labels.
Unlabelled shells, finished terminals and remote `machine/t7` terminals are
excluded. Filebox checks the label again with `terminal.get` before every
read, prompt and key operation; a revoked or finished target returns
`ai_agent_missing`. This is opt-in filtering, not a sandbox: do not label a
shell unless you intend it to be controlled as an AI Agent.

Choose the backend in the existing Settings selector. For process-managed
deployments, `FILEBOX_AGENT_AI_AGENTS_BACKEND=hc` locks that choice;
`FILEBOX_AGENT_AI_AGENTS_ENABLED=0` still disables the integration. If you use
`HC_SESSION` or custom hc XDG paths, the coding-agent launcher and Filebox
Agent must inherit the same values. Nothing is installed on the Hub.

## API contract and limits

Validated against official **hc 0.1.17**, generation 1, and the upstream
[OpenRPC schema](https://github.com/herdrdev/herdr-core/tree/master/schema).
The API is still a preview; incompatible generations or missing methods fail
as `ai_agent_backend_incompatible` rather than falling back to a shell.

- Discovery runs only `hc --version`; it does not start a core. Each operation
  opens a short-lived `hc connect` subprocess and performs a `hello` handshake.
  hc owns socket/named-pipe discovery and may start its local core automatically.
- Transport is newline-delimited JSON-RPC 2.0 with matching request IDs,
  generation 1 and plain mode. No attach stream, raw API proxy, `run`, `exec`,
  file, machine-management or lifecycle operation is exposed by Filebox.
- Status comes only from hc's OSC 7501 root status record. Missing status and
  unrecognised words (including `error`, for which Filebox has no separate
  state) display as **Unknown**, never as a guessed screen-text status.
  hc's completed-turn counter supplies `completion_seq`; core identity and
  terminal creation time distinguish identities across resets. No focused
  terminal is inferred.
- Visible reads request `terminal.read` with `lines=0`. Bottom/default reads
  request history above the screen, then keep only the last requested number
  of lines of the entire result. hc may return a partial screen or stitch a
  full-screen application's history by scrolling it; this is hc's own read
  behaviour, not a raw terminal stream. Output is capped at 256 KiB; a JSON-RPC
  reply is capped at 2 MiB including JSON escaping and metadata.
- Prompts use `terminal.send` with literal JSON text and `force=false`.
  A blocked target is not forcibly typed into. Wait deadlines are converted
  from Filebox milliseconds to hc seconds. Wait results are hc check-ins, not
  promises that a task finished. Polling supplies fresh terminal state after
  mutations; delivery metadata is not presented as an updated agent record.
- Keys use `terminal.keys` and the existing Filebox key allowlist. As with
  Herdr, key actions are **not LLM-reviewed**; only prompts are. The local
  opt-in label grants that access, not proof that a program is a coding agent.
  Labelling a shell could expose shell history/menu actions through these keys:
  never label a general-purpose shell. OSC reports are status facts, not an
  authentication mechanism. No arbitrary command-line argument or shell command
  is constructed from browser input.
- Local subprocess deadlines match the existing backend budgets: list 8s,
  read 20s, keys 10s, prompt 15s (or requested wait + 5s). Cancellation kills
  the local transport process, not the hc core or terminal. A send already
  accepted by hc may still complete after Filebox times out or cancels;
  inspect output before retrying to avoid duplicate input. Label revocation
  likewise does not retract input already submitted to hc.

Prompts continue through the existing mandatory Hub-side review, with context
read through this same adapter. There is no hc-specific review bypass or
provider configuration. See [prompt review configuration](herdr-compatibility.md#mandatory-hub-side-prompt-review).

## Local verification

The normal Rust suite includes isolated fake-transport contract tests (Python 3
on Unix), covering handshakes, labels, operations, invalid responses, output
limits, timeouts and cancellation. An opt-in real-core smoke test creates an
OSC-reporting fixture plus an unlabelled terminal, verifies list/read/prompt/keys
and label revocation, then stops only its isolated core:

```sh
FILEBOX_TEST_HC=/absolute/path/to/hc cargo test --locked -p filebox-agent \
  real_core_labelled_terminal_lifecycle -- --ignored --nocapture
```

It uses scratch XDG homes and `HC_SESSION=filebox-test`; it does not call a
paid model or touch your usual hc state. Windows/macOS runtime behaviour still
needs platform-specific verification.
