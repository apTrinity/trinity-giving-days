-- Giving Days project (main Supabase) - the "Export RE CSV" tool on the admin Gifts tab.
-- Safe to run more than once.
--
-- re_synced_at: when a gift was marked "imported into Raiser's Edge" (blank = not yet). Gifts that came FROM RE are never exported.
-- re_import:    the fixed values the RE import file uses (campaign, fund, appeal, letter ...), edited on the Gifts tab.

alter table public.gd_gifts add column if not exists re_synced_at timestamptz;
alter table public.gd_settings add column if not exists re_import jsonb;
