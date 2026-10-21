-- Step 1: tables, security rules (RLS), storage bucket, and seed data.
-- Applied to the "ISM 4421" Supabase project. Replaces the old SongForge profiles table.

-- ───────── Move the old SongForge profiles table out of the way ─────────
-- (Renamed instead of dropped; 002_cleanup_songforge.sql deletes it.)
alter table public.profiles rename to songforge_profiles_old;

-- ───────── Lookup lists (same as reference/Config.gs) ─────────
create table public.categories (
  name text primary key,
  sort int not null
);

create table public.vendors (
  name     text primary key,
  rule     text not null check (rule in ('gfs', 'ai', 'single')),
  category text references public.categories(name), -- for rule 'single'
  allowed  text[],                                  -- for rule 'ai'
  aliases  text[] not null default '{}',            -- other names seen on invoices / old sheet rows
  hint     text
);

-- ───────── Profiles: one per Google login ─────────
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  initials   text not null default '' check (char_length(initials) <= 4),
  created_at timestamptz not null default now()
);

-- "Nicolas Munoz" -> "NM", "Cher" -> "C"
create function public.make_initials(full_name text)
returns text language sql immutable set search_path = '' as $$
  select upper(
    coalesce(left(split_part(trim(full_name), ' ', 1), 1), '') ||
    case when position(' ' in trim(full_name)) > 0
         then left(regexp_replace(trim(full_name), '^.*\s', ''), 1) else '' end)
$$;

-- Runs when someone signs in with Google for the first time.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n text := coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', '');
begin
  insert into public.profiles (id, email, full_name, initials)
  values (new.id, coalesce(new.email, ''), n, public.make_initials(n))
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- The existing on_auth_user_created trigger on auth.users already calls handle_new_user(),
-- so replacing the function above is enough.

-- ───────── Invoices ─────────
create table public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id),
  vendor             text not null,
  invoice_number     text not null,
  dup_key            text not null,          -- vendor + invoice digits, used for the duplicate check
  invoice_date       date not null,
  total              numeric(12,2) not null,
  period_tab         text not null,          -- e.g. P10W2
  sheet_row          int,
  sent_by            text not null,          -- initials
  comment            text not null default '',
  pdf_path           text not null,          -- path in the "invoices" storage bucket
  duplicate_override boolean not null default false,
  created_at         timestamptz not null default now()
);
create index invoices_dup_key_idx on public.invoices (dup_key);
create index invoices_period_tab_idx on public.invoices (period_tab);
create index invoices_user_id_idx on public.invoices (user_id);

create table public.invoice_lines (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  category   text not null references public.categories(name),
  amount     numeric(12,2) not null
);
create index invoice_lines_invoice_id_idx on public.invoice_lines (invoice_id);

-- ───────── Row Level Security ─────────
-- Signed-in users can read everything (team dashboard) and edit only their own profile.
-- Invoices are written only by the server (Netlify Functions use the service role key,
-- which bypasses RLS), so there are no insert/update/delete policies for the browser.
alter table public.categories    enable row level security;
alter table public.vendors       enable row level security;
alter table public.profiles      enable row level security;
alter table public.invoices      enable row level security;
alter table public.invoice_lines enable row level security;

create policy "signed-in users read categories" on public.categories    for select to authenticated using (true);
create policy "signed-in users read vendors"    on public.vendors       for select to authenticated using (true);
create policy "signed-in users read profiles"   on public.profiles      for select to authenticated using (true);
create policy "signed-in users read invoices"   on public.invoices      for select to authenticated using (true);
create policy "signed-in users read lines"      on public.invoice_lines for select to authenticated using (true);

create policy "users edit own profile" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- Only the name and initials can be changed from the browser (not the email or id).
revoke update on public.profiles from authenticated, anon;
grant update (full_name, initials) on public.profiles to authenticated;

-- ───────── Storage: private "invoices" bucket ─────────
-- Files live at <user id>/<file>.pdf. Users upload into their own folder; everyone signed in can read
-- (the dashboard links to any team member's PDF).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;

create policy "upload own invoice pdfs" on storage.objects for insert to authenticated
  with check (bucket_id = 'invoices' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "read invoice pdfs" on storage.objects for select to authenticated
  using (bucket_id = 'invoices');

-- ───────── Seed data ─────────
insert into public.categories (name, sort) values
  ('Produce', 1), ('Poultry', 2), ('Meat', 3), ('Other food', 4), ('Dough', 5), ('Dairy', 6),
  ('Beverage', 7), ('Paper & Packaging', 8), ('Janitorial & Cleaning Supplies', 9),
  ('Restaurant Operating Supplies', 10), ('Linen', 11), ('R&M', 12), ('Restaurant Expense', 13),
  ('Pest Control', 14), ('Equipment Rental', 15), ('Office Expenses', 16), ('Miscellaneous', 17);

insert into public.vendors (name, rule, category, allowed, aliases, hint) values
  ('GFS',        'gfs',    null,        null, '{Gordon Food Service}', null),
  ('Capri',      'single', 'Dairy',     null, '{}', null),
  ('Warehouse',  'single', 'Dough',     null, '{Warehouse 305,Wynwood,Wywnood,Wharehouse}', 'Used to be called Wynwood.'),
  ('Tita',       'ai',     null,        '{Beverage,Other food}', '{}',
     'Wine is Beverage. Truffle oil (and other food items) is Other food. Usually the whole invoice is one or the other.'),
  ('PW',         'single', 'Beverage',  null, '{}', null),
  ('Unifirst',   'single', 'Linen',     null, '{}', null),
  ('Alsco',      'single', 'Linen',     null, '{}', null),
  ('ER Pumping', 'single', 'R&M',       null, '{ERP}', null),
  ('Commissary', 'single', 'R&M',       null, '{}', null),
  ('Cozzini',    'single', 'R&M',       null, '{}', null);

-- Profiles for people who already had a login in this project.
insert into public.profiles (id, email, full_name, initials)
select u.id, coalesce(u.email, ''), n, public.make_initials(n)
from auth.users u,
     lateral (select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '') as n) x
on conflict (id) do nothing;
