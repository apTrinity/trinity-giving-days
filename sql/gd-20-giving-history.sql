-- Giving Days project (main Supabase) - giving history for LYBUNT / SYBUNT tags.
-- Safe to run more than once. Run it BEFORE the next sync APPLY (the sync works without it, it just skips these fields).
--   giving_fy_last   last fiscal year's Trinity Fund cash total (25-26), from the RE query column "25-26 TF Cash Total"
--   giving_fy_prior  the three fiscal years before that added together (22-23, 23-24, 24-25)
--   last_gift_date   the RE "Last Gift Date" (used to split LYBUNTs into July-Dec and Jan-Jun)
-- All three are saved on both spouses of a household.
alter table public.gd_donors
  add column if not exists giving_fy_last numeric,
  add column if not exists giving_fy_prior numeric,
  add column if not exists last_gift_date date;
