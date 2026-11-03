-- Giving Days project (main Supabase) - reunion classes for 2026 are the 2s and 7s (1947 ... 2022).
-- Updates the "Reunion alumni" audience; the same list can be edited any time in the admin under Audiences.
update public.gd_audiences
set class_years = (select array_agg(y order by y) from generate_series(1947, 2022) y where y % 5 = 2)
where name = 'Reunion alumni';
