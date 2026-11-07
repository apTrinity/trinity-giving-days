-- Giving Days project (main Supabase) - support for the RE sync (giving-days-sync.js).
-- Safe to run more than once. Run it before the first APPLY (a preview does not need it).
--   active      false when a person has dropped out of the RE query (kept, with their gift history)
--   synced_at   last time the sync saw this person in the query
--   giving_ytd  this year's giving (26-27) as recorded in Raiser's Edge at the last sync
--   addressee, salutation, alumni_addressee, alumni_salutation  as written in RE (household and alumni versions)
--   household_re_id  the main person's RE ID, saved on both spouses so a couple stays linked
alter table public.gd_donors
  add column if not exists active     boolean not null default true,
  add column if not exists synced_at  timestamptz,
  add column if not exists giving_ytd numeric check (giving_ytd is null or giving_ytd >= 0),
  add column if not exists addressee text,
  add column if not exists salutation text,
  add column if not exists alumni_addressee text,
  add column if not exists alumni_salutation text,
  add column if not exists household_re_id text;
