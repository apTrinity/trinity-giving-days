// Giving Days audiences: groups of donors who see their own text on the gift form (reunion alumni,
// senior parents, ...). Same who-counts rule as a challenge, plus an optional list of specific class years.
// Tables: gd_audiences (see sql/gd-07-audiences.sql). Server-side access only.
// The text may use {{first_name}}, {{class_year}} and {{ly_gift}}; the page fills them in.

const { TAGS, GRADES } = require('./giving-days-admin');
const { effectiveTags } = require('./giving-days-donors');

const TAG_KEYS = TAGS.map(t => t.key);
const HEADING_MAX = 80, BODY_MAX = 900, NAME_MAX = 60;
const isBlank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// The first audience, in order, whose rule the donor meets. `qualifies` is the shared who-counts rule.
function audienceFor(audiences, donor, qualifies) {
  const a = (audiences || []).find(x => qualifies(x, donor));
  return a ? { id: a.id, name: a.name, heading: a.heading, body: a.body } : null;
}

// Turns a request body into a clean audience row, or returns { error }.
function cleanAudience(body, { partial = false } = {}) {
  const b = body || {}, out = {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (has('name')) {
    const n = isBlank(b.name) ? '' : String(b.name).trim();
    if (!n) return { error: 'Name is required.' };
    if (n.length > NAME_MAX) return { error: `Name must be ${NAME_MAX} characters or fewer.` };
    out.name = n;
  } else if (!partial) return { error: 'Name is required.' };
  for (const [k, max] of [['heading', HEADING_MAX], ['body', BODY_MAX]]) {
    if (!has(k)) continue;
    const v = isBlank(b[k]) ? '' : String(b[k]).trim();
    if (v.length > max) return { error: `${k === 'body' ? 'Text' : 'Heading'} must be ${max} characters or fewer (it is ${v.length}).` };
    out[k] = v;
  }
  if (has('tags')) {
    if (!Array.isArray(b.tags)) return { error: 'Affiliations must be a list.' };
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
  if (has('class_years')) {
    // accepts a list or text like "2001, 2006 2011"
    const raw = Array.isArray(b.class_years) ? b.class_years : String(b.class_years || '').split(/[\s,;]+/).filter(Boolean);
    const years = raw.map(v => Number(v));
    if (years.some(y => !Number.isInteger(y) || y < 1900 || y > 2100)) return { error: 'Specific class years must be four-digit years, like 2001.' };
    out.class_years = [...new Set(years)].sort((x, y) => x - y);
  }
  if (has('sort_order')) {
    const s = parseInt(b.sort_order, 10);
    if (!Number.isInteger(s)) return { error: 'Sort order must be a whole number.' };
    out.sort_order = s;
  }
  if (has('published')) out.published = b.published === true || b.published === 'true';
  return { row: out };
}

module.exports = function mountGivingDaysAudiences(app, { supabase, requireAdmin }) {
  const fail = (res, err, status = 500) => {
    console.error('giving-days-audiences:', err.message || err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
  };

  app.get('/api/admin/gd/audiences', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('gd_audiences').select('*').order('sort_order').order('created_at');
      if (error) throw error;
      res.json({ audiences: data, limits: { heading: HEADING_MAX, body: BODY_MAX }, tags: TAGS, grades: GRADES });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/admin/gd/audiences', requireAdmin, async (req, res) => {
    const { row, error: bad } = cleanAudience(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      if (row.sort_order === undefined) {
        const { data: last } = await supabase.from('gd_audiences').select('sort_order').order('sort_order', { ascending: false }).limit(1);
        row.sort_order = last && last.length ? last[0].sort_order + 1 : 0;
      }
      const { data, error } = await supabase.from('gd_audiences').insert(row).select().single();
      if (error) throw error;
      res.status(201).json({ audience: data });
    } catch (err) { fail(res, err); }
  });

  // Reorder (first match wins): body { ids: [...] } in the desired order. Registered before /:id.
  app.put('/api/admin/gd/audiences/order', requireAdmin, async (req, res) => {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some(i => typeof i !== 'string')) return res.status(400).json({ error: 'ids must be a list of audience ids.' });
    try {
      const results = await Promise.all(ids.map((id, i) =>
        supabase.from('gd_audiences').update({ sort_order: i, updated_at: new Date().toISOString() }).eq('id', id)));
      const failed = results.find(r => r.error);
      if (failed) throw failed.error;
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  app.put('/api/admin/gd/audiences/:id', requireAdmin, async (req, res) => {
    const { row, error: bad } = cleanAudience(req.body, { partial: true });
    if (bad) return res.status(400).json({ error: bad });
    if (!Object.keys(row).length) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      const { data, error } = await supabase.from('gd_audiences')
        .update({ ...row, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
      if (error) {
        if (error.code === 'PGRST116') return res.status(404).json({ error: 'Audience not found.' });
        throw error;
      }
      res.json({ audience: data });
    } catch (err) { fail(res, err); }
  });

  app.delete('/api/admin/gd/audiences/:id', requireAdmin, async (req, res) => {
    try {
      const { error } = await supabase.from('gd_audiences').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // Donor records (gd_donors): find one, see its personal link, change what the page knows about it.
  // Affiliations are edited as the wanted list: the difference from the import's tags is stored as admin
  // additions/removals, so a re-import never undoes the edit. Class year, grades and last-year gift are
  // overwritten (a re-import rewrites them).
  const BASE = 'id, token, re_id, first_name, last_name, email, class_year, grades, ly_gift, ask_a, ask_b, import_tags, tags_added, tags_removed';
  // Columns from sql/gd-13-sync.sql; until that is run the list falls back to BASE.
  const COLS = BASE + ', giving_ytd, addressee, salutation, alumni_addressee, alumni_salutation, household_re_id';
  const donorOut = d => ({
    id: d.id, token: d.token, re_id: d.re_id, first_name: d.first_name || '', last_name: d.last_name || '', email: d.email || '',
    class_year: d.class_year, ly: d.ly_gift != null ? Number(d.ly_gift) : null,
    ask_a: d.ask_a != null ? Number(d.ask_a) : null, ask_b: d.ask_b != null ? Number(d.ask_b) : null, tags: effectiveTags(d), grades: d.grades || [],
    addressee: d.addressee || '', salutation: d.salutation || '', alumni_addressee: d.alumni_addressee || '', alumni_salutation: d.alumni_salutation || '',
    giving_ytd: d.giving_ytd != null ? Number(d.giving_ytd) : null,
  });

  // Donor list, 50 a page, sorted by last name; q filters by name, email or RE ID.
  const DONOR_PAGE = 50;
  app.get('/api/admin/gd/donors', requireAdmin, async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    try {
      const run = async cols => {
        let qb = supabase.from('gd_donors').select(cols, { count: 'exact' });
        const term = q.replace(/[\\%_,()]/g, ' ').trim();
        if (typeof req.query.id === 'string' && req.query.id) qb = qb.eq('id', req.query.id);
        if (term) {
          const like = '%' + term + '%';
          qb = qb.or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},re_id.ilike.${like}`);
        }
        return qb.order('last_name', { nullsFirst: false }).order('first_name').order('id').range(page * DONOR_PAGE, page * DONOR_PAGE + DONOR_PAGE - 1);
      };
      let { data, error, count } = await run(COLS);
      if (error && error.code === '42703') ({ data, error, count } = await run(BASE));
      if (error) throw error;
      res.json({ donors: data.map(donorOut), total: count != null ? count : data.length, page, page_size: DONOR_PAGE });
    } catch (err) { fail(res, err); }
  });

  // Everyone at once for the Constituents list (grouped into households, searched and filtered in the browser),
  // with each person's platform gift total. Read in pages of 1,000 (the database's limit per request).
  app.get('/api/admin/gd/donors/all', requireAdmin, async (req, res) => {
    try {
      const readAll = async (table, cols, build) => {
        const out = [];
        for (let from = 0; ; from += 1000) {
          let qb = supabase.from(table).select(cols);
          if (build) qb = build(qb);
          const { data, error } = await qb.order('id').range(from, from + 999);
          if (error) throw error;
          out.push(...data);
          if (data.length < 1000) break;
        }
        return out;
      };
      let rows;
      try { rows = await readAll('gd_donors', COLS + ', active'); }
      catch (e) { if (e.code !== '42703') throw e; rows = await readAll('gd_donors', BASE); }
      const gifts = await readAll('gd_gifts', 'donor_id, amount, is_test, excluded, source', qb => qb.not('donor_id', 'is', null));
      const given = new Map();
      for (const g of gifts) {
        const r = given.get(g.donor_id) || { total: 0, n: 0, test: 0, off_total: 0, off_n: 0 };
        if (g.is_test) r.test++;
        else if (!g.excluded) { if (g.source === 'offline') { r.off_total += Number(g.amount); r.off_n++; } else { r.total += Number(g.amount); r.n++; } }
        given.set(g.donor_id, r);
      }
      res.json({
        donors: rows.map(d => {
          const g = given.get(d.id) || { total: 0, n: 0, test: 0, off_total: 0, off_n: 0 };
          return { ...donorOut(d), household: d.household_re_id || d.re_id, active: d.active !== false, gift_total: g.total, gift_count: g.n, offline_total: g.off_total, offline_count: g.off_n, test_gifts: g.test };
        }),
      });
    } catch (err) { fail(res, err); }
  });

  app.put('/api/admin/gd/donors/:id', requireAdmin, async (req, res) => {
    const b = req.body || {}, row = {};
    if ('first_name' in b) {
      const n = isBlank(b.first_name) ? '' : String(b.first_name).trim();
      if (n.length > 40) return res.status(400).json({ error: 'First name must be 40 characters or fewer.' });
      row.first_name = n || null;
    }
    if ('class_year' in b) {
      if (isBlank(b.class_year)) row.class_year = null;
      else { const y = Number(b.class_year); if (!Number.isInteger(y) || y < 1900 || y > 2100) return res.status(400).json({ error: 'Class year must be a four-digit year, like 2015.' }); row.class_year = y; }
    }
    if ('ly' in b) {
      if (isBlank(b.ly)) row.ly_gift = null;
      else { const v = Number(b.ly); if (!isFinite(v) || v < 0 || v > 10000000) return res.status(400).json({ error: "Last year's gift must be a dollar amount." }); row.ly_gift = Math.round(v); }
    }
    for (const [k, col, label] of [['ask_a', 'ask_a', 'Ask A'], ['ask_b', 'ask_b', 'Ask B']]) {
      if (!(k in b)) continue;
      if (isBlank(b[k])) { row[col] = null; continue; }
      const v = Number(b[k]);
      if (!isFinite(v) || v < 0 || v > 10000000) return res.status(400).json({ error: `${label} must be a dollar amount.` });
      row[col] = Math.round(v);
    }
    if ('grades' in b) {
      if (!Array.isArray(b.grades)) return res.status(400).json({ error: 'Grades must be a list.' });
      const bad = b.grades.find(g => !GRADES.includes(String(g)));
      if (bad !== undefined) return res.status(400).json({ error: `Unknown grade "${bad}".` });
      row.grades = GRADES.filter(g => b.grades.map(String).includes(g));
    }
    if ('tags' in b && !Array.isArray(b.tags)) return res.status(400).json({ error: 'Affiliations must be a list.' });
    if ('tags' in b) {
      const bad = b.tags.find(t => !TAG_KEYS.includes(t));
      if (bad !== undefined) return res.status(400).json({ error: `Unknown affiliation "${bad}".` });
    }
    try {
      const cur = await supabase.from('gd_donors').select(COLS).eq('id', req.params.id).maybeSingle();
      if (cur.error) throw cur.error;
      if (!cur.data) return res.status(404).json({ error: 'Donor not found.' });
      if ('tags' in b) {
        const want = new Set(b.tags), imp = new Set(cur.data.import_tags || []);
        row.tags_added = [...want].filter(t => !imp.has(t));
        row.tags_removed = [...imp].filter(t => !want.has(t));
      }
      if (Object.keys(row).length) {
        const { error } = await supabase.from('gd_donors').update({ ...row, updated_at: new Date().toISOString() }).eq('id', cur.data.id);
        if (error) throw error;
      }
      const after = await supabase.from('gd_donors').select(COLS).eq('id', cur.data.id).single();
      if (after.error) throw after.error;
      res.json({ donor: donorOut(after.data) });
    } catch (err) { fail(res, err); }
  });

  // Published audiences in order, for the page.
  async function loadPublished() {
    const { data, error } = await supabase.from('gd_audiences')
      .select('id, name, tags, grades, class_year_min, class_year_max, class_years, heading, body')
      .eq('published', true).order('sort_order').order('created_at');
    if (error) throw error;
    return data;
  }
  return { loadPublished };
};

module.exports.audienceFor = audienceFor;
module.exports.cleanAudience = cleanAudience;
