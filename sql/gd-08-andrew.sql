-- Giving Days project (main Supabase) - Andrew Peterson's own constituent record, loaded like any
-- other donor would be by the RE import (re_id = the RE system record ID, 83411). Safe to run more than once.
-- Personal link: /vctkyf        Back to RE: https://app.blackbaud.com/constituent/records/83411
-- Affiliation: faculty (RE constituent code "Current Faculty & Staff"). Last year's gift: $20 (2025-2026 Annual Fund).
insert into public.gd_donors (token, re_id, first_name, last_name, email, import_tags, ly_gift)
values ('vctkyf', '83411', 'Andrew', 'Peterson', 'andrew.peterson@me.com', '{faculty}', 20)
on conflict (re_id) do nothing;
