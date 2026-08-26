/* ═══════════════════════════════════════════════════════════════════════
   SREAI — Main Application Bootstrap
   Initializes router, websocket, and global state.
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

// Global state shared across modules
window._sreState = {
  servers: [],
  telemetry: new Map(),
  selectedId: null,
};

const App = (async () => {
  let ws;

  const esc = (s) => String(s || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);

  // --- Auth Guard ---
  let token = null;
  let user = null;
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    if (config.supabaseUrl && config.supabaseAnonKey) {
      const supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
      
      // If returning from an OAuth redirect (PKCE code in query or implicit token in hash)
      if (window.location.hash.includes('access_token') || window.location.search.includes('code=')) {
        await new Promise((resolve) => {
          const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (session) {
              subscription.unsubscribe();
              resolve();
            }
          });
          // Timeout after 3 seconds to avoid indefinite hang
          setTimeout(() => { subscription.unsubscribe(); resolve(); }, 3000);
        });
      }

      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        window.location.href = '/login.html';
        return; // Stop execution
      }
      token = data.session.access_token;
      user = data.session.user;
      
      // Clear the sensitive code/token from the URL bar for cleanliness and security
      if (window.location.search.includes('code=') || window.location.hash.includes('access_token')) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  } catch (e) {
    console.warn('Auth check failed or not configured, continuing locally.', e);
  }

  // Helper to add auth headers
  const fetchApi = async (url, options = {}) => {
    if (!options.headers) options.headers = {};
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    return fetch(url, options);
  };

  // --- WebSocket ---
  function connectWs() {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${loc.host}/?token=${token || ''}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      document.getElementById('liveState').dataset.live = 'on';
      document.getElementById('liveLabel').textContent = 'live';
    };

    ws.onclose = () => {
      document.getElementById('liveState').dataset.live = 'off';
      document.getElementById('liveState').textContent = 'Live (HTTP Polling)';
      
      // Fallback for Vercel / Serverless where WebSockets aren't supported
      if (!window.pollingInterval) {
        window.pollingInterval = setInterval(async () => {
          try {
            const res = await fetchApi('/api/telemetry');
            if (!res.ok) return;
            const data = await res.json();
            
            // Simulate WebSocket messages for inventory and telemetry
            if (data.servers) {
              handleMessage({ type: 'inventory', servers: data.servers });
            }
            if (data.telemetry) {
              data.telemetry.forEach(t => handleMessage({ type: 'telemetry', data: t }));
            }
            if (data.logs) {
              data.logs.forEach(msg => handleMessage(msg));
            }
          } catch (e) {
            console.warn('HTTP Polling error:', e);
          }
        }, 3000);
      }
      document.getElementById('liveLabel').textContent = 'reconnecting…';
      setTimeout(connectWs, 3000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch (err) {
        console.error('WS parse err:', err);
      }
    };
  }

  function handleMessage(msg) {
    if (msg.type === 'inventory') {
      window._sreState.servers = msg.servers || [];
      renderServerList();
      if (!window._sreState.selectedId && window._sreState.servers.length > 0) {
        window._sreState.selectedId = window._sreState.servers[0].id;
        if (Router.current() === '/dashboard') renderDashboard();
      }
    } else if (msg.type === 'telemetry') {
      const t = msg.data;
      window._sreState.telemetry.set(t.id, t);
      updateServerSidebarStats(t.id);
      
      if (t.id === window._sreState.selectedId && Router.current() === '/dashboard') {
        renderDashboard();
      }
      
      if (window.GodMode) {
        window.GodMode.trackStatusChange(t);
        if (Router.current() === '/godmode') window.GodMode.render();
      }
    } else if (msg.type === 'log') {
      if (msg.serverId === window._sreState.selectedId && Router.current() === '/dashboard') {
        Dashboard.appendLogs(msg.lines);
      }
    } else if (msg.type === 'incident') {
      if (window.Incidents) window.Incidents.handleWsIncident(msg);
      if (window.GodMode && Router.current() === '/godmode') window.GodMode.render();
    } else if (msg.type === 'automation' || msg.type === 'automation_step') {
      if (window.Automation) window.Automation.handleWsMsg(msg);
    }
  }

  // --- Sidebar & General UI ---
  function renderServerList() {
    const list = document.getElementById('serverList');
    if (!list) return;
    
    document.getElementById('serverCount').textContent = window._sreState.servers.length;
    
    list.innerHTML = window._sreState.servers.map((s) => `
      <li class="srv ${s.id === window._sreState.selectedId ? 'active' : ''}" data-id="${s.id}">
        <div class="srv-top">
          <div class="srv-dot" id="dot-${s.id}"></div>
          <div class="srv-name" title="${esc(s.name)}">${esc(s.name)}</div>
        </div>
        <div class="srv-host">${esc(s.host)}:${s.port || 22}</div>
        <div class="srv-cpu" id="scpu-${s.id}">—</div>
        <button class="srv-del" data-del="${s.id}" title="Remove server">×</button>
      </li>
    `).join('');

    list.querySelectorAll('.srv').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.srv-del')) return;
        window._sreState.selectedId = el.dataset.id;
        renderServerList(); // update active class
        if (Router.current() === '/dashboard') renderDashboard();
      });
    });

    list.querySelectorAll('.srv-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this server?')) return;
        const id = btn.dataset.del;
        await fetchApi('/api/servers/' + id, { method: 'DELETE' });
        if (window._sreState.selectedId === id) window._sreState.selectedId = null;
      });
    });

    // Backfill stats if we already have telemetry
    for (const [id, t] of window._sreState.telemetry.entries()) {
      updateServerSidebarStats(id);
    }
  }

  function updateServerSidebarStats(id) {
    const t = window._sreState.telemetry.get(id);
    const dot = document.getElementById(`dot-${id}`);
    const scpu = document.getElementById(`scpu-${id}`);
    if (dot && t) {
      if (!t.ok) {
        dot.style.background = 'var(--faint)';
        dot.style.boxShadow = 'none';
        if (scpu) scpu.textContent = 'err';
      } else {
        const st = t.status || 'unknown';
        const color = st === 'healthy' ? 'var(--green)' : st === 'warning' ? 'var(--amber)' : 'var(--red)';
        dot.style.background = color;
        dot.style.boxShadow = `0 0 6px ${color}`;
        if (scpu) scpu.textContent = Math.round(t.cpuPct || 0) + '%';
      }
    }
  }

  // --- Add Server Modal ---
  function initAddServer() {
    const scrim = document.getElementById('modalScrim');
    const form = document.getElementById('addForm');
    const authOpts = document.querySelectorAll('.auth-opt');
    let currentAuth = 'password';

    document.getElementById('addServerBtn')?.addEventListener('click', () => {
      scrim.hidden = false;
      form.reset();
      hideMsg();
    });
    
    document.getElementById('modalClose')?.addEventListener('click', () => scrim.hidden = true);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) scrim.hidden = true; });

    authOpts.forEach(b => b.addEventListener('click', () => {
      authOpts.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      currentAuth = b.dataset.auth;
      document.getElementById('pwField').hidden = currentAuth !== 'password';
      document.getElementById('keyFields').hidden = currentAuth !== 'key';
    }));

    function hideMsg() {
      const m = document.getElementById('modalMsg');
      m.hidden = true; m.className = 'modal-msg'; m.textContent = '';
    }

    function showMsg(ok, text) {
      const m = document.getElementById('modalMsg');
      m.hidden = false; m.className = 'modal-msg ' + (ok ? 'ok' : 'err'); m.textContent = text;
    }

    function getFormData() {
      const fd = new FormData(form);
      return {
        name: fd.get('name') || fd.get('host'),
        host: fd.get('host'),
        port: parseInt(fd.get('port')) || 22,
        username: fd.get('username'),
        password: currentAuth === 'password' ? fd.get('password') : undefined,
        privateKey: currentAuth === 'key' ? fd.get('privateKey') : undefined,
        passphrase: currentAuth === 'key' ? fd.get('passphrase') : undefined,
      };
    }

    document.getElementById('testBtn')?.addEventListener('click', async () => {
      if (!form.checkValidity()) return form.reportValidity();
      const btn = document.getElementById('testBtn');
      btn.disabled = true; btn.textContent = 'Testing…'; hideMsg();
      try {
        const testRes = await fetchApi('/api/test', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(getFormData())
        });
        const d = await testRes.json();
        showMsg(d.ok, d.ok ? 'Connection successful!' : `Error: ${d.error}`);
      } catch (e) {
        showMsg(false, e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Test connection';
      }
    });

    document.getElementById('addLocalBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('addLocalBtn');
      btn.disabled = true; btn.textContent = 'Adding…'; hideMsg();
      try {
        const res = await fetchApi('/api/servers', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Local Machine', host: 'localhost', kind: 'local' })
        });
        if (res.ok) {
          scrim.hidden = true;
          form.reset();
        } else {
          const d = await res.json();
          showMsg(false, d.error || 'Failed to add local machine');
        }
      } catch (e) {
        showMsg(false, e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Monitor this laptop';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('saveBtn');
      btn.disabled = true; btn.textContent = 'Saving…'; hideMsg();
      try {
        const res = await fetchApi('/api/servers', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(getFormData())
        });
        if (res.ok) {
          scrim.hidden = true;
          form.reset();
        } else {
          const d = await res.json();
          showMsg(false, d.error || 'Failed to save');
        }
      } catch (e) {
        showMsg(false, e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Add & monitor';
      }
    });
  }

  // --- Topology (Three.js) ---
  const Topo = (() => {
    let scene, camera, renderer, nodes = [], links = [];
    let raf, width, height, canvasEl, container;
    
    function init() {
      container = document.getElementById('topoCanvas');
      if (!container || typeof THREE === 'undefined') return;
      canvasEl = document.createElement('canvas');
      container.appendChild(canvasEl);
      
      const rect = container.getBoundingClientRect();
      width = rect.width; height = rect.height || 300;
      
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(45, width/height, 0.1, 1000);
      camera.position.z = 18;
      
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      // Lights
      const amb = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(amb);
      const dir1 = new THREE.DirectionalLight(0x35e5ff, 1);
      dir1.position.set(5, 5, 5);
      scene.add(dir1);
      const dir2 = new THREE.DirectionalLight(0x8a7cff, 1.2);
      dir2.position.set(-5, -5, -2);
      scene.add(dir2);

      // Starfield
      const geom = new THREE.BufferGeometry();
      const pos = [];
      for(let i=0; i<300; i++) {
        pos.push((Math.random()-0.5)*40, (Math.random()-0.5)*40, (Math.random()-0.5)*40);
      }
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ color: 0x8791a5, size: 0.1, transparent: true, opacity: 0.5 });
      const stars = new THREE.Points(geom, mat);
      scene.add(stars);

      let angle = 0;
      let isDragging = false, prevX = 0, prevY = 0;
      let targetRotX = 0, targetRotY = 0;

      container.addEventListener('mousedown', (e) => { isDragging = true; prevX = e.clientX; prevY = e.clientY; });
      window.addEventListener('mouseup', () => { isDragging = false; });
      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        targetRotY += (e.clientX - prevX) * 0.01;
        targetRotX += (e.clientY - prevY) * 0.01;
        prevX = e.clientX; prevY = e.clientY;
      });

      function renderLoop() {
        if (!document.getElementById('pageDashboard').hidden) {
          if (!isDragging) targetRotY += 0.002; // auto rotate
          scene.rotation.y += (targetRotY - scene.rotation.y) * 0.1;
          scene.rotation.x += (targetRotX - scene.rotation.x) * 0.1;
          renderer.render(scene, camera);
        }
        raf = requestAnimationFrame(renderLoop);
      }
      raf = requestAnimationFrame(renderLoop);
    }
    
    function update() {
      if (!scene) return;
      const t = window._sreState.telemetry.get(window._sreState.selectedId);
      if (!t || !t.ok) return;

      // Clear old
      nodes.forEach(n => scene.remove(n));
      links.forEach(l => scene.remove(l));
      nodes = []; links = [];

      // Extract unique pods/services
      const items = [];
      const seen = new Set();
      for (const w of t.workloads || []) {
        let name = w.name;
        // grouping hack
        if (w.kind === 'pod') name = name.replace(/-[a-z0-9]{10}-[a-z0-9]{5}$/, '');
        if (!seen.has(name)) { seen.add(name); items.push({ name, kind: w.kind }); }
      }
      
      if (items.length === 0) {
        items.push({ name: 'System', kind: 'host' });
      }

      // Central node (server)
      const cGeo = new THREE.IcosahedronGeometry(1.2, 1);
      const cMat = new THREE.MeshStandardMaterial({ 
        color: t.status === 'healthy' ? 0x37e39b : t.status === 'warning' ? 0xffce5c : 0xff5c7c,
        wireframe: true, transparent: true, opacity: 0.8
      });
      const cMesh = new THREE.Mesh(cGeo, cMat);
      scene.add(cMesh);
      nodes.push(cMesh);

      // Orbit nodes
      const count = items.length;
      for (let i=0; i<count; i++) {
        const phi = Math.acos(-1 + (2 * i) / count);
        const theta = Math.sqrt(count * Math.PI) * phi;
        const r = 5 + Math.random() * 2;
        
        const geo = new THREE.SphereGeometry(0.4, 16, 16);
        const mat = new THREE.MeshStandardMaterial({ color: items[i].kind === 'pod' ? 0x8a7cff : 0x35e5ff });
        const mesh = new THREE.Mesh(geo, mat);
        
        mesh.position.setFromSphericalCoords(r, phi, theta);
        scene.add(mesh);
        nodes.push(mesh);
        
        // Link to center
        const lGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), mesh.position]);
        const lMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1 });
        const line = new THREE.Line(lGeo, lMat);
        scene.add(line);
        links.push(line);
      }
    }

    return { init, update };
  })();

  // --- Dashboard Logic ---
  const Dashboard = (() => {
    function setGauge(id, val) {
      const g = document.querySelector(`.gauge[data-metric="${id}"]`);
      if (!g) return;
      g.querySelector('span').textContent = Math.round(val);
      const circle = g.querySelector('.g-fill');
      const maxOffset = 326.7;
      const color = val >= 90 ? 'var(--red)' : val >= 75 ? 'var(--amber)' : 'var(--cyan)';
      circle.style.strokeDashoffset = maxOffset - (maxOffset * val) / 100;
      circle.style.stroke = color;
    }

    function render() {
      const id = window._sreState.selectedId;
      const t = window._sreState.telemetry.get(id);
      
      if (!id || !t) {
        document.getElementById('selName').textContent = '—';
        document.getElementById('selHost').textContent = 'Select a server';
        return;
      }

      document.getElementById('selName').textContent = t.name;
      document.getElementById('selHost').textContent = `${t.host} (${t.kind})`;
      document.getElementById('selMeta').textContent = `OS: ${t.os || 'unknown'} · Uptime: ${t.uptime || '—'}`;

      if (!t.ok) {
        document.getElementById('scoreNum').textContent = 'ERR';
        document.getElementById('scoreNum').style.color = 'var(--red)';
        setGauge('cpu', 0); setGauge('mem', 0); setGauge('disk', 0);
        return;
      }

      const score = t.score || 0;
      const scoreCol = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--amber)' : 'var(--red)';
      const sEl = document.getElementById('scoreNum');
      sEl.textContent = score;
      sEl.style.color = scoreCol;

      setGauge('cpu', t.cpuPct || 0);
      setGauge('mem', t.memPct || 0);
      setGauge('disk', t.diskPct || 0);

      // Facts
      const dl = document.getElementById('factList');
      dl.innerHTML = `
        <dt>Kernel</dt><dd>${esc(t.kernel || '—')}</dd>
        <dt>CPU cores</dt><dd>${t.cores || '—'}</dd>
        <dt>Memory</dt><dd>${t.memTotal || '—'}</dd>
        <dt>Disk</dt><dd>${t.diskMount || '/'} (${t.diskTotal || '—'})</dd>
      `;

      if (t.load && t.load.length) {
        document.getElementById('loadWrap').hidden = false;
        document.getElementById('loadVals').textContent = t.load.join(', ');
      }

      // Procs
      const pl = document.getElementById('procList');
      if (t.procs && t.procs.length) {
        pl.innerHTML = t.procs.slice(0, 8).map(p => {
          let parts = p.cmd.split('/');
          let name = parts[parts.length - 1] || p.cmd;
          if (name.length > 25) name = name.substring(0, 22) + '...';
          const max = 100;
          const w = Math.min(100, Math.max(2, (p.cpu / max) * 100));
          return `
            <div class="proc">
              <div class="proc-name">${esc(name)} <span>(PID ${p.pid})</span></div>
              <div class="proc-val">${p.cpu}%</div>
              <div class="proc-bar-wrap"><div class="proc-bar" style="width:${w}%"></div></div>
            </div>
          `;
        }).join('');
      } else {
        pl.innerHTML = '<div class="empty">No process data</div>';
      }

      // Workloads
      const wl = document.getElementById('workloads');
      if (t.workloads && t.workloads.length) {
        const pods = t.workloads.filter(w => w.kind === 'pod');
        const cont = t.workloads.filter(w => w.kind === 'container');
        
        let h = '';
        if (pods.length) {
          h += `<div class="wl-group-cap">K8s Pods</div><div class="wl-chips">`;
          h += pods.slice(0, 15).map(w => `<div class="wl-chip ${w.status==='Running'?'':'bad'}" title="${esc(w.name)}"><div class="d"></div><div class="img">${esc(w.name.split('-')[0])}</div></div>`).join('');
          h += `</div>`;
        }
        if (cont.length) {
          if (pods.length) h += `<div style="height:12px"></div>`;
          h += `<div class="wl-group-cap">Docker</div><div class="wl-chips">`;
          h += cont.slice(0, 15).map(w => `<div class="wl-chip ${w.status.includes('Up')?'':'bad'}" title="${esc(w.image)}"><div class="d"></div><div class="img">${esc(w.image.split(':')[0].split('/').pop())}</div></div>`).join('');
          h += `</div>`;
        }
        wl.innerHTML = h;
      } else {
        wl.innerHTML = '<div class="empty">No Docker or K8s workloads found</div>';
      }

      Topo.update();
    }

    function appendLogs(lines) {
      if (!lines || !lines.length) return;
      const term = document.getElementById('terminal');
      if (!term) return;

      const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 20;

      for (const line of lines) {
        let fmt = esc(line);
        // Basic highlighting
        fmt = fmt.replace(/\b(error|failed|fatal|critical)\b/gi, '<span class="tok-err">$&</span>');
        fmt = fmt.replace(/\b(warn|warning)\b/gi, '<span class="tok-warn">$&</span>');
        fmt = fmt.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g, '<span class="tok-ip">$&</span>');
        fmt = fmt.replace(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi, '<span class="tok-num">$&</span>');

        const el = document.createElement('div');
        el.className = 'log-line';
        el.innerHTML = fmt;
        
        el.addEventListener('click', async () => {
          navigator.clipboard.writeText(line).catch(()=>{});
          el.classList.add('copied');
          setTimeout(() => el.classList.remove('copied'), 500);
          triggerAI(line);
        });
        
        term.appendChild(el);
      }

      while (term.children.length > 200) term.removeChild(term.firstChild);
      if (atBottom) term.scrollTop = term.scrollHeight;
    }

    async function triggerAI(specificLog = null, errorContext = null) {
      const btn = document.getElementById('analyzeBtn');
      const body = document.getElementById('aiBody');
      const incBtn = document.getElementById('createIncidentBtn');
      const id = window._sreState.selectedId;
      
      if (!id) return;
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div> Analyzing...';
      if (incBtn) incBtn.hidden = true;

      try {
        const res = await fetchApi('/api/analyze', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serverId: id, log: specificLog, errorContext })
        });
        const ans = await res.json();
        
        const riskClass = 'risk-' + (ans.risk || 'safe');
        
        body.innerHTML = `
          <div class="ai-sev"><div class="d" style="background:var(--${ans.severity === 'critical' ? 'red' : ans.severity === 'warning' ? 'amber' : 'cyan'})"></div>${ans.severity}</div>
          <div class="ai-summary">${esc(ans.summary)}</div>
          <div class="ai-rca">${esc(ans.rootCause)}</div>
          ${ans.command ? `
            <div class="ai-cmd-cap">Suggested Action</div>
            <div class="ai-cmd">
              ${esc(ans.command)}
              <button class="ai-copy" onclick="navigator.clipboard.writeText('${esc(ans.command)}')">copy</button>
            </div>
            <div class="ai-foot" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
              <div>
                <span class="ai-risk ${riskClass}">Risk: ${ans.risk}</span>
                ${ans.confidence ? `<span>Confidence: ${Math.round(ans.confidence * 100)}%</span>` : ''}
              </div>
              <button class="btn primary small" id="executeFixBtn">🪄 Auto-Fix</button>
            </div>
          ` : ''}
        `;

        if (ans.command) {
          const executeFixBtn = document.getElementById('executeFixBtn');
          if (executeFixBtn) {
            executeFixBtn.addEventListener('click', async () => {
              const srvName = window._sreState.telemetry.get(id)?.name || id;
              if (!confirm(`Can I run this command on ${srvName}?\n\nCommand: ${ans.command}`)) return;
              
              executeFixBtn.disabled = true;
              executeFixBtn.textContent = '⏳ Running...';
              
              try {
                const fixRes = await fetchApi('/api/execute-fix', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ serverId: id, command: ans.command })
                });
                const execInfo = await fixRes.json();
                
                // Wait for execution to finish via polling (or WebSocket, but polling is simpler here)
                let finalStatus = null;
                let finalError = null;
                for (let i = 0; i < 30; i++) {
                  await new Promise(r => setTimeout(r, 1000));
                  const pollRes = await fetchApi(`/api/automation/history/${execInfo.id}`);
                  const pollData = await pollRes.json();
                  if (pollData.status !== 'running') {
                    finalStatus = pollData.status;
                    finalError = pollData.steps?.[0]?.error;
                    break;
                  }
                }
                
                if (finalStatus === 'failed') {
                  executeFixBtn.className = 'btn small';
                  executeFixBtn.style.background = 'var(--red)';
                  executeFixBtn.textContent = '❌ Failed';
                  
                  // Trigger AI loop with error context
                  setTimeout(() => {
                    body.innerHTML = '<div style="color:var(--amber)">Command failed. Re-analyzing with error context...</div>';
                    triggerAI(specificLog, finalError || 'Command returned non-zero exit code.');
                  }, 1500);
                  
                } else if (finalStatus === 'completed') {
                  executeFixBtn.className = 'btn small';
                  executeFixBtn.style.background = 'var(--green)';
                  executeFixBtn.textContent = '✅ Fixed';
                } else {
                  executeFixBtn.textContent = 'Timeout';
                }
              } catch (e) {
                alert('Execution error: ' + e.message);
                executeFixBtn.disabled = false;
                executeFixBtn.textContent = '🪄 Auto-Fix';
              }
            });
          }
        }

        if (incBtn && window.Incidents) {
          incBtn.hidden = false;
          incBtn.onclick = async () => {
            const t = window._sreState.telemetry.get(id);
            const name = t ? t.name : '';
            const ok = await window.Incidents.createFromAnalysis(ans, id, name);
            if (ok) {
              incBtn.textContent = '✓ Created';
              incBtn.disabled = true;
            }
          };
        }

      } catch (e) {
        body.innerHTML = `<div class="tok-err">Analysis failed: ${e.message}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Analyze recent logs';
      }
    }

    return { render, appendLogs, triggerAI, init: Topo.init };
  })();

  function renderDashboard() {
    Dashboard.render();
  }

  async function boot() {
    // 1. Initial config fetch
    try {
      const c = await fetch('/api/config').then(r => r.json());
      document.getElementById('aiProvider').textContent = c.aiProvider || '—';
      document.getElementById('refreshRate').textContent = `${c.refreshMs}ms`;
    } catch {}

    // 2. Initialize pages & router
    initAddServer();
    Dashboard.init();
    
    document.getElementById('analyzeBtn')?.addEventListener('click', () => Dashboard.triggerAI());

    Router.register('/dashboard', {
      el: document.getElementById('pageDashboard'),
      onEnter: () => renderDashboard()
    });

    Router.register('/godmode', {
      el: document.getElementById('pageGodmode'),
      onEnter: () => window.GodMode && window.GodMode.render()
    });

    Router.register('/incidents', {
      el: document.getElementById('pageIncidents'),
      onEnter: () => window.Incidents && window.Incidents.load()
    });

    Router.register('/automation', {
      el: document.getElementById('pageAutomation'),
      onEnter: () => window.Automation && window.Automation.load()
    });

    Router.register('/runbooks', {
      el: document.getElementById('pageRunbooks'),
      onEnter: () => window.Runbooks && window.Runbooks.load()
    });

    Router.register('/settings', {
      el: document.getElementById('pageSettings'),
      onEnter: () => window.Settings && window.Settings.load()
    });

    // 3. Initialize module internals
    if (window.Incidents) window.Incidents.initModal();
    if (window.Runbooks) window.Runbooks.init();

    // 4. Start routing
    Router.init();
    Router.start();

    // 5. Connect WebSocket
    connectWs();
  }

  return { boot };
})();

document.addEventListener('DOMContentLoaded', async () => {
  const app = await App;
  app.boot();
});
