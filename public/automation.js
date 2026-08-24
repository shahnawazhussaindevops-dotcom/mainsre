/* ═══════════════════════════════════════════════════════════════════════
   SREAI — Automation Engine Page
   Execute runbooks on servers, view live streaming output, and history.
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

window.Automation = (() => {
  let runbooks = [];
  let history = [];
  let selectedRunbookId = null;
  let activeExecutionId = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function load() {
    try {
      const [rbRes, histRes] = await Promise.all([
        fetch('/api/runbooks'),
        fetch('/api/automation/history')
      ]);
      runbooks = await rbRes.json();
      history = await histRes.json();
    } catch {
      runbooks = [];
      history = [];
    }
    render();
  }

  function render() {
    renderRunbooks();
    renderExecPanel();
    renderHistory();
  }

  function renderRunbooks() {
    const el = document.getElementById('autoRunbooks');
    if (!el) return;

    const serverId = document.getElementById('autoTargetServer')?.value || window._sreState?.selectedId;
    const t = serverId ? window._sreState.telemetry.get(serverId) : null;
    const platform = t?.platform || 'linux'; // default to linux if unknown

    const filteredRunbooks = runbooks.filter(rb => {
      if (!rb.platforms) return true;
      if (platform === 'win32') return rb.platforms.includes('win32');
      return rb.platforms.includes('linux') || rb.platforms.includes('darwin');
    });

    if (!filteredRunbooks.length) {
      el.innerHTML = '<div class="empty">No runbooks available for this server\'s OS.</div>';
      return;
    }

    el.innerHTML = filteredRunbooks.map((rb) => `
      <div class="auto-rb-card ${rb.id === selectedRunbookId ? 'selected' : ''}" data-id="${rb.id}">
        <div class="auto-rb-name">${esc(rb.name)}</div>
        <div class="auto-rb-desc">${esc(rb.description)}</div>
        <div class="auto-rb-meta">
          <span class="auto-rb-tag" style="color:var(--cyan);border-color:rgba(53,229,255,0.3)">${esc(rb.category)}</span>
          <span class="auto-rb-tag">${rb.steps.length} steps</span>
          ${rb.builtin ? '<span class="auto-rb-tag" style="color:var(--faint)">built-in</span>' : ''}
        </div>
      </div>
    `).join('');

    el.querySelectorAll('.auto-rb-card').forEach((card) => {
      card.addEventListener('click', () => {
        selectedRunbookId = card.dataset.id;
        renderRunbooks(); // Update selection visual
        renderExecPanel();
      });
    });
  }

  function renderExecPanel() {
    const el = document.getElementById('autoExec');
    if (!el) return;

    if (!selectedRunbookId) {
      el.innerHTML = '<div class="empty" style="flex:1;display:flex;align-items:center;justify-content:center">Select a runbook from the left to execute it.</div>';
      return;
    }

    const rb = runbooks.find(r => r.id === selectedRunbookId);
    if (!rb) return;

    const servers = window._sreState?.servers || [];
    
    // If we're actively watching an execution, don't re-render the controls
    if (activeExecutionId) {
      return;
    }

    el.innerHTML = `
      <div style="font-size:16px;font-weight:600;margin-bottom:6px">${esc(rb.name)}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:16px">${esc(rb.description)}</div>
      
      <div class="auto-exec-controls">
        <select id="autoTargetServer" class="filter-select" style="flex:1">
          <option value="">-- Select target server --</option>
          ${servers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
        <button class="btn primary small" id="autoRunBtn" style="padding:9px 20px;font-size:14px">Execute Runbook</button>
      </div>
      
      <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);margin:16px 0 8px">Steps to execute</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${rb.steps.map(s => `
          <div style="padding:8px 12px;border-radius:8px;border:1px solid var(--brd-2);background:var(--panel-2);display:flex;justify-content:space-between">
            <span style="font-size:13px;font-weight:500">${s.order}. ${esc(s.title)}</span>
            <span style="font-family:var(--mono);font-size:10px;color:var(${s.risk === 'safe' ? '--green' : s.risk === 'destructive' ? '--red' : '--amber'})">${s.risk}</span>
          </div>
        `).join('')}
      </div>
    `;

    // Auto-select server if one was selected globally
    const selSrv = document.getElementById('autoTargetServer');
    if (window._sreState?.selectedId && selSrv) {
      selSrv.value = window._sreState.selectedId;
    }

    selSrv?.addEventListener('change', () => {
      renderRunbooks(); // Re-filter runbooks if server OS changes
      // If currently selected runbook isn't valid for new OS, deselect it
      const newT = window._sreState.telemetry.get(selSrv.value);
      const newPlatform = newT?.platform || 'linux';
      const isWin = newPlatform === 'win32';
      const rb = runbooks.find(r => r.id === selectedRunbookId);
      if (rb && rb.platforms) {
        const isValid = isWin ? rb.platforms.includes('win32') : (rb.platforms.includes('linux') || rb.platforms.includes('darwin'));
        if (!isValid) {
          selectedRunbookId = null;
          renderExecPanel();
        }
      }
    });

    document.getElementById('autoRunBtn')?.addEventListener('click', async () => {
      const serverId = selSrv?.value;
      if (!serverId) return alert('Please select a target server.');
      
      try {
        const res = await fetch('/api/automation/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runbookId: rb.id, serverId })
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to start execution');
        }
        const exec = await res.json();
        activeExecutionId = exec.id;
        renderActiveExecution(exec);
      } catch (e) {
        alert(e.message);
      }
    });
  }

  function renderActiveExecution(exec) {
    const el = document.getElementById('autoExec');
    if (!el) return;

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div style="font-size:16px;font-weight:600">${esc(exec.runbookName)}</div>
          <div style="font-size:12px;color:var(--faint);margin-top:4px">Target: ${esc(exec.serverName)}</div>
        </div>
        <div class="status-badge ${exec.status}" id="autoExecStatus">${exec.status === 'running' ? '⏳ RUNNING' : exec.status.toUpperCase()}</div>
      </div>
      <div class="auto-exec-terminal" id="autoExecTerm">
        ${exec.steps ? exec.steps.map(s => `
          <div class="auto-step" id="step-${s.order}">
            <div class="auto-step-title">${s.order}. ${esc(s.title)}</div>
            <div class="auto-step-status ${s.status}">Status: ${s.status}</div>
            ${s.output ? `<div class="auto-step-output">${esc(s.output)}</div>` : ''}
            ${s.error ? `<div class="auto-step-output" style="color:var(--red)">${esc(s.error)}</div>` : ''}
          </div>
        `).join('') : '<div style="color:var(--faint)">Starting execution...</div>'}
      </div>
      ${exec.status !== 'running' ? '<button class="btn ghost" id="autoExecClear" style="margin-top:12px">Clear Console</button>' : ''}
    `;

    const term = document.getElementById('autoExecTerm');
    if (term) term.scrollTop = term.scrollHeight;

    document.getElementById('autoExecClear')?.addEventListener('click', () => {
      activeExecutionId = null;
      renderExecPanel();
    });
  }

  function renderHistory() {
    const el = document.getElementById('autoHistory');
    if (!el) return;

    if (!history.length) {
      el.innerHTML = '<div class="empty">No execution history.</div>';
      return;
    }

    el.innerHTML = `
      <table class="auto-history-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Runbook</th>
            <th>Server</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${history.slice().map(h => `
            <tr style="cursor:pointer" data-id="${h.id}">
              <td style="font-family:var(--mono)">${new Date(h.startedAt).toLocaleString()}</td>
              <td style="font-weight:500">${esc(h.runbookName)}</td>
              <td>${esc(h.serverName)}</td>
              <td><span class="status-badge ${h.status}">${h.status}</span></td>
              <td style="font-family:var(--mono)">${h.totalDuration ? (h.totalDuration / 1000).toFixed(1) + 's' : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    el.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.addEventListener('click', async () => {
        try {
          const res = await fetch(`/api/automation/history/${tr.dataset.id}`);
          const exec = await res.json();
          activeExecutionId = exec.id;
          selectedRunbookId = exec.runbookId;
          renderRunbooks();
          renderActiveExecution(exec);
        } catch (e) {
          console.error(e);
        }
      });
    });
  }

  // WebSocket message handlers
  function handleWsMsg(msg) {
    if (msg.type === 'automation') {
      // Reload history
      fetch('/api/automation/history').then(r => r.json()).then(h => {
        history = h;
        if (Router.current() === '/automation') renderHistory();
      }).catch(()=>{});

      if (msg.action === 'started' && Router.current() === '/automation' && activeExecutionId !== msg.execution.id) {
        // If we started it from somewhere else, switch to it
        activeExecutionId = msg.execution.id;
        selectedRunbookId = msg.execution.runbookId;
        renderRunbooks();
        renderActiveExecution(msg.execution);
      } else if (msg.action === 'completed' && activeExecutionId === msg.execution.id) {
        // Fetch full execution to show final state
        fetch(`/api/automation/history/${activeExecutionId}`).then(r => r.json()).then(exec => {
          renderActiveExecution(exec);
        }).catch(()=>{});
      }
    } else if (msg.type === 'automation_step' && msg.executionId === activeExecutionId) {
      // Update live terminal
      const term = document.getElementById('autoExecTerm');
      if (!term) return;

      let stepEl = document.getElementById(`step-${msg.step.order}`);
      if (!stepEl) {
        // Create it if it doesn't exist (initial clear)
        if (term.innerHTML.includes('Starting execution')) term.innerHTML = '';
        stepEl = document.createElement('div');
        stepEl.className = 'auto-step';
        stepEl.id = `step-${msg.step.order}`;
        term.appendChild(stepEl);
      }

      stepEl.innerHTML = `
        <div class="auto-step-title">${msg.step.order}. ${esc(msg.step.title)}</div>
        <div class="auto-step-status ${msg.step.status}">Status: ${msg.step.status} ${msg.step.duration ? `(${msg.step.duration}ms)` : ''}</div>
        ${msg.step.output ? `<div class="auto-step-output">${esc(msg.step.output)}</div>` : ''}
        ${msg.step.error ? `<div class="auto-step-output" style="color:var(--red)">${esc(msg.step.error)}</div>` : ''}
      `;
      term.scrollTop = term.scrollHeight;
    }
  }

  function runQuickAutomate(runbookId, serverId) {
    selectedRunbookId = runbookId;
    activeExecutionId = null; // Clear previous active exec so it triggers a run
    Router.navigate('/automation');
    // We wait a tick for the page to render, then click the run button
    setTimeout(() => {
      const selSrv = document.getElementById('autoTargetServer');
      if (selSrv) selSrv.value = serverId;
      document.getElementById('autoRunBtn')?.click();
    }, 100);
  }

  return { load, render, handleWsMsg, runQuickAutomate };
})();
