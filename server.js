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
import * as incidentStore from './lib/incidentStore.js';
import * as runbookStore from './lib/runbookStore.js';
import * as automationEngine from './lib/automationEngine.js';
import * as settingsStore from './lib/settingsStore.js';
import * as alertEngine from './lib/alertEngine.js';
import { authMiddleware } from './lib/supabase.js';

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

// ── Config ────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => res.json({ 
  aiProvider: aiProvider(), 
  refreshMs: REFRESH_MS,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
}));

// ── Server CRUD ───────────────────────────────────────────────────────
app.get('/api/servers', authMiddleware, async (req, res) => res.json(await store.list(req.user.id)));

app.post('/api/servers', authMiddleware, async (req, res) => {
  try {
    const server = await store.add(req.user.id, req.body || {});
    broadcast({ type: 'inventory', servers: await store.list(req.user.id) });
    const full = await store.get(req.user.id, server.id);
    pollServer(full); // start streaming immediately
    res.json(server);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/servers/:id', authMiddleware, async (req, res) => {
  const ok = await store.remove(req.user.id, req.params.id);
  if (!ok) return res.status(400).json({ error: 'Cannot remove this server.' });
  lastTelemetry.delete(req.params.id);
  seenLogs.delete(req.params.id);
  broadcast({ type: 'inventory', servers: await store.list(req.user.id) });
  res.json({ ok: true });
});

app.post('/api/servers/:id/test', authMiddleware, async (req, res) => {
  const server = await store.get(req.user.id, req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found.' });
  if (server.kind === 'local') return res.json({ ok: true, message: 'Local machine — always reachable.' });
  try {
    await ssh.testConnection(server);
    res.json({ ok: true, message: 'SSH connection succeeded.' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/telemetry', authMiddleware, async (req, res) => {
  // In Vercel serverless, we do an on-demand poll for the user's servers
  const servers = await store.list(req.user.id);
  // Fire off polling in parallel
  const pollResults = await Promise.all(servers.map((s) => pollServer(s)));
  
  // Return the latest telemetry for this user's servers
  const results = [];
  const logMessages = [];
  
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    const pr = pollResults[i];
    
    // Try to get from poll result, fallback to lastTelemetry
    const t = pr ? pr.telemetry : lastTelemetry.get(s.id);
    if (t) {
      results.push({ ...t, logs: undefined });
    }
    if (pr && pr.logs && pr.logs.length) {
      logMessages.push({ type: 'log', serverId: s.id, name: s.name, status: t?.status, lines: pr.logs });
    }
  }
  res.json({ servers, telemetry: results, logs: logMessages });
});

// Dry-run: validate credentials WITHOUT saving.
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

// ── AI Analysis ───────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { serverId, log, errorContext } = req.body || {};
    const t = lastTelemetry.get(serverId);
    const logText = (log && String(log).trim()) || (t?.logs || []).slice(-25).join('\n') || 'No logs available.';
    const context = t
      ? { name: t.name, host: t.host, platform: t.platform, cpuPct: t.cpuPct, memPct: t.memPct, diskPct: t.diskPct }
      : null;
    const result = await analyze({ log: logText, server: context, errorContext });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/execute-fix', async (req, res) => {
  try {
    const { serverId, command } = req.body || {};
    if (!serverId || !command) return res.status(400).json({ error: 'serverId and command required' });
    
    // Create an ephemeral runbook and execute it
    const tmpRunbookId = 'rb-tmp-' + Date.now();
    await runbookStore.create({
      id: tmpRunbookId,
      name: 'AI Auto-Fix',
      description: 'Ephemeral command executed by AI auto-fix loop',
      category: 'general',
      severity: 'warning',
      builtin: false,
      platforms: ['linux', 'darwin', 'win32'],
      tags: ['ai-fix'],
      steps: [
        { order: 1, title: 'Execute Auto-Fix', command: command, risk: 'caution' }
      ]
    });
    
    const execution = await automationEngine.execute(
      tmpRunbookId,
      serverId,
      broadcast,
      sshRunCommand
    );
    
    res.json(execution);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Incident CRUD ─────────────────────────────────────────────────────
app.get('/api/incidents', (req, res) => {
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.severity) filters.severity = req.query.severity;
  if (req.query.serverId) filters.serverId = req.query.serverId;
  res.json(incidentStore.list(filters));
});

app.get('/api/incidents/stats', (_req, res) => {
  res.json(incidentStore.stats());
});

app.get('/api/incidents/:id', (req, res) => {
  const inc = incidentStore.getById(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found.' });
  res.json(inc);
});

app.post('/api/incidents', async (req, res) => {
  try {
    const incident = await incidentStore.create(req.body || {});
    broadcast({ type: 'incident', action: 'created', incident });
    res.json(incident);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/incidents/:id', async (req, res) => {
  const inc = await incidentStore.update(req.params.id, req.body || {});
  if (!inc) return res.status(404).json({ error: 'Incident not found.' });
  broadcast({ type: 'incident', action: 'updated', incident: inc });
  res.json(inc);
});

app.delete('/api/incidents/:id', async (req, res) => {
  const ok = await incidentStore.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Incident not found.' });
  broadcast({ type: 'incident', action: 'deleted', incidentId: req.params.id });
  res.json({ ok: true });
});

// ── Runbook CRUD ──────────────────────────────────────────────────────
app.get('/api/runbooks', (_req, res) => res.json(runbookStore.list()));

app.get('/api/runbooks/:id', (req, res) => {
  const rb = runbookStore.getById(req.params.id);
  if (!rb) return res.status(404).json({ error: 'Runbook not found.' });
  res.json(rb);
});

app.post('/api/runbooks', async (req, res) => {
  try {
    const rb = await runbookStore.create(req.body || {});
    res.json(rb);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/runbooks/:id', async (req, res) => {
  const rb = await runbookStore.update(req.params.id, req.body || {});
  if (!rb) return res.status(404).json({ error: 'Runbook not found or is built-in (read-only).' });
  res.json(rb);
});

app.delete('/api/runbooks/:id', async (req, res) => {
  const ok = await runbookStore.remove(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Cannot delete built-in runbook.' });
  res.json({ ok: true });
});

// ── Automation ────────────────────────────────────────────────────────
app.post('/api/automation/run', async (req, res) => {
  try {
    const { runbookId, serverId } = req.body || {};
    if (!runbookId || !serverId) {
      return res.status(400).json({ error: 'runbookId and serverId are required.' });
    }
    // Run asynchronously — results come via WebSocket
    const execution = await automationEngine.execute(
      runbookId,
      serverId,
      broadcast,
      sshRunCommand
    );
    res.json(execution);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/automation/history', (_req, res) => {
  res.json(automationEngine.getHistory());
});

app.get('/api/automation/history/:id', (req, res) => {
  const exec = automationEngine.getExecution(req.params.id);
  if (!exec) return res.status(404).json({ error: 'Execution not found.' });
  res.json(exec);
});

app.get('/api/automation/schedules', (_req, res) => {
  res.json(automationEngine.listSchedules());
});

app.post('/api/automation/schedule', (req, res) => {
  try {
    const { runbookId, serverId, intervalMs } = req.body || {};
    if (!runbookId || !serverId || !intervalMs) {
      return res.status(400).json({ error: 'runbookId, serverId, and intervalMs are required.' });
    }
    const schedule = automationEngine.addSchedule(
      runbookId, serverId, Number(intervalMs), broadcast, sshRunCommand
    );
    res.json(schedule);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/automation/schedule/:id', (req, res) => {
  const ok = automationEngine.removeSchedule(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Schedule not found.' });
  res.json({ ok: true });
});

// ── Settings ──────────────────────────────────────────────────────────
app.get('/api/settings', (_req, res) => res.json(settingsStore.get()));

app.patch('/api/settings', async (req, res) => {
  const settings = await settingsStore.update(req.body || {});
  res.json(settings);
});

app.post('/api/settings/groups', async (req, res) => {
  try {
    const group = await settingsStore.addGroup(req.body.name);
    res.json(group);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/settings/groups/:id', async (req, res) => {
  const group = await settingsStore.updateGroup(req.params.id, req.body || {});
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  res.json(group);
});

app.delete('/api/settings/groups/:id', async (req, res) => {
  const ok = await settingsStore.removeGroup(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Group not found.' });
  res.json({ ok: true });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

wss.on('connection', async (ws) => {
  ws.send(JSON.stringify({ type: 'inventory', servers: await store.list() }));
  for (const t of lastTelemetry.values()) {
    ws.send(JSON.stringify({ type: 'telemetry', data: { ...t, logs: undefined } }));
  }
});

// SSH command runner for automation engine
async function sshRunCommand(server, command) {
  // Reuse the existing sshCollector's internal runCommand by importing it
  // We import dynamically to use the same connection logic
  const ssh2 = await import('ssh2');
  const { Client } = ssh2.default || ssh2;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('Command timed out'));
    }, 30000);

    const cfg = {
      host: server.host,
      port: server.port || 22,
      username: server.username,
      readyTimeout: 15000,
    };
    if (server.privateKey) {
      cfg.privateKey = server.privateKey;
      if (server.passphrase) cfg.passphrase = server.passphrase;
    } else {
      cfg.password = server.password;
    }

    conn
      .on('ready', () => {
        conn.exec(command, (e, stream) => {
          if (e) { clearTimeout(timer); conn.end(); return reject(e); }
          stream
            .on('close', () => { clearTimeout(timer); conn.end(); resolve({ out, err }); })
            .on('data', (d) => (out += d.toString()))
            .stderr.on('data', (d) => (err += d.toString()));
        });
      })
      .on('error', (e) => { clearTimeout(timer); reject(e); })
      .connect(cfg);
  });
}

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
  if (!server || busy.has(server.id)) return null;
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

    // ── Alert detection (auto-create incidents) ──
    await alertEngine.processAlerts(enriched, broadcast).catch(() => {});

    return { telemetry: enriched, logs: toSend };
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
    return { telemetry: errT, logs: [] };
  } finally {
    busy.delete(server.id);
  }
}

async function pollAll() {
  const servers = await store.all(); // This uses 'local-dev-user' by default for polling all servers
  await Promise.all(servers.map((s) => pollServer(s)));
}

// ── Boot ──────────────────────────────────────────────────────────────
await store.load();
await settingsStore.load();
await incidentStore.load();
await runbookStore.load();
await automationEngine.load();

if (process.env.VERCEL) {
  console.log('Running in Vercel Serverless Mode');
  // In serverless, we don't start the WebSocket server or the continuous polling loop
} else {
  server.listen(PORT, () => {
    console.log(`\n  SREAI running →  http://localhost:${PORT}`);
    console.log(`  AI analysis   →  ${aiProvider()}`);
    console.log(`  Refresh       →  every ${REFRESH_MS} ms\n`);
    pollAll();
    setInterval(pollAll, REFRESH_MS);
  });
}

export default app;
