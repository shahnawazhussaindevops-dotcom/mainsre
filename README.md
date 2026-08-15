# SREAI — Live Infrastructure Console

A **real**, runnable SRE dashboard. It connects to actual machines, reads live
telemetry, streams it to a browser over WebSocket, and does AI root-cause
analysis on real logs. Nothing on the screen is mocked — every number comes from
a live sample of a real system.

You run it on your own machine. Out of the box it monitors **the machine it runs
on** (Windows, macOS, or Linux) with zero configuration. Add SSH credentials and
it monitors your remote Linux servers too.

![stack: Node.js · Express · ws · ssh2 · Three.js](https://img.shields.io/badge/stack-Node.js%20·%20Express%20·%20ws%20·%20ssh2%20·%20Three.js-00F2FE)

---

## What it actually does

- **Live metrics** — CPU, memory, and disk read every few seconds from real
  system counters (`os`/`statfs` locally; `top`/`free`/`df` over SSH).
- **Top processes** — the real process table, sorted by CPU (or memory on Windows).
- **Containers & pods** — real `docker ps` and `kubectl get pods` output when those
  tools are present on the host.
- **Live log stream** — new log lines pushed to the browser as they appear
  (`journalctl`/syslog on Linux, `system.log` on macOS, Windows Event Log on Windows).
- **AI incident analysis** — click *Analyze*, or click any log line, to get a
  severity, root cause, and a suggested shell command. Uses Anthropic or OpenAI if
  you supply a key; otherwise a built-in rule-based analyzer that recognizes common
  failure signatures (OOM, disk-full, 5xx, CrashLoopBackOff, segfault, and more).
- **3D topology** — a Three.js map with one node per server, colored live by health.

---

## Requirements

- **Node.js 18.15 or newer** (uses `fs.statfs` and the built-in `fetch`). Check with `node -v`.
- That's it. No database, no build step, no framework.

---

## Run it

```bash
cd sreai
npm install
npm start
```

Then open **http://localhost:4477**.

You'll immediately see live data for **This Machine** — no configuration needed.
Leave it running; it refreshes every 3 seconds.

> **Dev mode:** `npm run dev` restarts the server automatically when you edit a file
> (uses Node's built-in `--watch`).

---

## Connect a real remote server (SSH)

This is the part that makes it a real monitoring tool rather than a local widget.

1. Click **+ Add server** in the sidebar.
2. Enter the host/IP, port (default 22), and username.
3. Choose an auth method:
   - **Password** — the login password for that user.
   - **Private key** — paste the PEM contents of your SSH private key (and a
     passphrase if the key has one).
4. Click **Test connection** to verify the credentials without saving. When it
   succeeds, click **Add & monitor**.

The server appears in the sidebar and starts streaming within one refresh cycle.

**What SREAI runs on the remote host** — read-only diagnostics only, one combined
command per poll:

```
hostname · /proc/uptime · /proc/loadavg · top · free -b · df -B1 /
· ps -eo pid,comm,pcpu,pmem · docker ps · kubectl get pods -A · journalctl -n 40
```

No files are written, no services are changed. The user you connect as needs
permission to run those commands (most are unprivileged; `docker`/`kubectl` only
work if that user can already use them).

### Honest note on "monitoring by IP"

You **cannot** monitor a server from just an IP address. Real telemetry requires a
real login — that's true of every monitoring tool (Datadog, Grafana Agent, etc.,
all install an agent or use credentials). SREAI uses SSH so there's nothing to
install on the target: if you can `ssh` into it, SREAI can monitor it.

---

## Turn on AI analysis (optional)

Without a key, the analyzer is **rule-based** and fully functional — it pattern-matches
known failure signatures and falls back to your live metrics. To use a real LLM
instead, copy the example env file and add a key:

```bash
cp .env.example .env
```

Then edit `.env`:

```ini
# Use ONE of these. Anthropic takes priority if both are set.
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...

# Optional overrides
# ANTHROPIC_MODEL=claude-3-5-sonnet-latest
# OPENAI_MODEL=gpt-4o-mini
PORT=4477
REFRESH_MS=3000
```

Restart the server. The **AI** chip in the top bar shows which backend is active
(`anthropic`, `openai`, or `rule-based`). If an LLM call fails, SREAI automatically
falls back to the rule-based analyzer and tells you so.

---

## Security & privacy

- **Credentials never leave your machine.** They're stored in
  `data/servers.json`, which is **git-ignored**. There is no cloud, no account,
  no telemetry sent anywhere.
- **Secrets are never sent to the browser.** The API strips passwords, private
  keys, and passphrases before returning any server object; the UI only ever sees
  a `hasSecret: true` flag.
- **Remote commands are read-only** diagnostics (see the list above).
- **API keys** live only in your local `.env` and are used only for outbound calls
  to Anthropic/OpenAI when you analyze a log.
- Because this stores real credentials, run it on a machine you trust and don't
  expose port 4477 to the public internet.

---

## Configuration reference

| Variable            | Default                      | Purpose                                   |
|---------------------|------------------------------|-------------------------------------------|
| `PORT`              | `4477`                       | HTTP + WebSocket port                     |
| `REFRESH_MS`        | `3000`                       | Poll interval in ms (min 1500)            |
| `ANTHROPIC_API_KEY` | *(empty)*                    | Enables Claude analysis                   |
| `OPENAI_API_KEY`    | *(empty)*                    | Enables OpenAI analysis (if no Anthropic) |
| `ANTHROPIC_MODEL`   | `claude-3-5-sonnet-latest`   | Override the Claude model                 |
| `OPENAI_MODEL`      | `gpt-4o-mini`                | Override the OpenAI model                 |

---

## How it works

```
┌────────────────┐   WebSocket (telemetry + logs)   ┌──────────────────────┐
│  Browser UI    │ ◀───────────────────────────────  │  Node server         │
│  public/*      │   REST (config, servers, analyze) │  server.js           │
└────────────────┘ ─────────────────────────────────▶ └──────────┬───────────┘
                                                                  │ polls every REFRESH_MS
                                                    ┌─────────────┴──────────────┐
                                                    │                            │
                                          localCollector.js              sshCollector.js
                                          (os + statfs + shell)          (ssh2 → parseLinux.js)
                                                    │                            │
                                              this machine                remote Linux hosts
```

- `server.js` — Express (static files + REST) and a `ws` WebSocket server. Polls
  every server on an interval, computes a health status/score, broadcasts telemetry,
  and diffs log lines so only *new* lines are pushed.
- `lib/localCollector.js` — cross-platform real metrics for the host it runs on.
- `lib/sshCollector.js` + `lib/parseLinux.js` — one combined SSH command per poll,
  parsed into structured telemetry.
- `lib/analyzer.js` — Anthropic / OpenAI / rule-based incident analysis.
- `lib/store.js` — server inventory, persisted to `data/servers.json`; the built-in
  *This Machine* target is always present and cannot be removed.
- `public/` — vanilla JS UI (no framework, no build). Three.js is loaded from a CDN
  for the topology view and degrades gracefully to a text panel if unavailable.

---

## Test

A dependency-free smoke test verifies the real data path — local collection, the
SSH parser against a realistic payload, the analyzer's signatures, and the store:

```bash
node test/smoke.mjs
```

---

## Troubleshooting

- **"waiting for first sample…" that never fills in (remote host):** the SSH login
  or a command failed. Re-open **Add server → Test connection** to see the exact
  error. Confirm the user can log in and run `top`/`free`/`df`.
- **No logs on Linux:** the login user may not have permission to read
  `journalctl`. Add it to the `systemd-journal` group, or logs will fall back to
  `/var/log/syslog` if readable.
- **No processes on Windows:** process listing uses PowerShell; ensure it's on `PATH`.
- **Topology says "3D needs Three.js":** the CDN was unreachable. Everything else
  still works — it's only the decorative map that needs the network.
- **Port already in use:** set `PORT` in `.env` to something else.
