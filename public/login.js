document.addEventListener('DOMContentLoaded', async () => {
  const btnGoogle = document.getElementById('btnGoogle');
  const btnGithub = document.getElementById('btnGithub');
  const authError = document.getElementById('authError');

  // Fetch Supabase configuration from backend
  let supabase = null;
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      authError.textContent = 'Configuration missing: Please set SUPABASE_URL and SUPABASE_ANON_KEY on the server.';
      // Disable buttons
      [btnGoogle, btnGithub].forEach(b => {
        if(b) {
          b.disabled = true;
          b.style.opacity = '0.5';
          b.style.cursor = 'not-allowed';
        }
      });
      return;
    }
    
    supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    
    // Check if user is already logged in
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      window.location.href = '/';
      return;
    }
  } catch (err) {
    authError.textContent = 'Failed to load configuration.';
    return;
  }

  function showError(msg) {
    authError.textContent = msg;
  }

  // ── OAuth Logins ──────────────────────────────────────────────
  btnGoogle.addEventListener('click', async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + '/'
        }
      });
      if (error) throw error;
    } catch (e) {
      showError(e.message);
    }
  });

  btnGithub.addEventListener('click', async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: window.location.origin + '/'
        }
      });
      if (error) throw error;
    } catch (e) {
      showError(e.message);
    }
  });
});
