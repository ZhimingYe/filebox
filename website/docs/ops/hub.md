# Hub config & HTTPS

The Hub is the only central service both browsers and Agents must reach. Always put TLS termination in front in production.

## Quick recap

1. `./bin/hub --init-config` → writes `config/hub.json`, **prints the Agent token once**  
2. Reverse-proxy terminates TLS and forwards WebSockets (below)  
3. Agent Hub URL uses `https://filebox.example.com`  
4. `./bin/hub --update` upgrades in place  

Full install steps: [Install Hub](/guide/install-hub).

## Config fields

| Field | Meaning | Default |
|-------|---------|---------|
| `listen_addr` | Listen address | `0.0.0.0:3000` |
| `agent_token_hash` | bcrypt hash of the Agent token | set at init |
| `llm_providers` | Named LLM providers: protocol, URL, model and API key source | unset |
| `prompt_review` | Review provider reference (or legacy inline config); file-only | unset (prompts rejected) |
| `users` | Login accounts | set at init |

Env vars: `FILEBOX_DEV_MODE`, `FILEBOX_LISTEN_ADDR`, `FILEBOX_FRONTEND_DIR`, `FILEBOX_CONFIG_PATH`, `FILEBOX_TRUST_XFF`, `FILEBOX_HUB_PROMPT_REVIEW_ENABLED`.

## HTTPS and WebSocket

The Hub process itself is HTTP. Minimal nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
}
```

Without WebSocket upgrade, Agents vanish from the sidebar or flap constantly.

For local development, `FILEBOX_ALLOW_INSECURE_HUB=1` lets Agents use `http://` — **never** in production.

## Health check

```bash
curl -s https://filebox.example.com/api/health
```

UI: click sidebar **v3.x.x** for About / Diagnostics (Hub status, uptime, Agents).

![About / Diagnostics](/screenshots/07-health.png)

## Login audit

Sidebar **Audit**: success / failure / rate-limit and logout events in a rolling JSONL next to the Hub (~2000 entries). Does not depend on the selected Agent.

![Audit](/screenshots/12-audit.png)

## Updates

```bash
./bin/hub --update
```

## Prompt review (AI Agents)

AI Agents prompts require Hub-side LLM security review by default. The reviewer sees the prompt and recent target-window output. Missing configuration, provider unavailability or review failure refuses delivery. Status, output reads and allowlisted keys remain available; keys are not LLM-reviewed.

Create the config with `./bin/hub --init-config` first, then run the interactive wizard (edits `config/hub.json` by default; `--output` selects another existing config):

```bash
./bin/hub --init-llm
./bin/hub --init-llm --output /path/to/hub.json
```

Choose a preset or Custom, confirm the URL / optional endpoint path and provider name, choose an environment-variable key (recommended) or inline key, then select or enter a model. The wizard probes chat, JSON and a thinking-enabled tool call; failed probes offer a choice to save anyway. Finally choose to use the provider for AI Agents review. Other config fields are preserved; restart the Hub after saving. Make the API-key environment variable available to the Hub service process too.

Merge these fields into the existing `hub.json` (do not replace authentication settings):

```json
{
  "llm_providers": {
    "deepseek": {
      "protocol": "chat_completions",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-flash",
      "api_key_env": "DEEPSEEK_API_KEY",
      "timeout_secs": 20
    }
  },
  "prompt_review": {"provider": "deepseek"}
}
```

Protocols: `chat_completions`, `responses`, `messages`. For official Anthropic Messages use `path: "/v1/messages"`; the default Messages path is `/anthropic/v1/messages`. Review timeouts are capped at 60 seconds.

Only the startup variable `FILEBOX_HUB_PROMPT_REVIEW_ENABLED=0` (or `false`) explicitly turns review off; the wizard does not disable it. The view shows the review model, off, or not configured. See [AI Agents](/features/ai-agents).

## Third-party licenses

Click the sidebar version for **About / Diagnostics** → **Open source licenses**. Filter by package name or license, then expand entries to read full license texts of bundled Rust and frontend dependencies.

![Third-party licenses](/screenshots/07b-about-licenses.png)
