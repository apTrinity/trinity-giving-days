-- Giving Days project (main Supabase) - save the RE Appeal Code on each donor.
-- Safe to run more than once. Run it before the next sync APPLY; then Preview + Apply to fill it in.
--   appeal_code  the "Appeal Code" column from the RE query, as written (e.g. "NEW FAMILY ..."),
--                saved on both spouses. Blank in RE = null here.
alter table public.gd_donors
  add column if not exists appeal_code text;
