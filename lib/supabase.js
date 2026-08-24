import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// We use the service role key for backend operations so we can bypass RLS if needed,
// but usually we should use the anon key + user JWT to act on behalf of the user.
export const supabase = supabaseUrl && (supabaseServiceKey || supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey) 
  : null;

// Middleware to extract user from Authorization header
export async function authMiddleware(req, res, next) {
  if (!supabase) {
    // If Supabase isn't configured, we fallback to single-tenant local mode for development
    req.user = { id: 'local-dev-user' };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = user;
  next();
}
