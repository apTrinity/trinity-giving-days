-- Giving Days project (main Supabase) - Ask A and Ask B on each constituent record, like the parents page.
-- The gift form offers last year's gift, Ask A and Ask B as the amount buttons when a constituent has them.
-- Safe to run more than once.
alter table public.gd_donors
  add column if not exists ask_a numeric check (ask_a is null or ask_a >= 0),
  add column if not exists ask_b numeric check (ask_b is null or ask_b >= 0);
