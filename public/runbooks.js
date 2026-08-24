/* ═══════════════════════════════════════════════════════════════════════
   SREAI — Runbooks Library Page
   Browse, view, and create runbooks.
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

window.Runbooks = (() => {
  let runbooks = [];
  let selectedRunbook = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function load() {
    try {
      const res = await fetch('/api/runbooks');
      runbooks = await res.json();
    } catch {
      runbooks = [];
    }
    render();
  }

  function render() {
    const el = document.getElementById('rbGrid');
    if (!el) return;

    const searchTerm = (document.getElementById('rbSearch')?.value || '').toLowerCase();
    const category = document.getElementById('rbCategoryFilter')?.value || '';

    let filtered = runbooks;
    if (category) {
      filtered = filtered.filter(rb => rb.category === category);
    }
    if (searchTerm) {
      filtered = filtered.filter(rb => 
        rb.name.toLowerCase().includes(searchTerm) || 
        rb.description.toLowerCase().includes(searchTerm) ||
        rb.tags.some(t => t.toLowerCase().includes(searchTerm))
      );
    }

    if (!filtered.length) {
      el.innerHTML = '<div class="empty" style="grid-column:1/-1">No runbooks found matching the criteria.</div>';
      return;
    }

    el.innerHTML = filtered.map((rb) => `
      <div class="rb-card" data-id="${rb.id}">
        <div class="rb-card-name">${esc(rb.name)}</div>
        <div class="rb-card-desc">${esc(rb.description)}</div>
        <div class="rb-card-meta">
          <span class="rb-card-tag rb-card-cat">${esc(rb.category)}</span>
          <span class="rb-card-tag rb-card-steps">${rb.steps.length} steps</span>
          ${rb.builtin ? '<span class="rb-card-tag rb-card-builtin">built-in</span>' : ''}
          <span class="rb-card-tag">~${rb.estimatedMinutes}m</span>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('.rb-card').forEach((card) => {
      card.addEventListener('click', () => {
        const rb = runbooks.find((r) => r.id === card.dataset.id);
        if (rb) renderDetail(rb);
      });
    });

    if (selectedRunbook) {
      const fresh = runbooks.find((r) => r.id === selectedRunbook.id);
      if (fresh) renderDetail(fresh);
      else closeDetail();
    }
  }

  function renderDetail(rb) {
    selectedRunbook = rb;
    const panel = document.getElementById('rbDetailPanel');
    const el = document.getElementById('rbDetail');
    if (!panel || !el) return;
    panel.hidden = false;

    el.innerHTML = `
      <div class="rb-detail-header">
        <div>
          <div class="rb-detail-title">${esc(rb.name)}</div>
          <div style="font-size:13px;color:var(--muted);margin-top:6px">${esc(rb.description)}</div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <span class="status-badge ${rb.severity === 'critical' ? 'failed' : rb.severity === 'warning' ? 'partial' : 'success'}">${esc(rb.severity)}</span>
            <span class="status-badge" style="background:rgba(255,255,255,0.1);color:var(--ink)">${esc(rb.category)}</span>
            ${rb.builtin ? '<span class="status-badge" style="background:rgba(255,255,255,0.05);color:var(--faint)">built-in (read-only)</span>' : ''}
          </div>
        </div>
        <button class="rb-detail-close" id="rbDetailClose">×</button>
      </div>
      
      <div style="display:flex;gap:10px;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--brd-2)">
        <button class="btn primary small" id="rbExecuteBtn">🚀 Execute in Automation Engine</button>
        ${!rb.builtin ? `<button class="btn ghost" id="rbDeleteBtn" style="color:var(--red)">🗑 Delete Runbook</button>` : ''}
      </div>

      <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);margin-bottom:12px">Execution Steps (${rb.steps.length})</div>
      <div>
        ${rb.steps.map(s => `
          <div class="rb-step">
            <div class="rb-step-header">
              <div class="rb-step-num">${s.order}</div>
              <div class="rb-step-title">${esc(s.title)}</div>
              <div class="rb-step-risk" style="color:var(${s.risk === 'safe' ? '--green' : s.risk === 'destructive' ? '--red' : '--amber'})">${s.risk}</div>
            </div>
            ${s.description ? `<div class="rb-step-desc">${esc(s.description)}</div>` : ''}
            <div class="rb-step-cmd">${esc(s.command)}</div>
          </div>
        `).join('')}
      </div>
    `;

    el.querySelector('#rbDetailClose').addEventListener('click', closeDetail);
    
    el.querySelector('#rbExecuteBtn').addEventListener('click', () => {
      // Jump to automation page and select this runbook
      if (window.Automation && typeof window.Automation.runQuickAutomate === 'function') {
        const serverId = window._sreState?.selectedId || '';
        window.Automation.runQuickAutomate(rb.id, serverId);
      }
    });

    el.querySelector('#rbDeleteBtn')?.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to delete this custom runbook?')) return;
      try {
        await fetch(`/api/runbooks/${rb.id}`, { method: 'DELETE' });
        closeDetail();
        load();
      } catch (e) {
        alert('Failed to delete: ' + e.message);
      }
    });
  }

  function closeDetail() {
    const panel = document.getElementById('rbDetailPanel');
    if (panel) panel.hidden = true;
    selectedRunbook = null;
  }

  function init() {
    document.getElementById('rbSearch')?.addEventListener('input', render);
    document.getElementById('rbCategoryFilter')?.addEventListener('change', render);
    
    document.getElementById('createRunbookBtn')?.addEventListener('click', () => {
      alert('Custom runbook creation builder coming soon! For now, use the API directly via POST /api/runbooks');
    });
  }

  return { load, render, init };
})();
