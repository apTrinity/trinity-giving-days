-- Giving Days project (main Supabase) - RE Import ID for each donor.
-- Safe to run more than once. Run it BEFORE the next sync APPLY (the sync works without it, it just skips this field).
-- The RE gift import matches donors on the Import ID, not the system record ID (re_id). The RE query column
-- "Constituent_Import_ID" (and "Spouse_Import_ID" for spouses) is saved here by the nightly sync and used as ImportID in the gift export.
alter table public.gd_donors add column if not exists import_id text;
