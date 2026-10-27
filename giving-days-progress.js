// Giving Days progress: which gifts count, who counts as one donor, and how far each challenge has got.
// Tables: gd_gifts, gd_donors (see sql/gd-05, gd-06). Server-side access only.
//
// A gift counts when it is not excluded, falls inside the counting window (gifts_count_from, or the
// campaign start, up to the campaign end), and is a real gift or test gifts are switched on.
// While test gifts are switched on they count whenever they were made (so progress can be tried out
// before the campaign opens). One person (by email) is one donor, however many gifts they make.

const { effectiveTags, qualifies } = require('./giving-days-donors');

// Fetch every row of a query, paging past the project's row limit. `build` returns a fresh query each time.
async function fetchAll(build, pageSize = 900) {
  let all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
  }
  return all;
}

// Every gift, newest last, each with its donor record (if any) attached as `_donor`.
async function loadGifts(supabase) {
  const gifts = await fetchAll(() => supabase.from('gd_gifts').select('*').order('created_at').order('id'));
  const ids = [...new Set(gifts.map(g => g.donor_id).filter(Boolean))];
  const donors = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('gd_donors')
      .select('id, import_tags, tags_added, tags_removed, grades, class_year').in('id', ids.slice(i, i + 200));
    if (error) throw error;
    (data || []).forEach(d => { donors[d.id] = d; });
  }
  gifts.forEach(g => { g._donor = g.donor_id ? donors[g.donor_id] || null : null; });
  return gifts;
}

// A gift's tags and where each came from: 'declared' (ticked on the form), 'record' (from the donor
// record, i.e. the RE import or admin edits to the donor) or 'admin' (added to this gift by hand).
function giftTags(g) {
  const src = {};
  (g.declared_tags || []).forEach(t => { src[t] = 'declared'; });
  if (g._donor) effectiveTags(g._donor).forEach(t => { if (!src[t]) src[t] = 'record'; });
  const base = Object.keys(src);
  (g.tags_removed || []).forEach(t => { delete src[t]; });
  (g.tags_added || []).forEach(t => { src[t] = 'admin'; });
  return { tags: Object.keys(src), sources: src, base };
}

// Why a gift does or does not count: 'counts', or 'excluded' / 'test' / 'early' / 'late'.
function countStatus(g, s) {
  if (g.excluded) return 'excluded';
  if (g.is_test) return s.test_gifts_count ? 'counts' : 'test';
  const t = new Date(g.created_at).getTime();
  if (t < new Date(s.gifts_count_from || s.starts_at).getTime()) return 'early';
  if (t >= new Date(s.ends_at).getTime()) return 'late';
  return 'counts';
}

const personKey = g => (g.email ? 'e:' + g.email.trim().toLowerCase() : 'g:' + g.id);

// Counted gifts grouped by person, each person's tags/grades/class year merged across their gifts.
function people(gifts, settings) {
  const byKey = new Map();
  for (const g of gifts) {
    if (countStatus(g, settings) !== 'counts') continue;
    const k = personKey(g);
    let p = byKey.get(k);
    if (!p) { p = { tags: new Set(), grades: new Set(), class_year: null, gifts: [] }; byKey.set(k, p); }
    giftTags(g).tags.forEach(t => p.tags.add(t));
    (g.grades || []).forEach(x => p.grades.add(x));
    const d = g._donor;
    if (d) (d.grades || []).forEach(x => p.grades.add(x));
    const year = g.class_year != null ? g.class_year : d ? d.class_year : null;
    if (year != null) p.class_year = year;
    p.gifts.push(g);
  }
  return [...byKey.values()].map(p => ({ ...p, tags: [...p.tags], grades: [...p.grades] }));
}

const GROUP_OF = { alumni: 'alumni', alumna: 'alumni', current_parent: 'parents', parent_of_alumni: 'poa', faculty: 'staff', grandparent: 'friends', friend: 'friends' };
const GROUP_ORDER = ['alumni', 'parents', 'poa', 'staff', 'friends'];
const WALL_MAX = 300;

// What the public page shows: donors per alumni class and parent grade, per group, and the recent-donor wall.
function buildWall(ppl) {
  const classes = {}, grades = {}, groups = { alumni: 0, parents: 0, poa: 0, staff: 0, friends: 0 };
  const recent = [];
  for (const p of ppl) {
    const mine = new Set(p.tags.map(t => GROUP_OF[t]).filter(Boolean));
    if (!mine.size) mine.add('friends');
    mine.forEach(g => { groups[g]++; });
    if (p.class_year != null && (p.tags.includes('alumni') || p.tags.includes('alumna'))) classes[p.class_year] = (classes[p.class_year] || 0) + 1;
    if (p.tags.includes('current_parent')) p.grades.forEach(g => { grades[g] = (grades[g] || 0) + 1; });
    const last = p.gifts[p.gifts.length - 1];
    const who = [last.first_name, last.last_name].filter(Boolean).join(' ');
    const name = last.anonymous || !who ? 'Anonymous' : who + (mine.has('alumni') && p.class_year ? ' \u2019' + String(p.class_year).slice(-2) : '');
    recent.push({ name, group: GROUP_ORDER.find(g => mine.has(g)), at: last.created_at });
  }
  recent.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { total: ppl.length, classes, grades, groups, donors: recent.slice(0, WALL_MAX) };
}

// Progress for the whole campaign and for each challenge. `challenges` need id, kind, target and the rule fields.
function compute(gifts, settings, challenges) {
  const ppl = people(gifts, settings);
  const progress = {
    donors: ppl.length,
    raised: ppl.reduce((t, p) => t + p.gifts.reduce((s, g) => s + Number(g.amount), 0), 0),
  };
  const values = {};
  for (const c of challenges) {
    const lo = c.starts_at ? new Date(c.starts_at).getTime() : -Infinity;
    const hi = c.ends_at ? new Date(c.ends_at).getTime() : Infinity;
    // Test gifts ignore a challenge's window as well, for the same reason they ignore the campaign's.
    const inWindow = g => g.is_test || (new Date(g.created_at).getTime() >= lo && new Date(g.created_at).getTime() < hi);
    let donors = 0, dollars = 0;
    for (const p of ppl) {
      if (!qualifies(c, p)) continue;
      const mine = p.gifts.filter(inWindow);
      if (!mine.length) continue;
      donors++;
      dollars += mine.reduce((s, g) => s + Number(g.amount), 0);
    }
    values[c.id] = c.kind === 'match' ? Math.min(Number(c.target), dollars) : donors;
  }
  return { progress, values, wall: buildWall(ppl) };
}

// Gifts are cached briefly so a busy page does not re-read them on every visit; saving or editing a gift clears it.
const TTL_MS = 10 * 1000;
let cache = { at: 0, gifts: null };
function invalidate() { cache = { at: 0, gifts: null }; }
async function cachedGifts(supabase) {
  if (!cache.gifts || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), gifts: await loadGifts(supabase) };
  return cache.gifts;
}

async function computeProgress(supabase, settings, challenges) {
  return compute(await cachedGifts(supabase), settings, challenges);
}

module.exports = { fetchAll, loadGifts, giftTags, countStatus, compute, computeProgress, invalidate };
