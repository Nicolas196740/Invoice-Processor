-- Step 2: one row per "read this invoice" request.
-- The background function fills in the result; the phone checks this row every 2 seconds.
create table public.ai_jobs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  pdf_path   text not null,
  status     text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  result     jsonb,
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_jobs_user_id_idx on public.ai_jobs (user_id);

-- Users can only see their own jobs. Only the server (service role) creates or updates them.
alter table public.ai_jobs enable row level security;
create policy "users read own jobs" on public.ai_jobs for select to authenticated
  using ((select auth.uid()) = user_id);
