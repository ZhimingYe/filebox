#!/usr/bin/env bash
#
# Generate filebox config files and print them to stdout.
#
# Does NOT touch any files. Pair with redirection to save:
#
#   scripts/gen_config.sh hub    > config/hub.json
#   scripts/gen_config.sh agent  > agent.toml
#
# All prompts and info go to stderr; only the config content goes to stdout,
# so redirection gives you a clean file.

set -euo pipefail

MODE="${1:-}"

if [[ -z "$MODE" ]]; then
    cat >&2 <<'EOF'
Generate:
  1) hub    — config/hub.json     (for the Hub server)
  2) agent  — agent.toml          (for the Agent daemon)
EOF
    read -rp "Choose [1/2]: " choice
    case "$choice" in
        1) MODE="hub" ;;
        2) MODE="agent" ;;
        *) echo "Invalid choice" >&2; exit 1 ;;
    esac
fi

# ── Helpers ───────────────────────────────────────────────────────────────

# Random agent token via openssl. 32 bytes of entropy, base64 → ~44 chars.
gen_random_token() {
    openssl rand -base64 32 | tr -d '\n'
}

# bcrypt hash via mkpasswd (whois package). $2b$12$... matches what the hub
# expects. No Python, no pip pollution.
bcrypt_hash() {
    if ! command -v mkpasswd >/dev/null 2>&1; then
        echo "ERROR: mkpasswd not found. Install whois package:" >&2
        echo "  Debian/Ubuntu: sudo apt install whois" >&2
        echo "  RHEL/CentOS:   sudo yum install whois" >&2
        echo "  Alpine:        sudo apk add whois" >&2
        exit 1
    fi
    mkpasswd -m bcrypt -R 12 "$1"
}

# ── Hub config ───────────────────────────────────────────────────────────

gen_hub() {
    command -v openssl >/dev/null  || { echo "ERROR: openssl required" >&2; exit 1; }
    command -v mkpasswd >/dev/null || {
        echo "ERROR: mkpasswd not found. Install whois package:" >&2
        echo "  Debian/Ubuntu: sudo apt install whois" >&2
        echo "  RHEL/CentOS:   sudo yum install whois" >&2
        echo "  Alpine:        sudo apk add whois" >&2
        exit 1
    }

    echo "── Hub config ──" >&2

    read -rp "Listen port [3000]: " port
    port=${port:-3000}

    read -rp "Admin username [admin]: " user
    user=${user:-admin}

    while true; do
        read -rs -p "Admin password: " pass; echo "" >&2
        [[ -n "$pass" ]] || { echo "Password cannot be empty" >&2; continue; }
        read -rs -p "Confirm password: " pass2; echo "" >&2
        [[ "$pass" == "$pass2" ]] && break
        echo "Passwords do not match" >&2
    done

    read -rp "Auto-generate agent token? [Y/n]: " yn
    case "$yn" in
        [nN]*)
            while true; do
                read -rp "Agent token: " token
                [[ -n "$token" ]] && break
                echo "Token cannot be empty" >&2
            done
            ;;
        *)
            token=$(gen_random_token)
            ;;
    esac

    echo "Generating bcrypt hashes (a few seconds)..." >&2
    local pass_hash token_hash
    pass_hash=$(bcrypt_hash "$pass")
    token_hash=$(bcrypt_hash "$token")

    cat <<EOF
{
  "listen_addr": "0.0.0.0:${port}",
  "agent_token_hash": "${token_hash}",
  "users": [
    { "username": "${user}", "password_hash": "${pass_hash}" }
  ]
}
EOF

    cat >&2 <<EOF

────────────────────────────────────────────────────
  SAVE THIS — only shown once:

  Admin user:      ${user}
  Admin password:  (the one you typed)
  Agent token:     ${token}
────────────────────────────────────────────────────
  hub.json goes on the Hub machine.
  The Agent token above goes into agent.toml on every Agent.
────────────────────────────────────────────────────
EOF
}

# ── Agent config ─────────────────────────────────────────────────────────

gen_agent() {
    echo "── Agent config ──" >&2

    insecure_hub=0
    while true; do
        read -rp "Hub URL (e.g. https://hub.example.com): " hub
        hub="${hub%/}"
        if [[ "$hub" =~ ^https:// ]] || [[ "$hub" =~ ^wss:// ]]; then
            break
        fi
        if [[ "$hub" =~ ^http:// ]] || [[ "$hub" =~ ^ws:// ]]; then
            echo "Plaintext hub URLs require FILEBOX_ALLOW_INSECURE_HUB=1 when starting the agent." >&2
            read -rp "Use plaintext for local development anyway? [y/N]: " allow_insecure
            if [[ "$allow_insecure" =~ ^[Yy]$ ]]; then
                insecure_hub=1
                break
            fi
        else
            echo "URL must start with https:// or wss://." >&2
        fi
    done

    while true; do
        read -rp "Agent token: " token
        [[ -n "$token" ]] && break
        echo "Token cannot be empty" >&2
    done

    read -rp "Agent name [$(hostname)]: " name
    name=${name:-$(hostname)}

    read -rp "Data dir [~/filebox-agent/data]: " data_dir
    data_dir=${data_dir:-$HOME/filebox-agent/data}
    # Expand ~ in case user typed it literally
    data_dir="${data_dir/#\~/$HOME}"

    if [[ "$insecure_hub" -eq 1 ]]; then
        cat <<EOF
# WARNING: plaintext hub URLs are for local development only.
# Start the agent with FILEBOX_ALLOW_INSECURE_HUB=1 to use this URL.
hub = "${hub}"
token = "${token}"
name = "${name}"
data_dir = "${data_dir}"
EOF
    else
        cat <<EOF
hub = "${hub}"
token = "${token}"
name = "${name}"
data_dir = "${data_dir}"
EOF
    fi

    cat >&2 <<EOF

────────────────────────────────────────────────────
  agent.toml ready.
  Make sure the token matches the Agent token from the Hub config.
EOF
    if [[ "$insecure_hub" -eq 1 ]]; then
        cat >&2 <<EOF
  Plaintext local development:
    FILEBOX_ALLOW_INSECURE_HUB=1 ./agent
EOF
    fi
    cat >&2 <<EOF
────────────────────────────────────────────────────
EOF
}

# ── Main ─────────────────────────────────────────────────────────────────

case "$MODE" in
    hub)    gen_hub ;;
    agent)  gen_agent ;;
    *)
        echo "Usage: $0 [hub|agent]" >&2
        exit 1
        ;;
esac
