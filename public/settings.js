/* ═══════════════════════════════════════════════════════════════════════
   SREAI — Settings Page
   Configure alert thresholds, AI provider, and global preferences.
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

window.Settings = (() => {
  let settings = null;

  async function load() {
    try {
      const res = await fetch('/api/settings');
      settings = await res.json();
    } catch {
      settings = null;
    }
    render();
  }

  function render() {
    const el = document.getElementById('settingsGrid');
    if (!el || !settings) return;

    el.innerHTML = `
      <div class="settings-card">
        <div class="settings-card-title">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>
          Alert Thresholds
        </div>
        <div style="font-size:12px;color:var(--faint);margin-bottom:16px;line-height:1.5">
          Configure when SREAI should flag servers as Warning (amber) or Critical (red).
        </div>
        
        <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">CPU Usage (%)</div>
        <div class="settings-row">
          <span class="settings-label">Warning Threshold</span>
          <input type="number" class="settings-input" id="set_cpu_warn" value="${settings.thresholds?.cpu?.warning || 70}" min="1" max="99">
        </div>
        <div class="settings-row">
          <span class="settings-label">Critical Threshold</span>
          <input type="number" class="settings-input" id="set_cpu_crit" value="${settings.thresholds?.cpu?.critical || 90}" min="1" max="100">
        </div>
        
        <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px">Memory Usage (%)</div>
        <div class="settings-row">
          <span class="settings-label">Warning Threshold</span>
          <input type="number" class="settings-input" id="set_mem_warn" value="${settings.thresholds?.mem?.warning || 80}" min="1" max="99">
        </div>
        <div class="settings-row">
          <span class="settings-label">Critical Threshold</span>
          <input type="number" class="settings-input" id="set_mem_crit" value="${settings.thresholds?.mem?.critical || 92}" min="1" max="100">
        </div>

        <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px">Disk Usage (%)</div>
        <div class="settings-row">
          <span class="settings-label">Warning Threshold</span>
          <input type="number" class="settings-input" id="set_disk_warn" value="${settings.thresholds?.disk?.warning || 85}" min="1" max="99">
        </div>
        <div class="settings-row">
          <span class="settings-label">Critical Threshold</span>
          <input type="number" class="settings-input" id="set_disk_crit" value="${settings.thresholds?.disk?.critical || 95}" min="1" max="100">
        </div>
        
        <div style="margin-top:16px;text-align:right">
          <button class="btn primary small" id="saveThresholdsBtn">Save Thresholds</button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>
          Automation & AI
        </div>
        <div style="font-size:12px;color:var(--faint);margin-bottom:16px;line-height:1.5">
          Configure autonomous behavior and AI provider settings.
        </div>
        
        <div class="settings-row">
          <div>
            <div class="settings-label" style="color:var(--ink)">Auto-create Incidents</div>
            <div style="font-size:11px;color:var(--faint);margin-top:4px">Automatically create incidents when metrics cross critical thresholds.</div>
          </div>
          <div class="settings-toggle ${settings.autoIncident ? 'on' : ''}" id="toggleAutoInc"></div>
        </div>
        
        <div class="settings-row">
          <span class="settings-label">Polling Refresh (ms)</span>
          <input type="number" class="settings-input" id="set_refresh" value="${settings.refreshMs || 3000}" min="1000" step="1000" disabled>
          <div style="font-size:10px;color:var(--faint);position:absolute;margin-top:35px;right:0">Change via .env</div>
        </div>
      </div>
    `;

    document.getElementById('saveThresholdsBtn')?.addEventListener('click', async () => {
      const patch = {
        thresholds: {
          cpu: {
            warning: Number(document.getElementById('set_cpu_warn').value),
            critical: Number(document.getElementById('set_cpu_crit').value)
          },
          mem: {
            warning: Number(document.getElementById('set_mem_warn').value),
            critical: Number(document.getElementById('set_mem_crit').value)
          },
          disk: {
            warning: Number(document.getElementById('set_disk_warn').value),
            critical: Number(document.getElementById('set_disk_crit').value)
          }
        }
      };
      await save(patch);
      alert('Thresholds saved successfully.');
    });

    document.getElementById('toggleAutoInc')?.addEventListener('click', async (e) => {
      const el = e.currentTarget;
      const isNowOn = !el.classList.contains('on');
      el.classList.toggle('on', isNowOn);
      await save({ autoIncident: isNowOn });
    });
  }

  async function save(patch) {
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      });
      settings = await res.json();
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }

  return { load, render };
})();
