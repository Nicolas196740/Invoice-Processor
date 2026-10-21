import { createClient } from '@supabase/supabase-js';

/** Server-only Supabase client. The service role key skips Row Level Security, so it never goes to the browser. */
export function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the Netlify environment variables.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Returns the signed-in user from the "Authorization: Bearer <token>" header, checked with Supabase. */
export async function requireUser(req, db) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw httpError(401, 'Please sign in again.');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw httpError(401, 'Please sign in again.');
  return data.user;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
