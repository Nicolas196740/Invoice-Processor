-- Security tests for the real database. Safe to run any time in Supabase → SQL Editor:
-- everything happens inside a transaction that is rolled back at the end, so nothing is kept.
-- Creates two fake users A and B, gives each an invoice (+ lines), an AI job and a PDF record,
-- then checks what A can see and do. Any failure stops with an error saying which check failed.
begin;

do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000000a';
  c uuid := '00000000-0000-4000-8000-00000000000c';
  b uuid := '00000000-0000-4000-8000-00000000000b';
  inv_a uuid; inv_b uuid; job_b uuid; n int; i int; j uuid;
  f text; pol record; ok boolean; any_yes boolean; all_yes boolean;
begin
  -- ── setup (as the database owner, like the server) ──
  insert into auth.users (id, email, aud, role, raw_user_meta_data)
  values (a, 'user-a@example.com', 'authenticated', 'authenticated', '{"full_name":"User A"}'),
         (b, 'user-b@example.com', 'authenticated', 'authenticated', '{"full_name":"User B"}'),
         (c, 'user-c@example.com', 'authenticated', 'authenticated', '{"full_name":"User C"}');
  inv_a := public.save_invoice(jsonb_build_object('user_id', a, 'vendor', 'GFS', 'invoice_number', '111', 'dup_key', 'gfs|111',
             'invoice_date', '2026-10-20', 'total', 30, 'period_tab', 'P10W4', 'sheet_row', 7, 'sent_by', 'UA', 'pdf_path', a || '/2026/P10W4/a.pdf'),
             '[{"category":"Produce","amount":10},{"category":"Dairy","amount":20}]');
  inv_b := public.save_invoice(jsonb_build_object('user_id', b, 'vendor', 'GFS', 'invoice_number', '222', 'dup_key', 'gfs|222',
             'invoice_date', '2026-10-20', 'total', 5, 'period_tab', 'P10W4', 'sheet_row', 8, 'sent_by', 'UB', 'pdf_path', b || '/2026/P10W4/b.pdf'),
             '[{"category":"Meat","amount":5}]');
  insert into public.ai_jobs (user_id, pdf_path) values (a, a || '/pending/1.pdf');
  insert into public.ai_jobs (user_id, pdf_path) values (b, b || '/pending/2.pdf') returning id into job_b;
  insert into storage.objects (bucket_id, name) values ('invoices', a || '/2026/P10W4/a.pdf'), ('invoices', b || '/2026/P10W4/b.pdf');

  -- ── act as user A (exactly what the browser gets with A's login) ──
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);

  select count(*) into n from public.invoices;
  if n <> 1 then raise exception 'FAIL invoices: A sees % invoices, expected only their own 1', n; end if;
  select count(*) into n from public.invoices where id = inv_b;
  if n <> 0 then raise exception 'FAIL invoices: A can read B''s invoice'; end if;

  select count(*) into n from public.invoice_lines;
  if n <> 2 then raise exception 'FAIL lines: A sees % lines, expected only their own 2', n; end if;
  select count(*) into n from public.invoice_lines where invoice_id = inv_b;
  if n <> 0 then raise exception 'FAIL lines: A can read B''s invoice lines'; end if;

  select count(*) into n from public.ai_jobs where user_id = b;
  if n <> 0 then raise exception 'FAIL ai_jobs: A can read B''s AI results'; end if;
  select count(*) into n from public.ai_jobs;
  if n <> 1 then raise exception 'FAIL ai_jobs: A sees % jobs, expected 1', n; end if;

  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FAIL profiles: A sees % profiles, expected only their own', n; end if;

  select count(*) into n from storage.objects where bucket_id = 'invoices' and name = b || '/2026/P10W4/b.pdf';
  if n <> 0 then raise exception 'FAIL storage: A can read B''s PDF by its exact path'; end if;
  select count(*) into n from storage.objects where bucket_id = 'invoices' and name like a || '/%';
  if n <> 1 then raise exception 'FAIL storage: A cannot read their own PDF'; end if;

  -- A can't change B's data or write invoices directly.
  update public.ai_jobs set status = 'error' where id = job_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL ai_jobs: A changed B''s job'; end if;
  begin
    insert into public.invoices (user_id, vendor, invoice_number, dup_key, invoice_date, total, period_tab, sent_by, pdf_path)
    values (a, 'X', '1', 'x|1', '2026-10-20', 1, 'P10W4', 'UA', a || '/x.pdf');
    raise exception 'FAIL invoices: A inserted an invoice directly (must go through the server)';
  exception when insufficient_privilege then null; -- expected: blocked by Row Level Security
  end;
  begin
    perform public.start_ai_job(a, a || '/pending/x.pdf', 1000);
    raise exception 'FAIL limit: A can call start_ai_job directly and skip the server';
  exception when insufficient_privilege then null; -- expected: only the server may call it
  end;

  -- ── back to the server role ──
  execute 'reset role';

  -- ── PDF delete permission ──
  -- Supabase blocks direct deletes on storage tables (storage.protect_delete), so this check doesn't delete.
  -- It evaluates the bucket's real delete rules for user A, the way Postgres does: a delete is allowed only if
  -- at least one permissive rule says yes AND every restrictive rule says yes.
  -- A's own file must come out "allowed" (proves the check works); B's file must come out "not allowed".
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  foreach f in array array[a || '/2026/P10W4/a.pdf', b || '/2026/P10W4/b.pdf'] loop
    any_yes := false; all_yes := true;
    for pol in select permissive, qual from pg_policies
                where schemaname = 'storage' and tablename = 'objects' and cmd in ('DELETE', 'ALL')
                  and ('authenticated'::name = any(roles) or 'public'::name = any(roles)) loop
      execute format('select exists (select 1 from storage.objects where bucket_id = %L and name = %L and (%s))',
                     'invoices', f, coalesce(pol.qual, 'true')) into ok;
      if pol.permissive = 'PERMISSIVE' then any_yes := any_yes or ok; else all_yes := all_yes and ok; end if;
    end loop;
    if f like a || '/%' and not (any_yes and all_yes) then
      raise exception 'FAIL storage: A is not allowed to delete their own PDF (so this check can''t be trusted)';
    end if;
    if f like b || '/%' and (any_yes and all_yes) then
      raise exception 'FAIL storage: A would be allowed to delete B''s PDF';
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- ── daily limit (C has no reads yet today) ──
  for i in 1..10 loop
    j := public.start_ai_job(c, c || '/pending/' || i || '.pdf', 10);
    if j is null then raise exception 'FAIL limit: read % of 10 was refused', i; end if;
  end loop;
  if public.start_ai_job(c, c || '/pending/11.pdf', 10) is not null then
    raise exception 'FAIL limit: the 11th read in a day was allowed';
  end if;
  -- B has their own count; a 50-per-day account isn't stopped at 11.
  if public.start_ai_job(b, b || '/pending/3.pdf', 10) is null then raise exception 'FAIL limit: B blocked by C''s count'; end if;
  for i in 1..9 loop perform public.start_ai_job(b, b || '/pending/x' || i || '.pdf', 50); end loop;
  if public.start_ai_job(b, b || '/pending/12.pdf', 50) is null then raise exception 'FAIL limit: 50-per-day account refused at 12'; end if;
end $$;

select 'ALL SECURITY TESTS PASSED' as result;
rollback;
