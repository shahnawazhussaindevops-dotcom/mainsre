/* ═══════════════════════════════════════════════════════════════════════
   SREAI — GodMode: Fleet Command Center
   Aggregates telemetry across all servers into a unified god-view.
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

window.GodMode = (() => {
  const STATUS_COLOR = { healthy: '#37e39b', warning: '#ffce5c', critical: '#ff5c7c', unknown: '#59616f' };
  const alertTimeline = []; // { ts, serverId, serverName, oldStatus, newStatus }
  const prevStatuses = new Map();
  const MAX_TIMELINE = 50;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    renderStats();
    renderHeatmap();
    renderTimeline();
    renderOffenders();
    renderIncidentSummary();
  }

  function renderStats() {
    const el = document.getElementById('gmStats');
    if (!el) return;

    const servers = window._sreState?.servers || [];
    const telemetry = window._sreState?.telemetry || new Map();
    let totalServers = servers.length;
    let healthy = 0, warning = 0, critical = 0, offline = 0;
    let totalCpu = 0, totalMem = 0, totalDisk = 0, counted = 0;

    for (const s of servers) {
      const t = telemetry.get(s.id);
      if (!t) continue;
      if (!t.ok) { offline++; continue; }
      const st = t.status || 'unknown';
      if (st === 'healthy') healthy++;
      else if (st === 'warning') warning++;
      else if (st === 'critical') critical++;
      totalCpu += t.cpuPct || 0;
      totalMem += t.memPct || 0;
      totalDisk += t.diskPct || 0;
      counted++;
    }

    const avgCpu = counted ? Math.round(totalCpu / counted) : 0;
    const avgMem = counted ? Math.round(totalMem / counted) : 0;
    const avgDisk = counted ? Math.round(totalDisk / counted) : 0;
    const fleetScore = counted ? Math.round(100 - (avgCpu * 0.35 + avgMem * 0.35 + avgDisk * 0.3)) : 0;

    el.innerHTML = `
      <div class="gm-stat-card"><div class="gm-stat-value" style="color:${fleetScore >= 70 ? STATUS_COLOR.healthy : fleetScore >= 40 ? STATUS_COLOR.warning : STATUS_COLOR.critical}">${fleetScore}</div><div class="gm-stat-label">Fleet Health</div></div>
      <div class="gm-stat-card"><div class="gm-stat-value">${totalServers}</div><div class="gm-stat-label">Total Servers</div></div>
      <div class="gm-stat-card"><div class="gm-stat-value" style="color:${STATUS_COLOR.healthy}">${healthy}</div><div class="gm-stat-label">Healthy</div></div>
      <div class="gm-stat-card"><div class="gm-stat-value" style="color:${STATUS_COLOR.warning}">${warning}</div><div class="gm-stat-label">Warning</div></div>
      <div class="gm-stat-card"><div class="gm-stat-value" style="color:${STATUS_COLOR.critical}">${critical + offline}</div><div class="gm-stat-label">Critical</div></div>
      <div class="gm-stat-card"><div class="gm-stat-value">${avgCpu}%</div><div class="gm-stat-label">Avg CPU</div></div>
      <div class="gm-stat-card"><div class="gm-stat-value">${avgMem}%</div><div class="gm-stat-label">Avg Memory</div></div>
      <div class="gm-stat-card"><div class="gm-stat-value">${avgDisk}%</div><div class="gm-stat-label">Avg Disk</div></div>
    `;
  }

  function renderHeatmap() {
    const el = document.getElementById('gmHeatmap');
    if (!el) return;

    const servers = window._sreState?.servers || [];
    const telemetry = window._sreState?.telemetry || new Map();

    if (!servers.length) {
      el.innerHTML = '<div class="empty">No servers to display.</div>';
      return;
    }

    el.innerHTML = servers.map((s) => {
      const t = telemetry.get(s.id);
      const status = t ? (t.status || 'unknown') : 'unknown';
      const score = t?.score ?? '—';
      const color = STATUS_COLOR[status] || STATUS_COLOR.unknown;
      const bg = status === 'healthy' ? 'rgba(55,227,155,0.12)'
               : status === 'warning' ? 'rgba(255,206,92,0.12)'
               : status === 'critical' ? 'rgba(255,92,124,0.12)'
               : 'rgba(89,97,111,0.12)';
      return `<div class="gm-heat-cell" style="background:${bg}" data-id="${s.id}" title="${esc(s.name)} — ${status}">
        <div class="gm-heat-name">${esc(s.name)}</div>
        <div class="gm-heat-score" style="color:${color}">${score}</div>
      </div>`;
    }).join('');

    el.querySelectorAll('.gm-heat-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const id = cell.dataset.id;
        if (window._sreState) window._sreState.selectedId = id;
        Router.navigate('/dashboard');
      });
    });
  }

  function trackStatusChange(telemetry) {
    if (!telemetry || !telemetry.id) return;
    const prev = prevStatuses.get(telemetry.id);
    const current = telemetry.ok ? (telemetry.status || 'unknown') : 'critical';
    prevStatuses.set(telemetry.id, current);
    if (prev && prev !== current) {
      alertTimeline.unshift({
        ts: Date.now(),
        serverId: telemetry.id,
        serverName: telemetry.name || telemetry.hostname || 'Unknown',
        oldStatus: prev,
        newStatus: current,
      });
      if (alertTimeline.length > MAX_TIMELINE) alertTimeline.pop();
    }
  }

  function renderTimeline() {
    const el = document.getElementById('gmTimeline');
    if (!el) return;

    if (!alertTimeline.length) {
      el.innerHTML = '<div class="empty">No status changes detected yet. Events appear here as server health changes.</div>';
      return;
    }

    el.innerHTML = alertTimeline.map((e) => {
      const time = new Date(e.ts).toLocaleTimeString();
      return `<div class="gm-timeline-item ${e.newStatus}">
        <span class="gm-timeline-time">${time}</span>
        <span class="gm-timeline-text"><b>${esc(e.serverName)}</b> changed from <b>${e.oldStatus}</b> → <b>${e.newStatus}</b></span>
      </div>`;
    }).join('');
  }

  function renderOffenders() {
    const el = document.getElementById('gmOffenders');
    if (!el) return;

    const telemetry = window._sreState?.telemetry || new Map();
    const all = [...telemetry.values()].filter((t) => t.ok);

    if (!all.length) {
      el.innerHTML = '<div class="empty">No telemetry data available.</div>';
      return;
    }

    // Sort by "worst" — highest max(cpu, mem, disk)
    all.sort((a, b) => {
      const worst = (t) => Math.max(t.cpuPct || 0, t.memPct || 0, t.diskPct || 0);
      return worst(b) - worst(a);
    });

    el.innerHTML = `
      <div class="gm-offender" style="color:var(--faint)">
        <span>Server</span><span style="text-align:right">CPU</span><span style="text-align:right">MEM</span><span style="text-align:right">DISK</span>
      </div>
      ${all.slice(0, 10).map((t) => {
        const cpuColor = (t.cpuPct || 0) >= 90 ? 'var(--red)' : (t.cpuPct || 0) >= 70 ? 'var(--amber)' : 'var(--ink)';
        const memColor = (t.memPct || 0) >= 92 ? 'var(--red)' : (t.memPct || 0) >= 80 ? 'var(--amber)' : 'var(--ink)';
        const diskColor = (t.diskPct || 0) >= 95 ? 'var(--red)' : (t.diskPct || 0) >= 85 ? 'var(--amber)' : 'var(--ink)';
        return `<div class="gm-offender">
          <span class="gm-offender-name">${esc(t.name || t.hostname || '—')}</span>
          <span class="gm-offender-val" style="color:${cpuColor}">${Math.round(t.cpuPct || 0)}%</span>
          <span class="gm-offender-val" style="color:${memColor}">${Math.round(t.memPct || 0)}%</span>
          <span class="gm-offender-val" style="color:${diskColor}">${Math.round(t.diskPct || 0)}%</span>
        </div>`;
      }).join('')}
    `;
  }

  async function renderIncidentSummary() {
    const el = document.getElementById('gmIncidentSummary');
    if (!el) return;

    try {
      const res = await fetch('/api/incidents/stats');
      const stats = await res.json();
      const active = stats.open + stats.acknowledged + stats.investigating;
      el.innerHTML = `
        <div class="gm-inc-row"><span class="gm-inc-count" style="color:var(--red)">${active}</span><span>Active incidents</span></div>
        <div class="gm-inc-row"><span class="gm-inc-count">${stats.open || 0}</span><span>Open</span></div>
        <div class="gm-inc-row"><span class="gm-inc-count">${stats.investigating || 0}</span><span>Investigating</span></div>
        <div class="gm-inc-row"><span class="gm-inc-count">${stats.mitigated || 0}</span><span>Mitigated</span></div>
        <div class="gm-inc-row"><span class="gm-inc-count" style="color:var(--green)">${stats.resolved || 0}</span><span>Resolved</span></div>
        <div class="gm-inc-row" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--brd-2)">
          <span class="gm-inc-count">${stats.total || 0}</span><span>Total incidents</span>
        </div>
      `;
    } catch {
      el.innerHTML = '<div class="empty">Could not load incident stats.</div>';
    }
  }

  return { render, trackStatusChange };
})();
