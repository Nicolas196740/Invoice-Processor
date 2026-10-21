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

// ───────── Path checks: the user id ALWAYS comes from the verified session, never from the browser ─────────

/** True only for a PDF directly in the user's own pending folder: "<user id>/pending/<name>.pdf". */
export function isOwnPendingPath(userId, path) {
  return typeof path === 'string' && new RegExp('^' + userId + '/pending/[\\w-]+\\.pdf$').test(path);
}

/** True for a file somewhere inside the user's own folder (checked before creating a PDF link). */
export function isInOwnFolder(userId, path) {
  return typeof path === 'string' && path.startsWith(userId + '/') && !path.split('/').includes('..');
}
