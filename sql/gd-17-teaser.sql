-- Giving Days project (main Supabase) - editable wording for the hidden ("mystery") challenge card.
-- Safe to run more than once. Run it BEFORE pushing the matching code (Save in the admin fails without these columns).
-- All are optional; blank = the built-in wording. This text is PUBLIC: it is what visitors see before the reveal,
-- so never put the real challenge details in it.
--   teaser_lock   small line under the padlock on the front of the card   (default: until Friday)
--   teaser_front  sentence on the front of the card                        (default: A secret challenge is waiting...)
--   teaser_pill   status label on the front                                (default: Revealed Fri 12/4)
--   teaser_title  heading on the back of the card                          (default: Mystery challenge)
--   teaser_back   text on the back of the card                             (default: A surprise challenge is coming...)
alter table public.gd_challenges
  add column if not exists teaser_lock  text,
  add column if not exists teaser_front text,
  add column if not exists teaser_pill  text,
  add column if not exists teaser_title text,
  add column if not exists teaser_back  text;
