-- Security lockdown: every signed-in user sees ONLY their own data.
-- (Existing policies are changed in place with ALTER POLICY.)
--
-- Writing invoices, lines and AI jobs stays server-only on purpose: the Netlify Functions check the math,
-- the duplicates and the daily limit, then write with the user's id taken from their verified session.
-- So there are no insert/update policies for the browser on those tables.

-- ───────── Profiles: only your own (it holds name + email) ─────────
alter policy "signed-in users read profiles" on public.profiles rename to "users read own profile";
alter policy "users read own profile" on public.profiles using ((select auth.uid()) = id);

-- ───────── Invoices: only your own ─────────
alter policy "signed-in users read invoices" on public.invoices rename to "users read own invoices";
alter policy "users read own invoices" on public.invoices using ((select auth.uid()) = user_id);

-- ───────── Invoice lines: only lines of your own invoices ─────────
alter policy "signed-in users read lines" on public.invoice_lines rename to "users read own invoice lines";
alter policy "users read own invoice lines" on public.invoice_lines using (
  exists (select 1 from public.invoices i where i.id = invoice_id and i.user_id = (select auth.uid()))
);

-- ai_jobs already had "users read own jobs" (user_id = auth.uid()).

-- ───────── Storage: the "invoices" bucket, only inside your own folder (<your user id>/...) ─────────
-- Supabase only lets us ADD policies on storage.objects (not change the old "read invoice pdfs" one).
-- A RESTRICTIVE policy is ANDed with every other policy, so this limits all reads in the "invoices" bucket
-- to your own folder, whatever other policies say. Other buckets are not affected.
create policy "invoices bucket: only own folder (read)" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'invoices' or (storage.foldername(name))[1] = (select auth.uid())::text);
-- (upload was already limited to your own folder)
create policy "delete own invoice pdfs" on storage.objects for delete to authenticated using (
  bucket_id = 'invoices' and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- ───────── Daily limit on AI reads ─────────
-- Counts the user's reads since midnight (Florida time) and creates the job only if they are under the limit.
-- The lock makes 20 clicks at the same moment still count one by one. Returns null when the limit is reached.
create function public.start_ai_job(p_user uuid, p_pdf_path text, p_limit int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  used int;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_jobs:' || p_user::text, 0));
  select count(*) into used from public.ai_jobs
   where user_id = p_user
     and created_at >= (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York');
  if used >= p_limit then
    return null;
  end if;
  insert into public.ai_jobs (user_id, pdf_path) values (p_user, p_pdf_path) returning id into new_id;
  return new_id;
end $$;
revoke execute on function public.start_ai_job(uuid, text, int) from public, anon, authenticated;
grant execute on function public.start_ai_job(uuid, text, int) to service_role;
