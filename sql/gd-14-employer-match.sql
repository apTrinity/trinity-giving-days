-- Giving Days project (main Supabase) - remembering when a donor says their employer matches gifts.
-- Safe to run more than once. Until this is run, gifts still save normally (the match answer is just not stored),
-- but the staff notification email still shows it.
--
-- employer_match: the donor ticked "My employer matches gifts".
-- employer:       the company name they chose or typed (may be blank even when employer_match is true).

alter table public.gd_gifts add column if not exists employer_match boolean not null default false;
alter table public.gd_gifts add column if not exists employer text;
