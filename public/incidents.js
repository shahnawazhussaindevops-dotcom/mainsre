/* ═══════════════════════════════════════════════════════════════════════
   SREAI — Incident Triage Page
   Full incident lifecycle management — list, create, detail, status workflow.
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

window.Incidents = (() => {
  let incidents = [];
  let selectedIncident = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function timeAgo(dateStr) {
    const ms = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  async function load() {
    try {
      const status = document.getElementById('incFilterStatus')?.value || '';
      const severity = document.getElementById('incFilterSeverity')?.value || '';
      let url = '/api/incidents?';
      if (status) url += `status=${status}&`;
      if (severity) url += `severity=${severity}&`;
      const res = await fetch(url);
      incidents = await res.json();
    } catch {
      incidents = [];
    }
    render();
    updateBadge();
  }

  function render() {
    renderBoard();
    if (selectedIncident) {
      const fresh = incidents.find((i) => i.id === selectedIncident.id);
      if (fresh) renderDetail(fresh);
    }
  }

  function renderBoard() {
    const el = document.getElementById('incBoard');
    if (!el) return;

    if (!incidents.length) {
      el.innerHTML = '<div class="empty">No incidents found. All clear! 🎉</div>';
      return;
    }

    el.innerHTML = incidents.map((inc) => `
      <div class="inc-card" data-id="${inc.id}">
        <div class="inc-sev-dot ${inc.severity}"></div>
        <div class="inc-card-body">
          <div class="inc-card-title">${esc(inc.title)}</div>
          <div class="inc-card-meta">${esc(inc.serverName || '—')} · ${esc(inc.source)} · ${inc.assignee ? esc(inc.assignee) : 'unassigned'}</div>
        </div>
        <span class="inc-card-status ${inc.status}">${inc.status}</span>
        <span class="inc-card-age">${timeAgo(inc.createdAt)}</span>
      </div>
    `).join('');

    el.querySelectorAll('.inc-card').forEach((card) => {
      card.addEventListener('click', () => {
        const inc = incidents.find((i) => i.id === card.dataset.id);
        if (inc) renderDetail(inc);
      });
    });
  }

  function renderDetail(inc) {
    selectedIncident = inc;
    const panel = document.getElementById('incDetailPanel');
    const el = document.getElementById('incDetail');
    if (!panel || !el) return;
    panel.hidden = false;

    const statusFlow = ['open', 'acknowledged', 'investigating', 'mitigated', 'resolved'];
    const currentIdx = statusFlow.indexOf(inc.status);
    const nextStatuses = statusFlow.slice(currentIdx + 1);

    el.innerHTML = `
      <div class="inc-detail-header">
        <div>
          <div class="inc-detail-title">${esc(inc.title)}</div>
          <div style="margin-top:6px;font-size:12px;color:var(--faint)">
            <span class="inc-sev-dot ${inc.severity}" style="display:inline-block;width:8px;height:8px;vertical-align:middle;margin-right:4px"></span>
            ${esc(inc.severity)} · ${esc(inc.status)} · ${esc(inc.serverName || '—')} · ${timeAgo(inc.createdAt)}
          </div>
        </div>
        <button class="inc-detail-close" id="incDetailClose">×</button>
      </div>
      ${inc.description ? `<div style="font-size:13px;color:var(--muted);margin-bottom:12px;line-height:1.5">${esc(inc.description)}</div>` : ''}
      <div class="inc-detail-actions">
        ${nextStatuses.map((s) => `<button class="inc-action-btn${s === 'resolved' ? ' primary' : ''}" data-status="${s}">${s === 'resolved' ? '✓ Resolve' : s.charAt(0).toUpperCase() + s.slice(1)}</button>`).join('')}
        <button class="inc-action-btn" id="incAnalyzeBtn">🔍 AI Analyze</button>
        <button class="inc-action-btn" data-delete="true" style="color:var(--red)">🗑 Delete</button>
      </div>
      <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);margin-top:16px">Timeline</div>
      <div class="inc-timeline">
        ${inc.timeline.slice().reverse().map((e) => `
          <div class="inc-timeline-item">
            <div class="inc-timeline-time">${new Date(e.ts).toLocaleString()}</div>
            <div class="inc-timeline-text">${esc(e.note || e.action)}</div>
          </div>
        `).join('')}
      </div>
      ${inc.analysis ? `
        <div style="margin-top:16px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint)">AI Analysis</div>
        <div style="margin-top:8px;padding:12px;border:1px solid var(--brd-2);border-radius:10px;background:var(--panel-2)">
          <div style="font-size:14px;font-weight:500">${esc(inc.analysis.summary || '')}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">${esc(inc.analysis.rootCause || '')}</div>
          ${inc.analysis.command ? `<div style="font-family:var(--mono);font-size:12px;color:var(--green);margin-top:8px;padding:6px 10px;border-radius:6px;background:rgba(3,4,7,0.5)">${esc(inc.analysis.command)}</div>` : ''}
        </div>
      ` : ''}
    `;

    el.querySelector('#incDetailClose').addEventListener('click', () => {
      panel.hidden = true;
      selectedIncident = null;
    });

    el.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await updateIncident(inc.id, { status: btn.dataset.status });
      });
    });

    el.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm('Delete this incident?')) return;
      await deleteIncident(inc.id);
    });

    el.querySelector('#incAnalyzeBtn')?.addEventListener('click', async () => {
      const btn = el.querySelector('#incAnalyzeBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Analyzing…';
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serverId: inc.serverId }),
        });
        const analysis = await res.json();
        await updateIncident(inc.id, { analysis });
      } catch (e) {
        alert('Analysis failed: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '🔍 AI Analyze';
      }
    });
  }

  async function updateIncident(id, patch) {
    try {
      await fetch(`/api/incidents/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await load();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  async function deleteIncident(id) {
    try {
      await fetch(`/api/incidents/${id}`, { method: 'DELETE' });
      selectedIncident = null;
      document.getElementById('incDetailPanel').hidden = true;
      await load();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  async function createIncident(data) {
    try {
      const res = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed');
      }
      await load();
      return true;
    } catch (e) {
      alert('Error creating incident: ' + e.message);
      return false;
    }
  }

  function updateBadge() {
    const badge = document.getElementById('incidentBadge');
    if (!badge) return;
    const activeCount = incidents.filter((i) => !['resolved', 'mitigated'].includes(i.status)).length;
    if (activeCount > 0) {
      badge.hidden = false;
      badge.textContent = activeCount;
    } else {
      badge.hidden = true;
    }
  }

  function handleWsIncident(msg) {
    // Reload when we get a WebSocket incident update
    if (Router.current() === '/incidents') {
      load();
    } else {
      // Just update the badge
      fetch('/api/incidents?status=open')
        .then((r) => r.json())
        .then((list) => {
          const badge = document.getElementById('incidentBadge');
          if (badge) {
            const count = list.length;
            badge.hidden = count === 0;
            badge.textContent = count;
          }
        })
        .catch(() => {});
    }
  }

  function initModal() {
    const scrim = document.getElementById('incModalScrim');
    const form = document.getElementById('incForm');
    const openBtn = document.getElementById('createIncidentModalBtn');
    const closeBtn = document.getElementById('incModalClose');
    const cancelBtn = document.getElementById('incModalCancel');

    if (openBtn) openBtn.addEventListener('click', () => {
      populateServerSelect();
      scrim.hidden = false;
    });
    if (closeBtn) closeBtn.addEventListener('click', () => scrim.hidden = true);
    if (cancelBtn) cancelBtn.addEventListener('click', () => scrim.hidden = true);
    if (scrim) scrim.addEventListener('click', (e) => { if (e.target === scrim) scrim.hidden = true; });

    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const serverId = fd.get('serverId');
      const servers = window._sreState?.servers || [];
      const server = servers.find((s) => s.id === serverId);
      const tags = (fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);

      const ok = await createIncident({
        title: fd.get('title'),
        severity: fd.get('severity'),
        serverId,
        serverName: server?.name || '',
        description: fd.get('description'),
        assignee: fd.get('assignee'),
        tags,
      });
      if (ok) {
        scrim.hidden = true;
        form.reset();
      }
    });
  }

  function populateServerSelect() {
    const sel = document.getElementById('incServerSelect');
    if (!sel) return;
    const servers = window._sreState?.servers || [];
    sel.innerHTML = servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  // Also allow creating from dashboard AI analysis
  function createFromAnalysis(analysis, serverId, serverName) {
    return createIncident({
      title: analysis.summary || 'Incident from AI analysis',
      severity: analysis.severity || 'warning',
      serverId,
      serverName,
      source: 'ai-analysis',
      description: analysis.rootCause || '',
      analysis,
      tags: ['ai-detected'],
    });
  }

  return { load, render, handleWsIncident, initModal, createFromAnalysis, updateBadge };
})();
