// Giving Days campaign routes: public campaign data + admin management of settings and challenges.
// Kept in its own file so none of it can touch the parents routes in server.js.
// Tables: gd_settings (one row), gd_challenges (see sql/gd-02-tables.sql). Server-side access only.

const path = require('path');
const { computeProgress } = require('./giving-days-progress');

const DESC_MAX = 220;
const TEXT_MAX = { name: 60, unit: 40, who_counts: 120, when_text: 120, sponsor: 120 };
const KINDS = ['challenge', 'match'];

// Tags a gift can carry. `hidden` ones are never ticked on the form: they come from the RE import
// (or an admin edit). Keys for the form chips match giving-days-v2.html.
const TAGS = [
  { key: 'alumni',          label: 'Alumni',           hidden: false },
  { key: 'current_parent',  label: 'Current parents',  hidden: false },
  { key: 'parent_of_alumni', label: 'Parents of alumni', hidden: false },
  { key: 'faculty',         label: 'Faculty & staff',  hidden: false },
  { key: 'grandparent',     label: 'Grandparents',     hidden: false },
  { key: 'friend',          label: 'Friends',          hidden: false },
  { key: 'new_family',      label: 'New families',     hidden: true },
  { key: 'alumna',          label: 'Alumnae',          hidden: true },
];
const TAG_KEYS = TAGS.map(t => t.key);
const GRADES = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

// Card-back "Who counts" text built from the rule, unless the admin typed their own.
function whoCountsText(c) {
  if (c.who_counts) return c.who_counts;
  const labels = (c.tags || []).map(k => (TAGS.find(t => t.key === k) || {}).label).filter(Boolean);
  const list = labels.length > 1 ? labels.slice(0, -1).join(', ') + ' or ' + labels[labels.length - 1] : labels[0];
  const { class_year_min: lo, class_year_max: hi } = c;
  let years = null;
  if (lo != null && hi != null) years = lo === hi ? `Class of ${lo}` : `Classes of ${lo}–${hi}`;
  else if (lo != null) years = `Class of ${lo} or later`;
  else if (hi != null) years = `Class of ${hi} or earlier`;
  const gs = GRADES.filter(g => (c.grades || []).includes(g));
  const grades = !gs.length ? null : gs.length === 1 ? `Grade ${gs[0]}` : `Grades ${gs.slice(0, -1).join(', ')} and ${gs[gs.length - 1]}`;
  const extra = [years, grades && list ? grades : null].filter(Boolean).join(', ');
  if (grades && !list) return years ? `Current parents of ${grades} (${years})` : `Current parents of ${grades}`;
  if (list && extra) return `${list} (${extra})`;
  return list || years || 'Every donor to the Trinity Fund';
}

// ── Validation helpers ───────────────────────────────────────────────────────
const isBlank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const num = v => (typeof v === 'number' ? v : Number(String(v).trim()));
const toDate = v => {
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// Turns a request body into a clean challenge row, or returns { error }.
// `partial` allows PUT to send only some fields.
function cleanChallenge(body, { partial = false } = {}) {
  const out = {};
  const b = body || {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);

  for (const k of ['name', 'unit', 'who_counts', 'when_text', 'sponsor']) {
    if (!has(k)) continue;
    const v = isBlank(b[k]) ? null : String(b[k]).trim();
    if (v && v.length > TEXT_MAX[k]) return { error: `${k} must be ${TEXT_MAX[k]} characters or fewer.` };
    out[k] = v;
  }
  if (!partial && !out.name) return { error: 'Name is required.' };
  if (has('name') && !out.name) return { error: 'Name is required.' };

  if (has('kind')) {
    if (!KINDS.includes(b.kind)) return { error: 'Type must be challenge or match.' };
    out.kind = b.kind;
  }
  if (has('description')) {
    const d = isBlank(b.description) ? '' : String(b.description).trim();
    if (d.length > DESC_MAX) return { error: `Description must be ${DESC_MAX} characters or fewer (it is ${d.length}).` };
    out.description = d;
  }
  if (has('target')) {
    const t = num(b.target);
    if (!isFinite(t) || t <= 0) return { error: 'Target must be a number greater than 0.' };
    out.target = t;
  } else if (!partial) return { error: 'Target is required.' };

  if (has('prize')) {
    if (isBlank(b.prize)) out.prize = null;
    else {
      const p = num(b.prize);
      if (!isFinite(p) || p < 0) return { error: 'Prize must be 0 or more.' };
      out.prize = p;
    }
  }
  if (has('current_value')) {
    const c = isBlank(b.current_value) ? 0 : num(b.current_value);
    if (!isFinite(c) || c < 0) return { error: 'Current progress must be 0 or more.' };
    out.current_value = c;
  }
  for (const k of ['starts_at', 'ends_at']) {
    if (!has(k)) continue;
    if (isBlank(b[k])) out[k] = null;
    else {
      const d = toDate(b[k]);
      if (!d) return { error: `${k} is not a valid date.` };
      out[k] = d;
    }
  }
  if (out.starts_at && out.ends_at && out.starts_at >= out.ends_at) return { error: 'The window must end after it starts.' };
  if (has('sort_order')) {
    const s = parseInt(b.sort_order, 10);
    if (!Number.isInteger(s)) return { error: 'Sort order must be a whole number.' };
    out.sort_order = s;
  }
  if (has('published')) out.published = b.published === true || b.published === 'true';

  if (has('tags')) {
    if (!Array.isArray(b.tags)) return { error: 'Who counts must be a list of affiliations.' };
    const bad = b.tags.find(t => !TAG_KEYS.includes(t));
    if (bad !== undefined) return { error: `Unknown affiliation "${bad}".` };
    out.tags = [...new Set(b.tags)];
  }
  if (has('grades')) {
    if (!Array.isArray(b.grades)) return { error: 'Grades must be a list.' };
    const bad = b.grades.find(g => !GRADES.includes(String(g)));
    if (bad !== undefined) return { error: `Unknown grade "${bad}".` };
    out.grades = GRADES.filter(g => b.grades.map(String).includes(g));
  }
  for (const k of ['class_year_min', 'class_year_max']) {
    if (!has(k)) continue;
    if (isBlank(b[k])) { out[k] = null; continue; }
    const y = Number(String(b[k]).trim());
    if (!Number.isInteger(y) || y < 1900 || y > 2100) return { error: 'Class years must be four-digit years, like 2015.' };
    out[k] = y;
  }
  if (out.class_year_min != null && out.class_year_max != null && out.class_year_min > out.class_year_max) {
    return { error: 'The first class year must not be after the last.' };
  }

  // A challenge unlocks a prize; a match has none.
  const kind = out.kind || (partial ? null : 'challenge');
  if (kind === 'match') out.prize = null;
  if (!partial && kind === 'challenge' && out.prize == null) return { error: 'A challenge needs a prize amount.' };
  return { row: out };
}

function cleanSettings(body) {
  const b = body || {};
  const out = {};
  if (Object.prototype.hasOwnProperty.call(b, 'goal_donors')) {
    const g = parseInt(b.goal_donors, 10);
    if (!Number.isInteger(g) || g <= 0) return { error: 'Goal must be a whole number greater than 0.' };
    out.goal_donors = g;
  }
  for (const k of ['starts_at', 'ends_at']) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || isBlank(b[k])) continue;  // blank = leave unchanged
    const d = toDate(b[k]);
    if (!d) return { error: `${k} is not a valid date.` };
    out[k] = d;
  }
  if (out.starts_at && out.ends_at && out.starts_at >= out.ends_at) return { error: 'The campaign must end after it starts.' };
  if (Object.prototype.hasOwnProperty.call(b, 'video_url')) {
    const v = isBlank(b.video_url) ? null : String(b.video_url).trim();
    if (v && !/^https:\/\//i.test(v)) return { error: 'Video link must start with https://' };
    out.video_url = v;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'test_gifts_count')) out.test_gifts_count = b.test_gifts_count === true || b.test_gifts_count === 'true';
  if (Object.prototype.hasOwnProperty.call(b, 'gifts_count_from')) {  // blank = the campaign start
    if (isBlank(b.gifts_count_from)) out.gifts_count_from = null;
    else {
      const d = toDate(b.gifts_count_from);
      if (!d) return { error: 'gifts_count_from is not a valid date.' };
      out.gifts_count_from = d;
    }
  }
  // `mode` is intentionally not editable here: test/live stays locked in server.js (GD_LIVE_ALLOWED).
  return { row: out };
}

// ── Routes ───────────────────────────────────────────────────────────────────
module.exports = function mountGivingDaysAdmin(app, { supabase, requireAdmin }) {
  const fail = (res, err, status = 500) => {
    console.error('giving-days-admin:', err.message || err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
  };

  // Admin page
  app.get('/admin/giving-days', (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(__dirname, 'public', 'admin-giving-days.html'));
  });

  // What the Giving Days page needs (published challenges only); shared by the API and the page itself.
  // Challenge progress is counted from gifts (see giving-days-progress.js), plus the admin's manual adjustment.
  async function loadCampaign() {
    const [s, c] = await Promise.all([
      supabase.from('gd_settings').select('goal_donors, starts_at, ends_at, timezone, video_url, test_gifts_count, gifts_count_from').eq('id', 1).single(),
      supabase.from('gd_challenges')
        .select('id, name, kind, unit, who_counts, tags, grades, class_year_min, class_year_max, target, prize, starts_at, ends_at, when_text, sponsor, description, current_value, sort_order')
        .eq('published', true).order('sort_order').order('created_at'),
    ]);
    if (s.error) throw s.error;
    if (c.error) throw c.error;
    const { progress, values, wall } = await computeProgress(supabase, s.data, c.data);
    const { test_gifts_count, gifts_count_from, ...settings } = s.data;  // switches stay private to the admin
    return {
      settings, progress, wall,
      challenges: c.data.map(x => ({ ...x, who_counts: whoCountsText(x), current_value: Number(x.current_value) + (values[x.id] || 0) })),
    };
  }

  app.get('/api/gd/campaign', async (req, res) => {
    try {
      const data = await loadCampaign();
      res.set('Cache-Control', 'public, max-age=15');
      res.json(data);
    } catch (err) { fail(res, err); }
  });

  // Admin: settings
  app.get('/api/admin/gd/settings', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('gd_settings').select('*').eq('id', 1).single();
      if (error) throw error;
      res.json({ settings: data, descMax: DESC_MAX });
    } catch (err) { fail(res, err); }
  });

  app.put('/api/admin/gd/settings', requireAdmin, async (req, res) => {
    const { row, error: bad } = cleanSettings(req.body);
    if (bad) return res.status(400).json({ error: bad });
    if (!Object.keys(row).length) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      // Re-check the window against what is stored when only one end is sent.
      if (!(row.starts_at && row.ends_at) && (row.starts_at || row.ends_at)) {
        const { data: cur } = await supabase.from('gd_settings').select('starts_at, ends_at').eq('id', 1).single();
        const s = row.starts_at || cur.starts_at, e = row.ends_at || cur.ends_at;
        if (new Date(s) >= new Date(e)) return res.status(400).json({ error: 'The campaign must end after it starts.' });
      }
      const { data, error } = await supabase.from('gd_settings')
        .update({ ...row, updated_at: new Date().toISOString() }).eq('id', 1).select().single();
      if (error) throw error;
      res.json({ settings: data });
    } catch (err) { fail(res, err); }
  });

  // Admin: challenges
  app.get('/api/admin/gd/challenges', requireAdmin, async (req, res) => {
    try {
      const [c, s] = await Promise.all([
        supabase.from('gd_challenges').select('*').order('sort_order').order('created_at'),
        supabase.from('gd_settings').select('*').eq('id', 1).single(),
      ]);
      if (c.error) throw c.error;
      if (s.error) throw s.error;
      // counted = progress from gifts; current_value stays the manual adjustment that is added to it
      const { values } = await computeProgress(supabase, s.data, c.data);
      res.json({ challenges: c.data.map(x => ({ ...x, counted: values[x.id] || 0 })), descMax: DESC_MAX, tags: TAGS, grades: GRADES });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/admin/gd/challenges', requireAdmin, async (req, res) => {
    const { row, error: bad } = cleanChallenge(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      if (row.sort_order === undefined) {
        const { data: last } = await supabase.from('gd_challenges').select('sort_order').order('sort_order', { ascending: false }).limit(1);
        row.sort_order = last && last.length ? last[0].sort_order + 1 : 0;
      }
      const { data, error } = await supabase.from('gd_challenges').insert(row).select().single();
      if (error) throw error;
      res.status(201).json({ challenge: data });
    } catch (err) { fail(res, err); }
  });

  // Reorder: body { ids: [id, id, ...] } in the desired order. Registered before /:id.
  app.put('/api/admin/gd/challenges/order', requireAdmin, async (req, res) => {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some(i => typeof i !== 'string')) {
      return res.status(400).json({ error: 'ids must be a list of challenge ids.' });
    }
    try {
      const results = await Promise.all(ids.map((id, i) =>
        supabase.from('gd_challenges').update({ sort_order: i, updated_at: new Date().toISOString() }).eq('id', id)));
      const failed = results.find(r => r.error);
      if (failed) throw failed.error;
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  app.put('/api/admin/gd/challenges/:id', requireAdmin, async (req, res) => {
    const { row, error: bad } = cleanChallenge(req.body, { partial: true });
    if (bad) return res.status(400).json({ error: bad });
    if (!Object.keys(row).length) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      const { data, error } = await supabase.from('gd_challenges')
        .update({ ...row, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
      if (error) {
        if (error.code === 'PGRST116') return res.status(404).json({ error: 'Challenge not found.' });
        throw error;
      }
      res.json({ challenge: data });
    } catch (err) { fail(res, err); }
  });

  app.delete('/api/admin/gd/challenges/:id', requireAdmin, async (req, res) => {
    try {
      const { error } = await supabase.from('gd_challenges').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  return { loadCampaign };
};

module.exports.DESC_MAX = DESC_MAX;
module.exports.TAGS = TAGS;
module.exports.whoCountsText = whoCountsText;
