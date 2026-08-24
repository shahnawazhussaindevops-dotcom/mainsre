/* ═══════════════════════════════════════════════════════════════════════
   SREAI — Client-side hash router.
   Minimal SPA router: hash-based (#/dashboard, #/godmode, etc.)
   ═════════════════════════════════════════════════════════════════════ */
'use strict';

window.Router = (() => {
  const routes = new Map();   // path -> { onEnter, onLeave, el }
  let currentRoute = null;
  let currentPath = null;

  function register(path, { onEnter, onLeave, el }) {
    routes.set(path, { onEnter, onLeave, el });
  }

  function navigate(path) {
    if (path === currentPath) return;
    window.location.hash = path;
  }

  function handleHash() {
    const hash = window.location.hash.replace(/^#/, '') || '/dashboard';
    const route = routes.get(hash);

    // Leave current
    if (currentRoute && currentRoute.onLeave) {
      currentRoute.onLeave();
    }
    if (currentRoute && currentRoute.el) {
      currentRoute.el.hidden = true;
    }

    // Enter new
    if (route) {
      currentRoute = route;
      currentPath = hash;
      if (route.el) route.el.hidden = false;
      if (route.onEnter) route.onEnter();
    } else {
      // Fallback to dashboard
      const dashboard = routes.get('/dashboard');
      if (dashboard) {
        currentRoute = dashboard;
        currentPath = '/dashboard';
        if (dashboard.el) dashboard.el.hidden = false;
        if (dashboard.onEnter) dashboard.onEnter();
      }
    }

    // Update nav active state
    document.querySelectorAll('.nav-link').forEach((link) => {
      const href = link.dataset.route;
      link.classList.toggle('active', href === (currentPath || '/dashboard'));
    });
  }

  function init() {
    window.addEventListener('hashchange', handleHash);
    // Don't auto-navigate yet — let app.js boot first and call start()
  }

  function start() {
    handleHash();
  }

  function current() {
    return currentPath;
  }

  return { register, navigate, init, start, current };
})();
