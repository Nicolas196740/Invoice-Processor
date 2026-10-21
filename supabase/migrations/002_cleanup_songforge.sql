-- Run once by hand in Supabase → SQL Editor (the AI tools can't run delete commands).
-- Deletes the old SongForge profiles table and two leftovers.
drop table if exists public.songforge_profiles_old cascade;
drop table if exists public._probe;
drop function if exists public.set_updated_at();
