/* ═══════════════════════════════════════════════════════════════════════
   SREAI — front-end controller
   Vanilla JS. Talks to the real backend over REST + WebSocket.
   Nothing here is simulated: every number comes from a live telemetry frame.
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  config: { aiProvider: '—', refreshMs: 3000 },
  servers: [],                 // sanitized inventory from the server
  telemetry: new Map(),        // id -> latest telemetry frame
  logs: new Map(),             // id -> string[]  (accumulated, capped)
  selectedId: null,
  analyzing: false,
};

const LOG_CAP = 400;
const STATUS_COLOR = { healthy: '#37e39b', warning: '#ffce5c', critical: '#ff5c7c', unknown: '#59616f' };
const STATUS_HEX = { healthy: 0x37e39b, warning: 0xffce5c, critical: 0xff5c7c, unknown: 0x59616f };

/* ── DOM helpers ────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const el = {
  aiProvider: $('aiProvider'), refreshRate: $('refreshRate'),
  liveState: $('liveState'), liveLabel: $('liveLabel'),
  serverList: $('serverList'), serverCount: $('serverCount'), addServerBtn: $('addServerBtn'),
  selName: $('selName'), selHost: $('selHost'), selMeta: $('selMeta'),
  scoreNum: $('scoreNum'), scoreWrap: $('scoreWrap'),
  cpuVal: $('cpuVal'), memVal: $('memVal'), diskVal: $('diskVal'),
  factList: $('factList'), loadWrap: $('loadWrap'), loadVals: $('loadVals'),
  procList: $('procList'), procHint: $('procHint'), workloads: $('workloads'),
  terminal: $('terminal'), analyzeBtn: $('analyzeBtn'), aiBody: $('aiBody'),
  topoCanvas: $('topoCanvas'), topoTip: $('topoTip'), topoHint: $('topoHint'),
  // modal
  modalScrim: $('modalScrim'), modalClose: $('modalClose'), addForm: $('addForm'),
  pwField: $('pwField'), keyFields: $('keyFields'),
  testBtn: $('testBtn'), saveBtn: $('saveBtn'), modalMsg: $('modalMsg'),
};

const gaugeFills = {
  cpu: document.querySelector('.gauge[data-metric="cpu"] .g-fill'),
  mem: document.querySelector('.gauge[data-metric="mem"] .g-fill'),
  disk: document.querySelector('.gauge[data-metric="disk"] .g-fill'),
};
const GAUGE_CIRC = 2 * Math.PI * 52; // r=52 in the SVG

/* ── Small utilities ────────────────────────────────────────────────── */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtPct(v) { return v == null || Number.isNaN(v) ? '—' : Math.round(v); }
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function platformLabel(p) {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[p] || p || '—';
}
function metricStatus(metric, v) {
  if (v == null) return 'unknown';
  const th = { cpu: [70, 90], mem: [80, 92], disk: [85, 95] }[metric];
  if (v >= th[1]) return 'critical';
  if (v >= th[0]) return 'warning';
  return 'healthy';
}
function selected() { return state.telemetry.get(state.selectedId); }

/* ── WebSocket ──────────────────────────────────────────────────────── */
let ws = null;
let reconnectTimer = null;

function setLive(on) {
  el.liveState.dataset.live = on ? 'on' : 'off';
  el.liveLabel.textContent = on ? 'live' : 'reconnecting…';
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {
    setLive(true);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  });
  ws.addEventListener('close', () => {
    setLive(false);
    if (!reconnectTimer) reconnectTimer = setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => ws.close());
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });
}

function handleMessage(msg) {
  if (msg.type === 'inventory') {
    state.servers = msg.servers || [];
    if (!state.selectedId || !state.servers.some((s) => s.id === state.selectedId)) {
      state.selectedId = state.servers[0]?.id || null;
    }
    renderServerList();
    renderSelected();
    Topo.sync();
  } else if (msg.type === 'telemetry') {
    const d = msg.data;
    if (!d || !d.id) return;
    state.telemetry.set(d.id, d);
    renderServerList();          // sidebar dots + cpu
    Topo.recolor();
    if (d.id === state.selectedId) renderSelected();
  } else if (msg.type === 'log') {
    const arr = state.logs.get(msg.serverId) || [];
    for (const line of msg.lines) arr.push(line);
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
    state.logs.set(msg.serverId, arr);
    if (msg.serverId === state.selectedId) renderTerminal();
  }
}

/* ── Rendering: sidebar ─────────────────────────────────────────────── */
function renderServerList() {
  el.serverCount.textContent = state.servers.length;
  el.serverList.innerHTML = '';
  for (const s of state.servers) {
    const t = state.telemetry.get(s.id);
    const status = t ? (t.status || 'unknown') : 'unknown';
    const li = document.createElement('li');
    li.className = 'srv' + (s.id === state.selectedId ? ' active' : '');
    li.dataset.id = s.id;
    const cpu = t && t.ok && t.cpuPct != null ? `${fmtPct(t.cpuPct)}%` : (t && !t.ok ? 'offline' : '…');
    li.innerHTML = `
      <div class="srv-top">
        <span class="srv-dot" style="background:${STATUS_COLOR[status]}"></span>
        <span class="srv-name">${esc(s.name)}</span>
      </div>
      <div class="srv-host">${esc(s.kind === 'local' ? 'this machine' : s.host)}</div>
      <span class="srv-cpu">${cpu}</span>
      ${s.builtin ? '' : `<button class="srv-del" title="Remove" data-del="${s.id}">×</button>`}`;
    li.addEventListener('click', (e) => {
      if (e.target.dataset.del) return;
      state.selectedId = s.id;
      renderServerList();
      renderSelected();
      Topo.recolor();
    });
    const del = li.querySelector('[data-del]');
    if (del) del.addEventListener('click', (e) => { e.stopPropagation(); removeServer(s.id, s.name); });
    el.serverList.appendChild(li);
  }
}

/* ── Rendering: everything for the selected server ──────────────────── */
function renderSelected() {
  const s = state.servers.find((x) => x.id === state.selectedId);
  const t = selected();
  el.selName.textContent = s ? s.name : '—';
  el.selHost.textContent = s ? (s.kind === 'local' ? '127.0.0.1 · local' : `${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}`) : '—';

  if (t && !t.ok) {
    el.selMeta.textContent = `offline — ${t.error || 'unreachable'}`;
    el.scoreNum.textContent = '0';
    el.scoreNum.style.color = STATUS_COLOR.critical;
    setGauge('cpu', null); setGauge('mem', null); setGauge('disk', null);
    renderFacts(t); renderProcs(null); renderWorkloads(null); renderTerminal();
    return;
  }
  if (!t) {
    el.selMeta.textContent = 'waiting for first sample…';
    el.scoreNum.textContent = '—';
    el.scoreNum.style.color = '';
    setGauge('cpu', null); setGauge('mem', null); setGauge('disk', null);
    renderFacts(null); renderProcs(null); renderWorkloads(null); renderTerminal();
    return;
  }

  el.selMeta.textContent = `${platformLabel(t.platform)} · ${t.hostname || '—'} · up ${fmtUptime(t.uptimeSec)}`;
  el.scoreNum.textContent = t.score != null ? t.score : '—';
  el.scoreNum.style.color = STATUS_COLOR[t.status] || '';
  setGauge('cpu', t.cpuPct);
  setGauge('mem', t.memPct);
  setGauge('disk', t.diskPct);
  renderFacts(t);
  renderProcs(t);
  renderWorkloads(t);
  renderTerminal();
}

function setGauge(metric, v) {
  const fill = gaugeFills[metric];
  const label = el[metric + 'Val'];
  if (label) label.textContent = fmtPct(v);
  if (!fill) return;
  const pct = v == null ? 0 : Math.max(0, Math.min(100, v));
  fill.style.strokeDasharray = GAUGE_CIRC.toFixed(1);
  fill.style.strokeDashoffset = (GAUGE_CIRC * (1 - pct / 100)).toFixed(1);
  fill.style.stroke = STATUS_COLOR[metricStatus(metric, v)];
}

function renderFacts(t) {
  const rows = [];
  if (t && t.ok) {
    rows.push(['Hostname', esc(t.hostname || '—')]);
    rows.push(['Platform', platformLabel(t.platform)]);
    rows.push(['Uptime', fmtUptime(t.uptimeSec)]);
    rows.push(['Memory', `${fmtBytes(t.memUsedBytes)} / ${fmtBytes(t.memTotalBytes)}`]);
    rows.push(['Disk', `${fmtBytes(t.diskUsedBytes)} / ${fmtBytes(t.diskTotalBytes)}`]);
    rows.push(['Processes', t.procs ? t.procs.length : 0]);
    rows.push(['Last sample', new Date(t.ts).toLocaleTimeString()]);
    el.factList.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    if (Array.isArray(t.load) && t.load.some((n) => n > 0)) {
      el.loadWrap.hidden = false;
      el.loadVals.textContent = t.load.map((n) => (n || 0).toFixed(2)).join('   ');
    } else {
      el.loadWrap.hidden = true;
    }
  } else if (t && !t.ok) {
    el.factList.innerHTML = `<dt>Status</dt><dd style="color:${STATUS_COLOR.critical}">offline</dd><dt>Error</dt><dd>${esc(t.error || 'unreachable')}</dd>`;
    el.loadWrap.hidden = true;
  } else {
    el.factList.innerHTML = `<dt>Status</dt><dd>connecting…</dd>`;
    el.loadWrap.hidden = true;
  }
}

function renderProcs(t) {
  if (!t || !t.ok || !t.procs || !t.procs.length) {
    el.procList.innerHTML = `<div class="empty">${t && t.ok ? 'No process data available.' : 'Waiting for data…'}</div>`;
    el.procHint.textContent = '';
    return;
  }
  const byCpu = t.procs.some((p) => p.cpu != null);
  el.procHint.textContent = byCpu ? 'by CPU' : 'by memory';
  const ranked = [...t.procs].sort((a, b) => ((byCpu ? b.cpu : b.mem) || 0) - ((byCpu ? a.cpu : a.mem) || 0));
  el.procList.innerHTML = ranked.slice(0, 8).map((p) => {
    const val = byCpu ? p.cpu : p.mem;
    const pctText = byCpu
      ? (p.cpu != null ? `${p.cpu.toFixed(1)}%` : '—')
      : (p.mem != null ? `${p.mem.toFixed(1)}%` : '—');
    const width = Math.max(2, Math.min(100, val || 0));
    return `
      <div class="proc">
        <span class="proc-name">${esc(p.name || '?')} <span>#${p.pid ?? '—'}</span></span>
        <span class="proc-val">${pctText}</span>
      </div>
      <div class="proc-bar-wrap"><div class="proc-bar" style="width:${width}%"></div></div>`;
  }).join('');
}

function renderWorkloads(t) {
  if (!t || !t.ok) { el.workloads.innerHTML = `<div class="empty">Waiting for data…</div>`; return; }
  const docker = t.docker || [];
  const pods = t.pods || [];
  if (!docker.length && !pods.length) {
    el.workloads.innerHTML = `<div class="empty">No containers or pods detected.<br/>Docker / Kubernetes will appear here when present on the host.</div>`;
    return;
  }
  let html = '';
  if (docker.length) {
    html += `<div><div class="wl-group-cap">Docker · ${docker.length}</div><div class="wl-chips">` +
      docker.map((c) => {
        const bad = !/^up/i.test(c.status || '');
        return `<span class="wl-chip ${bad ? 'bad' : ''}" title="${esc(c.status || '')}"><span class="d"></span>${esc(c.name || '?')} <span class="img">${esc((c.image || '').split(':')[0])}</span></span>`;
      }).join('') + `</div></div>`;
  }
  if (pods.length) {
    html += `<div><div class="wl-group-cap">Kubernetes · ${pods.length}</div><div class="wl-chips">` +
      pods.map((p) => {
        const bad = !/running|completed/i.test(p.status || '');
        return `<span class="wl-chip ${bad ? 'bad' : ''}" title="${esc(p.ns || '')} · ${esc(p.status || '')}"><span class="d"></span>${esc(p.name || '?')} <span class="img">${esc(p.ready || '')} ${esc(p.status || '')}</span></span>`;
      }).join('') + `</div></div>`;
  }
  el.workloads.innerHTML = html;
}

/* ── Terminal (live logs) ───────────────────────────────────────────── */
// Single non-overlapping pass so IPs aren't mangled by the numeric rule.
const HL_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|\b(error|fatal|critical|panic|failed|failure|oom|refused|segfault|denied|killed)\b|\b(warn(?:ing)?|timed out|timeout|retry|degraded)\b|\b(\d{3,})\b/gi;
function highlight(line) {
  return esc(line).replace(HL_RE, (m, ip, err, warn, num) => {
    if (ip) return `<span class="tok-ip">${ip}</span>`;
    if (err) return `<span class="tok-err">${err}</span>`;
    if (warn) return `<span class="tok-warn">${warn}</span>`;
    if (num) return `<span class="tok-num">${num}</span>`;
    return m;
  });
}

function renderTerminal() {
  const logs = state.logs.get(state.selectedId) || [];
  if (!logs.length) {
    el.terminal.innerHTML = `<div class="empty">No log lines yet. Streaming as they arrive…</div>`;
    return;
  }
  const atBottom = el.terminal.scrollHeight - el.terminal.scrollTop - el.terminal.clientHeight < 40;
  el.terminal.innerHTML = logs.map((l) => `<div class="log-line" title="Click to copy &amp; analyze">${highlight(l)}</div>`).join('');
  el.terminal.querySelectorAll('.log-line').forEach((node, i) => {
    node.addEventListener('click', () => onLogClick(node, logs[i]));
  });
  if (atBottom) el.terminal.scrollTop = el.terminal.scrollHeight;
}

async function onLogClick(node, line) {
  try { await navigator.clipboard.writeText(line); } catch { /* ignore */ }
  node.classList.add('copied');
  setTimeout(() => node.classList.remove('copied'), 700);
  runAnalyze(line);
}

/* ── AI analysis ────────────────────────────────────────────────────── */
el.analyzeBtn.addEventListener('click', () => {
  const logs = state.logs.get(state.selectedId) || [];
  runAnalyze(logs.slice(-25).join('\n'));
});

async function runAnalyze(logText) {
  if (state.analyzing || !state.selectedId) return;
  state.analyzing = true;
  el.analyzeBtn.disabled = true;
  el.aiBody.innerHTML = `<div class="ai-empty"><span class="spinner"></span>Analyzing with ${esc(state.config.aiProvider)}…</div>`;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: state.selectedId, log: logText || '' }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Analysis failed.');
    renderAI(r);
  } catch (e) {
    el.aiBody.innerHTML = `<div class="ai-empty" style="color:var(--red)">Analysis failed: ${esc(e.message)}</div>`;
  } finally {
    state.analyzing = false;
    el.analyzeBtn.disabled = false;
  }
}

function renderAI(r) {
  const sev = r.severity || 'info';
  const sevColor = { info: 'var(--cyan)', warning: 'var(--amber)', critical: 'var(--red)' }[sev] || 'var(--cyan)';
  el.aiBody.innerHTML = `
    <span class="ai-sev" style="border-color:${sevColor}"><span class="d" style="background:${sevColor}"></span>${esc(sev)}</span>
    <div class="ai-summary">${esc(r.summary || '')}</div>
    <div class="ai-rca">${esc(r.rootCause || '')}</div>
    ${r.command ? `
      <div class="ai-cmd-cap">Suggested command</div>
      <div class="ai-cmd"><button class="ai-copy" id="aiCopy">copy</button>${esc(r.command)}</div>` : ''}
    <div class="ai-foot">
      <span class="ai-risk risk-${esc(r.risk || 'safe')}">risk: ${esc(r.risk || 'safe')}</span>
      <span>source: ${esc(r.source || 'rule-based')}</span>
    </div>
    ${r.note ? `<div class="ai-note">⚠ ${esc(r.note)}</div>` : ''}`;
  const copyBtn = $('aiCopy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(r.command); copyBtn.textContent = 'copied'; setTimeout(() => (copyBtn.textContent = 'copy'), 1200); } catch { /* ignore */ }
  });
}

/* ── Add / remove server ────────────────────────────────────────────── */
async function removeServer(id, name) {
  if (!confirm(`Stop monitoring "${name}" and delete its saved credentials?`)) return;
  try {
    const res = await fetch(`/api/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) { const r = await res.json().catch(() => ({})); throw new Error(r.error || 'Delete failed.'); }
    state.telemetry.delete(id);
    state.logs.delete(id);
  } catch (e) { alert(e.message); }
}

/* Modal wiring */
let authMode = 'password';
function openModal() {
  el.addForm.reset();
  authMode = 'password';
  document.querySelectorAll('.auth-opt').forEach((b) => b.classList.toggle('active', b.dataset.auth === 'password'));
  el.pwField.hidden = false;
  el.keyFields.hidden = true;
  el.modalMsg.hidden = true;
  el.modalScrim.hidden = false;
}
function closeModal() { el.modalScrim.hidden = true; }

el.addServerBtn.addEventListener('click', openModal);
el.modalClose.addEventListener('click', closeModal);
el.modalScrim.addEventListener('click', (e) => { if (e.target === el.modalScrim) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.modalScrim.hidden) closeModal(); });

document.querySelectorAll('.auth-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    authMode = btn.dataset.auth;
    document.querySelectorAll('.auth-opt').forEach((b) => b.classList.toggle('active', b === btn));
    el.pwField.hidden = authMode !== 'password';
    el.keyFields.hidden = authMode !== 'key';
  });
});

function formPayload() {
  const f = new FormData(el.addForm);
  const p = {
    name: (f.get('name') || '').trim(),
    host: (f.get('host') || '').trim(),
    port: (f.get('port') || '22').trim(),
    username: (f.get('username') || '').trim(),
  };
  if (authMode === 'password') p.password = f.get('password') || '';
  else { p.privateKey = f.get('privateKey') || ''; p.passphrase = f.get('passphrase') || ''; }
  return p;
}
function modalMsg(kind, text) {
  el.modalMsg.hidden = false;
  el.modalMsg.className = `modal-msg ${kind}`;
  el.modalMsg.textContent = text;
}

el.addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = formPayload();
  el.saveBtn.disabled = true;
  modalMsg('ok', 'Connecting & saving…');
  try {
    const res = await fetch('/api/servers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Could not add server.');
    state.selectedId = r.id;
    modalMsg('ok', 'Added. Streaming telemetry…');
    setTimeout(closeModal, 500);
  } catch (err) {
    modalMsg('err', err.message);
  } finally {
    el.saveBtn.disabled = false;
  }
});

el.testBtn.addEventListener('click', async () => {
  const payload = formPayload();
  if (!payload.host || !payload.username) { modalMsg('err', 'Host and username are required to test.'); return; }
  el.testBtn.disabled = true;
  modalMsg('ok', 'Testing SSH connection…');
  try {
    const res = await fetch('/api/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (!res.ok || r.ok === false) throw new Error(r.error || 'Connection failed.');
    modalMsg('ok', `✓ ${r.message || 'Connection succeeded.'} — click “Add & monitor” to save.`);
  } catch (err) {
    modalMsg('err', err.message);
  } finally {
    el.testBtn.disabled = false;
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   Three.js topology  (hub + one node per server, colored by live health)
   Degrades gracefully to a text fallback if the CDN script is unavailable.
   ═════════════════════════════════════════════════════════════════════ */
const Topo = (() => {
  let renderer, scene, camera, pivot, hub, raf;
  let nodes = new Map();          // id -> { mesh, glow, line, base }
  const rot = { x: -0.35, y: 0.4, tx: -0.35, ty: 0.4 };
  const drag = { on: false, moved: false, x: 0, y: 0 };
  let raycaster, mouse, hoverId = null;
  const RADIUS = 3.3;

  function available() { return typeof window.THREE !== 'undefined'; }

  function init() {
    if (!available()) {
      el.topoCanvas.innerHTML = `<div class="topo-fallback">3D topology needs the Three.js library (blocked offline).<br/>All live metrics below still work.</div>`;
      if (el.topoHint) el.topoHint.textContent = '';
      return;
    }
    const w = el.topoCanvas.clientWidth || 600;
    const h = el.topoCanvas.clientHeight || 300;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(46, w / h, 0.1, 100);
    camera.position.set(0, 1.6, 8.4);
    camera.lookAt(0, 0, 0);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    el.topoCanvas.appendChild(renderer.domElement);

    pivot = new THREE.Group();
    scene.add(pivot);

    // Central hub
    hub = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.5, 1),
      new THREE.MeshBasicMaterial({ color: 0x35e5ff, wireframe: true, transparent: true, opacity: 0.85 })
    );
    pivot.add(hub);
    const hubGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.72, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x35e5ff, transparent: true, opacity: 0.08 })
    );
    pivot.add(hubGlow);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    bindEvents();
    animate();
    window.addEventListener('resize', onResize);
  }

  function nodeColor(id) {
    const t = state.telemetry.get(id);
    const status = t ? (t.status || 'unknown') : 'unknown';
    return STATUS_HEX[status] ?? STATUS_HEX.unknown;
  }

  function sync() {
    if (!available() || !scene) return;
    const ids = state.servers.map((s) => s.id);
    // remove stale
    for (const [id, n] of nodes) {
      if (!ids.includes(id)) { pivot.remove(n.mesh); pivot.remove(n.glow); pivot.remove(n.line); nodes.delete(id); }
    }
    // (re)position all
    ids.forEach((id, i) => {
      const angle = (i / Math.max(1, ids.length)) * Math.PI * 2;
      const pos = new THREE.Vector3(Math.cos(angle) * RADIUS, Math.sin(i * 1.7) * 0.5, Math.sin(angle) * RADIUS);
      let n = nodes.get(id);
      if (!n) {
        const color = nodeColor(id);
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 24), new THREE.MeshBasicMaterial({ color }));
        mesh.userData.id = id;
        const glow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 20), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14 }));
        const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), pos.clone()]);
        const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
        pivot.add(mesh); pivot.add(glow); pivot.add(line);
        n = { mesh, glow, line };
        nodes.set(id, n);
      }
      n.mesh.position.copy(pos);
      n.glow.position.copy(pos);
      n.line.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), pos.clone()]);
      n.base = pos.clone();
    });
    recolor();
  }

  function recolor() {
    if (!available() || !scene) return;
    for (const [id, n] of nodes) {
      const color = nodeColor(id);
      n.mesh.material.color.setHex(color);
      n.glow.material.color.setHex(color);
      n.line.material.color.setHex(color);
      const sel = id === state.selectedId;
      const target = sel ? 1.5 : 1;
      n.mesh.scale.setScalar(target);
      n.glow.material.opacity = sel ? 0.28 : 0.14;
      n.line.material.opacity = sel ? 0.6 : 0.3;
    }
  }

  function bindEvents() {
    const c = renderer.domElement;
    c.style.cursor = 'grab';
    c.addEventListener('pointerdown', (e) => { drag.on = true; drag.moved = false; drag.x = e.clientX; drag.y = e.clientY; c.style.cursor = 'grabbing'; });
    window.addEventListener('pointerup', (e) => {
      if (drag.on && !drag.moved) pick(e, true);
      drag.on = false; c.style.cursor = 'grab';
    });
    c.addEventListener('pointermove', (e) => {
      if (drag.on) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        rot.ty += dx * 0.008;
        rot.tx = Math.max(-1.1, Math.min(1.1, rot.tx + dy * 0.008));
        drag.x = e.clientX; drag.y = e.clientY;
      } else {
        pick(e, false);
      }
    });
    c.addEventListener('pointerleave', () => hideTip());
  }

  function pick(e, doSelect) {
    if (!raycaster) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects([...nodes.values()].map((n) => n.mesh));
    if (hits.length) {
      const id = hits[0].object.userData.id;
      if (doSelect) {
        state.selectedId = id;
        renderServerList(); renderSelected(); recolor();
        return;
      }
      showTip(id, e.clientX - rect.left, e.clientY - rect.top);
      renderer.domElement.style.cursor = 'pointer';
    } else if (!doSelect) {
      hideTip();
      renderer.domElement.style.cursor = drag.on ? 'grabbing' : 'grab';
    }
  }

  function showTip(id, x, y) {
    const s = state.servers.find((v) => v.id === id);
    const t = state.telemetry.get(id);
    if (!s) return;
    hoverId = id;
    el.topoTip.hidden = false;
    el.topoTip.style.left = x + 'px';
    el.topoTip.style.top = y + 'px';
    const line2 = t && t.ok
      ? `CPU <b>${fmtPct(t.cpuPct)}%</b> · MEM <b>${fmtPct(t.memPct)}%</b> · ${t.status}`
      : (t && !t.ok ? 'offline' : 'waiting…');
    el.topoTip.innerHTML = `<b>${esc(s.name)}</b><br/>${line2}`;
  }
  function hideTip() { if (hoverId) { el.topoTip.hidden = true; hoverId = null; } }

  function onResize() {
    if (!renderer) return;
    const w = el.topoCanvas.clientWidth, h = el.topoCanvas.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function animate() {
    raf = requestAnimationFrame(animate);
    if (!drag.on) rot.ty += 0.0016;           // gentle auto-orbit
    rot.x += (rot.tx - rot.x) * 0.08;
    rot.y += (rot.ty - rot.y) * 0.08;
    pivot.rotation.x = rot.x;
    pivot.rotation.y = rot.y;
    if (hub) hub.rotation.y += 0.006;
    const tm = performance.now() * 0.001;
    for (const n of nodes.values()) {
      if (n.base) n.mesh.position.y = n.base.y + Math.sin(tm + n.base.x) * 0.06;
    }
    renderer.render(scene, camera);
  }

  return { init, sync, recolor };
})();

/* ── Boot ───────────────────────────────────────────────────────────── */
async function boot() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    state.config = cfg;
    el.aiProvider.textContent = cfg.aiProvider;
    el.refreshRate.textContent = (cfg.refreshMs / 1000) + 's';
  } catch { /* defaults stand */ }
  Topo.init();
  connect();
}
boot();
