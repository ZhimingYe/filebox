# First login & add roots

After Hub and Agent are running, finish in the browser: log in (with PoW) → select a machine → Add Root → start browsing.

## 1. Open the login page

Visit the Hub URL. The login page includes:

- Username / Password
- **Verification (PoW)**: solves a challenge in the background — Solving… → **Ready**
- Keep me signed in 30 days (optional)
- **Continue**

![Sign in: PoW Ready](/screenshots/09-login.png)

![Credentials filled](/screenshots/09c-login-filled.png)

Production accounts come from `--init-config`. Development mode defaults to `admin` / `dev-password`.

If Verification fails or you are rate-limited, click the refresh icon to fetch a new challenge and try again later.

## 2. Select an Agent

After login, if no machine is selected the main area prompts **Select an agent**. Click the target under sidebar **Agents** (Online, latency, root count).

Once selected, the sidebar shows **Workspace** navigation: Files, Explorer, Collections, Transfer, Terminal, Search, Settings, System; plus **Hub → Audit**.

## 3. Settings → Add Root

Open **Settings**:

1. Confirm the Connection card: Online, Round-trip, Enabled roots.
2. Under **Workspace roots → Add root**, fill in:
   - **NAME**: short label in the sidebar / address bar (e.g. `demo`, `projects`)
   - **PATH ON AGENT**: absolute path on the Agent host, or `~/…`
3. Click **Add root**. Overly broad paths (e.g. `/` or home root) ask for explicit confirmation.

![Settings overview](/screenshots/11-settings.png)

![Add root form](/screenshots/11b-settings-add-root.png)

Invalid paths are rejected and **do not** corrupt existing config. Roots, pins, and collections live in Agent state and persist with the Agent identity.

## 4. Browse in Files

Go back to **Files**, switch roots with the dropdown, enter directories, and click a file to preview on the right.

![Files root listing](/screenshots/01-files-browse.png)

![reports directory (long names)](/screenshots/01c-files-reports.png)

## Sidebar views

| View | Role | Docs |
|------|------|------|
| Files | Breadcrumb + list browse, multi-tab preview | [Browse files](/features/browse) |
| Explorer | Tree-style browse | [Explorer](/features/explorer) |
| Search | Workspace filename / content search (desktop float / mobile sheet) | [Search](/features/search) |
| Collections | Virtual file groups across directories | [Collections](/features/collections) |
| Transfer | The only writable scratch upload folder | [Transfer](/features/transfer) |
| Terminal | Optional TOTP-gated remote shell | [Terminal](/features/terminal) |
| Settings | Manage roots, Office preview toggle | This page |
| System | CPU / memory / processes | [System monitor](/features/stats) |
| Audit | Login audit (no selected Agent required) | [Hub ops](/ops/hub) |
| Version | Click for About / Diagnostics | — |

![Audit](/screenshots/12-audit.png)

![About / Diagnostics](/screenshots/07-health.png)

## Mobile

Below ~768px viewport width the sidebar becomes a drawer; list and preview swap full-screen. The top bar has menu and Search entries.

![Mobile Files](/screenshots/13-mobile-files.png)

![Mobile sidebar drawer](/screenshots/13b-mobile-drawer.png)

Common issues: [FAQ](/ops/faq).
