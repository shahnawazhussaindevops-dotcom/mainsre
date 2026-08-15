import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import * as store from './lib/store.js';
import * as local from './lib/localCollector.js';
import * as ssh from './lib/sshCollector.js';
import { analyze } from './lib/analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Minimal .env loader (no external dependency) ──────────────────────
function loadEnv(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {
    /* no .env — fine */
  }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 4477;
const REFRESH_MS = Math.max(1500, Number(process.env.REFRESH_MS) || 3000);

function aiProvider() {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return 'anthropic';
  if (process.env.OPENAI_API_KEY?.trim()) return 'openai';
  return 'rule-based';
}

// ── Health scoring ────────────────────────────────────────────────────
function statusOf(t) {
  if (!t || !t.ok) return 'critical';
  const c = t.cpuPct ?? 0;
  const m = t.memPct ?? 0;
  const d = t.diskPct ?? 0;
  const errLog = (t.logs || []).some((l) => /\b(error|critical|fatal|panic|oom|refused|segfault)\b/i.test(l));
  if (c >= 90 || m >= 92 || d >= 95) return 'critical';
  if (c >= 70 || m >= 80 || d >= 85 || errLog) return 'warning';
  return 'healthy';
}

function scoreOf(t) {
  if (!t || !t.ok) return 0;
  const c = t.cpuPct ?? 0;
  const m = t.memPct ?? 0;
  const d = t.diskPct ?? 0;
  return Math.max(0, Math.min(100, Math.round(100 - (c * 0.35 + m * 0.35 + d * 0.3))));
}

// ── Express app ───────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => res.json({ aiProvider: aiProvider(), refreshMs: REFRESH_MS }));

app.get('/api/servers', (_req, res) => res.json(store.list()));

app.post('/api/servers', async (req, res) => {
  try {
    const server = await store.add(req.body || {});
    broadcast({ type: 'inventory', servers: store.list() });
    const full = store.get(server.id);
    pollServer(full); // start streaming immediately
    res.json(server);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/servers/:id', async (req, res) => {
  const ok = await store.remove(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Cannot remove this server.' });
  lastTelemetry.delete(req.params.id);
  seenLogs.delete(req.params.id);
  broadcast({ type: 'inventory', servers: store.list() });
  res.json({ ok: true });
});

app.post('/api/servers/:id/test', async (req, res) => {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found.' });
  if (server.kind === 'local') return res.json({ ok: true, message: 'Local machine — always reachable.' });
  try {
    await ssh.testConnection(server);
    res.json({ ok: true, message: 'SSH connection succeeded.' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Dry-run: validate credentials WITHOUT saving. Nothing is persisted here.
app.post('/api/test', async (req, res) => {
  const b = req.body || {};
  if (!String(b.host || '').trim() || !String(b.username || '').trim()) {
    return res.status(400).json({ ok: false, error: 'Host and username are required.' });
  }
  if (!b.password && !b.privateKey) {
    return res.status(400).json({ ok: false, error: 'Provide a password or a private key.' });
  }
  try {
    await ssh.testConnection({
      kind: 'ssh',
      host: String(b.host).trim(),
      port: Number(b.port) || 22,
      username: String(b.username).trim(),
      password: b.password || undefined,
      privateKey: b.privateKey || undefined,
      passphrase: b.passphrase || undefined,
    });
    res.json({ ok: true, message: 'SSH connection succeeded.' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { serverId, log } = req.body || {};
    const t = lastTelemetry.get(serverId);
    const logText = (log && String(log).trim()) || (t?.logs || []).slice(-25).join('\n') || 'No logs available.';
    const context = t
      ? { name: t.name, host: t.host, cpuPct: t.cpuPct, memPct: t.memPct, diskPct: t.diskPct }
      : null;
    const result = await analyze({ log: logText, server: context });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HTTP + WebSocket server ───────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'inventory', servers: store.list() }));
  for (const t of lastTelemetry.values()) {
    ws.send(JSON.stringify({ type: 'telemetry', data: { ...t, logs: undefined } }));
  }
});

// ── Polling loop ──────────────────────────────────────────────────────
const lastTelemetry = new Map();
const seenLogs = new Map();
const busy = new Set();

function hashLine(l) {
  let h = 0;
  for (let i = 0; i < l.length; i++) h = (h * 31 + l.charCodeAt(i)) | 0;
  return h;
}

async function pollServer(server) {
  if (!server || busy.has(server.id)) return;
  busy.add(server.id);
  try {
    const raw = server.kind === 'local' ? await local.collect() : await ssh.collect(server);
    const enriched = {
      ...raw,
      id: server.id,
      name: server.name,
      host: server.host,
      kind: server.kind,
      status: statusOf(raw),
      score: scoreOf(raw),
    };
    lastTelemetry.set(server.id, enriched);
    broadcast({ type: 'telemetry', data: { ...enriched, logs: undefined } });

    const logs = enriched.logs || [];
    let seen = seenLogs.get(server.id);
    const firstTime = !seen;
    if (!seen) {
      seen = new Set();
      seenLogs.set(server.id, seen);
    }
    const fresh = [];
    for (const line of logs) {
      const h = hashLine(line);
      if (!seen.has(h)) {
        seen.add(h);
        fresh.push(line);
      }
    }
    if (seen.size > 800) seenLogs.set(server.id, new Set(logs.map(hashLine)));
    const toSend = firstTime ? fresh.slice(-14) : fresh;
    if (toSend.length) {
      broadcast({ type: 'log', serverId: server.id, name: server.name, status: enriched.status, lines: toSend });
    }
  } catch (e) {
    const errT = {
      id: server.id,
      name: server.name,
      host: server.host,
      kind: server.kind,
      ok: false,
      error: e.message,
      ts: Date.now(),
      status: 'critical',
      score: 0,
    };
    lastTelemetry.set(server.id, errT);
    broadcast({ type: 'telemetry', data: errT });
  } finally {
    busy.delete(server.id);
  }
}

async function pollAll() {
  await Promise.all(store.all().map((s) => pollServer(s)));
}

// ── Boot ──────────────────────────────────────────────────────────────
await store.load();
server.listen(PORT, () => {
  console.log(`\n  SREAI running →  http://localhost:${PORT}`);
  console.log(`  AI analysis   →  ${aiProvider()}`);
  console.log(`  Refresh       →  every ${REFRESH_MS} ms\n`);
  pollAll();
  setInterval(pollAll, REFRESH_MS);
});
