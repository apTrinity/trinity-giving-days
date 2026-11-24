-- Giving Days project (main Supabase) - short audience label on the FRONT of a challenge/match card.
-- Safe to run more than once. Run it BEFORE pushing the matching code (Save in the admin fails without it).
-- Optional. Blank = the card uses its "Who counts" text instead. Example: "young alumni" shows as FOR YOUNG ALUMNI.
alter table public.gd_challenges
  add column if not exists front_label text;
