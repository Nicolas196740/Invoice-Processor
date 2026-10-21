import { createClient } from '@supabase/supabase-js';

// These two values are safe to be public (they are in the browser by design).
// Secrets like the service role key live only in Netlify environment variables.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY (see .env.example).');

export const supabase = createClient(url, key);
