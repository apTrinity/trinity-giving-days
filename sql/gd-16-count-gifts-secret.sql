-- Giving Days project (main Supabase) - count challenges by gifts, and hidden ("mystery") challenges.
-- Safe to run more than once. Run it BEFORE pushing the matching code (the code falls back if it is missing, but the
-- new behaviour needs these columns).
--   counts_gifts  true = every gift counts (the "200 new gifts" hook); false = each person counts once (donors)
--   secret        true = until the challenge starts, the public page shows a mystery card (no name, amount or text)
alter table public.gd_challenges
  add column if not exists counts_gifts boolean not null default false,
  add column if not exists secret       boolean not null default false;

-- This year's hook is new GIFTS, not donors.
update public.gd_challenges
set counts_gifts = true,
    unit = 'gifts',
    description = E'200 new gifts will unlock $200,000 in additional money for the Trinity Fund.\nEvery new gift counts, whatever the amount, so gifts of every size help unlock the full $200,000.'
where name = '200 for 200';

-- The final-day challenge also counts gifts, and stays a secret until Friday.
update public.gd_challenges
set counts_gifts = true, unit = 'gifts', secret = true
where name = 'Final Day 50 for 50';
