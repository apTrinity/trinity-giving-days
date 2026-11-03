-- Giving Days project (main Supabase) - the five sample challenges as real, editable challenges.
-- They appear in the admin under Challenges (edit, reorder, unpublish) and on the Giving Days page.
-- Progress comes from the gifts themselves; the page's sample progress numbers go away.
-- Safe to run more than once: a challenge is only added if one with that name does not exist.
-- Wording is last year's, refreshed for 2026. Sponsors are placeholders to confirm.
-- Final Day: Friday 12/4/2026, 12:00 am to 11:59:59 pm Eastern (UTC-5).

insert into public.gd_challenges
  (name, kind, unit, who_counts, tags, class_year_min, class_year_max, target, prize, starts_at, ends_at, when_text, sponsor, description, sort_order, published)
select v.* from (values
  ('350 for 150', 'challenge', 'donors', 'Every donor to the Trinity Fund', '{}'::text[], null::int, null::int, 350::numeric, 150000::numeric,
   null::timestamptz, null::timestamptz, 'All week · Mon 11/30 – Fri 12/4', 'a group of Trinity parents, alumni & friends',
   E'350 donors will unlock $150,000 in additional money for the Trinity Fund.\nEvery gift counts as one donor, whatever the amount, so gifts of every size help unlock the full $150,000.', 0, true),
  ('She Roars', 'challenge', 'alumnae', 'Trinity alumnae', '{alumna}', null, null, 125, 25000,
   null, null, 'All week · Mon 11/30 – Fri 12/4', 'Trinity alumnae',
   E'125 gifts from Trinity alumnae will unlock an additional $25,000 in Trinity Fund support.\nCelebrating the women who have made Trinity what it is today.', 1, true),
  ('New Families 25 for 25', 'challenge', 'new families', 'Families new to Trinity this year', '{new_family}', null, null, 25, 25000,
   null, null, 'All week · Mon 11/30 – Fri 12/4', 'an anonymous family',
   E'25 gifts from 25 new Trinity families will unlock an additional $25,000 in Trinity Fund support.\nWelcome to Trinity, and thank you for making this one happen so quickly!', 2, true),
  ('Young Alumni Match', 'match', null, 'Alumni, classes of 2012–2026', '{alumni}', 2012, 2026, 25000, null,
   null, null, 'All week, until the $25,000 match is used', 'the Trinity Alumni Board',
   E'All gifts from young alumni donors (classes 2012–2026) will be matched dollar for dollar, up to $25,000.\nA $50 gift becomes $100 for the Trinity Fund.', 3, true),
  ('Final Day 50 for 50', 'challenge', 'donors', 'Every donor, Friday only', '{}', null, null, 50, 50000,
   '2026-12-04 00:00:00-05'::timestamptz, '2026-12-04 23:59:59-05'::timestamptz, 'Friday 12/4 · midnight to 11:59 pm', 'the Board of Trustees',
   E'50 gifts on the final day unlock $50,000 in additional money for the Trinity Fund.\nOnly gifts made on Friday, December 4 count toward this challenge.', 4, true)
) as v(name, kind, unit, who_counts, tags, class_year_min, class_year_max, target, prize, starts_at, ends_at, when_text, sponsor, description, sort_order, published)
where not exists (select 1 from public.gd_challenges c where c.name = v.name);
