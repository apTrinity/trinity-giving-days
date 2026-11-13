-- Giving Days project (main Supabase) - allow longer audience text (was 500 characters, now 900) so the
-- Reunion alumni message can run to several paragraphs. The admin and server limits were raised to match.
alter table public.gd_audiences drop constraint if exists gd_audiences_body_check;
alter table public.gd_audiences add constraint gd_audiences_body_check check (char_length(body) <= 900);

-- New Reunion alumni wording (from the Nov 2026 text-review doc). Blank lines make separate paragraphs.
update public.gd_audiences
set heading = 'Hi {{first_name}},',
    body = $body$The Reunion Giving Initiative supports both the Trinity Fund and the Financial Aid Endowment, and your Giving Days gift will count toward the initiative.

Here's how it works: An amount equal to your Trinity Fund gift last year will be directed to the Trinity Fund, while any additional amount will support the Financial Aid Endowment.

If you're making your first gift to Trinity, we warmly welcome your participation! Your gift today will be split equally between the Trinity Fund and the Financial Aid Endowment. The full amount will count toward the Reunion Giving Initiative.

Thank you for supporting Trinity and your reunion class!$body$
where name = 'Reunion alumni';
