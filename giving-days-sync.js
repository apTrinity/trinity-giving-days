// Giving Days sync: keeps gd_donors in step with Raiser's Edge by running a saved RE query (default 648898)
// through the SKY Query API, from inside the server (which owns the Blackbaud login and renews it safely).
//
//   RE query (one row per household)  ->  one gd_donors row per PERSON (a spouse becomes a second person)
//
// Two steps, always: PREVIEW (changes nothing; shows the columns found, who would be added or changed, problems)
// then APPLY. RE owns names, email, class year, last-year gift, Ask A/B (and grades/tags when the query has them).
// The platform owns the personal-link token, tags added or removed in the admin, and every recorded gift;
// a sync never touches those. People who leave the query are marked inactive, never deleted.
// After the Giving Days start, Ask A/B stop syncing for existing donors (GD_SYNC_FREEZE_ASKS=off to disable).
// Needs sql/gd-13-sync.sql for APPLY (adds gd_donors.active, synced_at and giving_ytd). PREVIEW needs nothing new.
// Nightly automatic runs are opt-in: GD_SYNC_SCHEDULE=on (3 a.m. Eastern, apply). Otherwise it is manual only.

const axios = require('axios');
const { parse } = require('csv-parse/sync');
const { TAGS } = require('./giving-days-admin');
const { makeToken } = require('./giving-days-donors');
const { fetchAll } = require('./giving-days-progress');

const QUERY_ID = () => parseInt(process.env.GD_SYNC_QUERY_ID || '-648898', 10);
const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// What each role is called in the query output (compared after lower-casing and dropping punctuation).
// Built for single-row query -648898 (see the column list in the admin's "Test an RE query" card).
const ALIASES = {
  re_id:         ['systemrecordid', 'constituentid', 'recordid', 'queryrecordid'],
  first:         ['firstname', 'first'],
  nick:          ['preferredname', 'nickname', 'preferredfirstname'],
  last:          ['lastname', 'last'],
  gender:        ['gender'],
  email:         ['email1', 'parent1email', 'email', 'primaryemail'],
  email2:        ['email2'],
  class_year:    ['class', 'classyear', 'classof'],
  spouse_re_id:  ['spousesystemrecordid', 'spouseconstituentid', 'spouserecordid'],
  spouse_first:  ['spousefirstname', 'spousefirst'],
  spouse_nick:   ['spousepreferredname', 'spousenickname'],
  spouse_last:   ['spouselastname', 'spouselast'],
  ly_gift:       ['askly', 'lygift', 'lastyeargift', 'lyask'],
  ask_a:         ['aska'],
  ask_b:         ['askb'],
  current_parent:  ['currentparent'],
  alumni_flag:     ['alumni'],
  faculty:         ['currentfacstaff', 'currentfacultystaff'],
  grandparent:     ['grandparent'],
  parent_of_alumni: ['pal1constituencycode'],
  appeal_code:   ['appealcode'],
  addressee:     ['addressee', 'primaryaddressee', 'householdaddressee'],
  salutation:    ['salutation', 'primarysalutation', 'householdsalutation'],
  alumni_addressee:  ['alumniaddressee'],
  alumni_salutation: ['alumnisalutation'],
  primary_code:  ['primaryconstituencycode', 'primaryconstituentcode', 'primarycode', 'constituentcode'],
  giving_ytd:    ['2627giving', 'giving2627', 'currentyeargiving'],
  deceased:      ['deceased', 'isdeceased'],
  no_solicit:    ['donotsolicit', 'nosolicit'],
};
const ROLE_LABEL = {
  re_id: 'RE ID (person)', first: 'First name', nick: 'Preferred name', last: 'Last name', gender: 'Gender', email: 'Email', email2: 'Email 2 (spouse, parents only)',
  class_year: 'Class year (alumni)', spouse_re_id: 'Spouse RE ID', spouse_first: 'Spouse first name', spouse_nick: 'Spouse preferred name', spouse_last: 'Spouse last name',
  ly_gift: 'Last year\'s gift', ask_a: 'Ask A', ask_b: 'Ask B', current_parent: 'Current Parent flag', alumni_flag: 'Alumni flag', faculty: 'Faculty/Staff flag',
  grandparent: 'Grandparent flag', parent_of_alumni: 'Parent of Alumni / Withdrawn Parent code', appeal_code: 'Appeal Code (NEW FAMILY = new family)', addressee: 'Addressee (household)', salutation: 'Salutation (household)', alumni_addressee: 'Alumni addressee', alumni_salutation: 'Alumni salutation', primary_code: 'Primary Constituent Code', giving_ytd: 'This year\'s giving (26-27)', deceased: 'Deceased', no_solicit: 'Do not solicit', student_classes: 'Student class years (for grades)',
};

function mapHeaders(headers) {
  const roles = {}, used = new Set();
  for (const [role, names] of Object.entries(ALIASES)) {
    const h = headers.find(x => names.includes(norm(x)) && !used.has(x));
    if (h) { roles[role] = h; used.add(h); }
  }
  const sc = headers.filter(h => /^studentclass\d*$/.test(norm(h)));   // Student Class, Student Class_1, _2, _3 ...
  if (sc.length) { roles.student_classes = sc; sc.forEach(h => used.add(h)); }
  return { roles, unmatched: headers.filter(h => !used.has(h)) };
}

const money = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) && n >= 0 ? n : null; };
const text = v => { const s = String(v == null ? '' : v).trim(); return s || null; };
const yes = v => /^(y|yes|true|1|x)/i.test(String(v == null ? '' : v).trim());
// RE writes classes as '78 or 1978. Alumni: 27 to 99 are 1927-1999, 00 to 26 are 2000-2026. Students: always 20YY.
function classYear(v, student) {
  const s = String(v == null ? '' : v).trim(); if (!s) return null;
  const four = s.match(/(19|20)\d{2}/);
  let y = four ? parseInt(four[0], 10) : null;
  if (y == null) { const m = s.match(/(\d{2})\D*$/); if (!m) return null; const yy = parseInt(m[1], 10); y = student ? 2000 + yy : (yy >= 27 ? 1900 + yy : 2000 + yy); }
  return y >= 1900 && y <= 2100 ? y : null;
}
// The 2026-27 school year: the class of 2027 is in grade 12, so grade = 12 - (class - 2027); the class of 2039 is K.
const SCHOOL_YEAR_SENIORS = 2027;
function gradeOf(cy) { const g = 12 - (cy - SCHOOL_YEAR_SENIORS); return g === 0 ? 'K' : g >= 1 && g <= 12 ? String(g) : null; }
const gradeSort = (a, b) => (a === 'K' ? 0 : +a) - (b === 'K' ? 0 : +b);

// Primary Constituent Codes that describe ONE person's tie to the school (current or former faculty/staff, alumni, withdrawn alumni).
// With one of these and no household code on the record (current parent, parent of alumni / withdrawn parent, grandparent),
// the spouse is not imported. With any household code, both spouses are.
const INDIVIDUAL_CODE = /^\s*((current|former)\s+)?fac|^\s*(withdrawn\s+)?alumn|^\s*widow of alumn/i;   // faculty/staff (current, former, emeriti), alumni, withdrawn alumni, widow of alumni

// Household rows -> people. Returns { people, issues, examples, notes }.
// Per person (the main constituent): alumni, alumna, faculty tags and class year. Per household (both spouses): current_parent,
// parent_of_alumni, grandparent tags, grades, asks and last year's gift. A spouse who has a row of their own is taken from that row.
function toPeople(rows, roles) {
  const g = (r, role) => (roles[role] ? r[roles[role]] : undefined);
  const people = new Map(), pending = [], codes = new Map();
  const issues = { no_id: 0, no_name: 0, no_email: 0, duplicate_id: 0, deceased: 0, no_solicit: 0, spouse_id_missing: 0, spouse_has_own_row: 0,
    withdrawn_alumni: 0, withdrawn_parent: 0, new_family: 0, spouse_skipped_individual: 0, class_year_unreadable: 0, student_class_outside_k12: 0, email2_used: 0, email2_ignored: 0 };
  const examples = { no_email: [], no_id: [], no_name: [], class_year_unreadable: [] };
  const push = (arr, v) => { if (arr.length < 5) arr.push(v); };
  const add = (p, label) => {
    if (!p.re_id) { issues.no_id++; push(examples.no_id, label); return false; }
    if (!p.first_name && !p.last_name) { issues.no_name++; push(examples.no_name, p.re_id); return false; }
    if (people.has(p.re_id)) { issues.duplicate_id++; return false; }
    people.set(p.re_id, p); return true;
  };
  for (const r of rows) {
    if (yes(g(r, 'deceased'))) { issues.deceased++; continue; }
    if (yes(g(r, 'no_solicit'))) { issues.no_solicit++; continue; }
    const id = text(g(r, 're_id'));
    const alumniVal = text(g(r, 'alumni_flag')) || '', palVal = text(g(r, 'parent_of_alumni')) || '';
    const household = new Set();
    if (text(g(r, 'current_parent'))) household.add('current_parent');
    if (palVal) { household.add('parent_of_alumni'); if (/^withdrawn/i.test(palVal)) issues.withdrawn_parent++; }   // Parent of Alumni and Withdrawn Parent both count
    if (/^new family/i.test(text(g(r, 'appeal_code')) || '')) { household.add('new_family'); issues.new_family++; }
    if (text(g(r, 'grandparent'))) household.add('grandparent');
    const gradeSet = new Set();
    for (const h of (roles.student_classes || [])) {
      const cy = classYear(r[h], true); if (cy == null) continue;
      const gr = gradeOf(cy); if (gr) gradeSet.add(gr); else issues.student_class_outside_k12++;
    }
    const grades = [...gradeSet].sort(gradeSort);
    const code = text(g(r, 'primary_code')) || '';
    const individualOnly = !!roles.primary_code && INDIVIDUAL_CODE.test(code) && household.size === 0;
    // Codes with no flag column of their own: a withdrawn grandparent is a grandparent; only the Friend code is a friend (trustees get no tag from being trustees).
    if (/^withdrawn grandparent/i.test(code)) household.add('grandparent');
    if (/^friend/i.test(code)) household.add('friend');
    const own = new Set(household);
    if (alumniVal) { own.add('alumni'); if (/^withdrawn/i.test(alumniVal)) issues.withdrawn_alumni++; if (/^female/i.test(text(g(r, 'gender')) || '')) own.add('alumna'); }
    if (text(g(r, 'faculty'))) own.add('faculty');
    let cy = null;
    if (alumniVal && text(g(r, 'class_year'))) { cy = classYear(g(r, 'class_year'), false); if (cy == null) { issues.class_year_unreadable++; push(examples.class_year_unreadable, `${text(g(r, 'first')) || ''} ${text(g(r, 'last')) || ''}: ${g(r, 'class_year')}`.trim()); } }
    const first = text(g(r, 'nick')) || text(g(r, 'first')), last = text(g(r, 'last'));
    const pos = v => (v != null && v > 0 ? v : null);   // RE writes $0 when there is no ask or no gift last year: treat that as none, so the form shows no $0 button
    const hh = { ly_gift: pos(money(g(r, 'ly_gift'))), ask_a: pos(money(g(r, 'ask_a'))), ask_b: pos(money(g(r, 'ask_b'))), giving_ytd: money(g(r, 'giving_ytd')) };
    const email = (text(g(r, 'email')) || '').toLowerCase() || null;
    const names = { addressee: text(g(r, 'addressee')), salutation: text(g(r, 'salutation')), household_re_id: id, appeal_code: text(g(r, 'appeal_code')) };
    const person = { re_id: id, first_name: first, last_name: last, email, class_year: cy, grades, import_tags: [...own].sort(), ...hh, ...names,
      alumni_addressee: alumniVal ? text(g(r, 'alumni_addressee')) : null, alumni_salutation: alumniVal ? text(g(r, 'alumni_salutation')) : null };
    if (add(person, `row with ${first || ''} ${last || ''}`.trim()) && !email) { issues.no_email++; push(examples.no_email, `${first || ''} ${last || ''} (${id})`.trim()); }
    // Spouse: Email 2 is the spouse's address only for current parents and parents of alumni; for everyone else it is ignored.
    const sFirst = text(g(r, 'spouse_nick')) || text(g(r, 'spouse_first')), sLast = text(g(r, 'spouse_last'));
    if (roles.primary_code && (sFirst || sLast)) { const c = codes.get(code) || { n: 0, skipped: 0 }; c.n++; if (individualOnly) c.skipped++; codes.set(code, c); }
    if ((sFirst || sLast) && individualOnly) { issues.spouse_skipped_individual++; continue; }
    if (sFirst || sLast) {
      const sid = text(g(r, 'spouse_re_id'));
      const parentHousehold = household.has('current_parent') || household.has('parent_of_alumni');
      const e2 = (text(g(r, 'email2')) || '').toLowerCase() || null;
      if (e2) { if (parentHousehold) issues.email2_used++; else issues.email2_ignored++; }
      if (!sid) { issues.spouse_id_missing++; continue; }
      pending.push({ re_id: sid, first_name: sFirst, last_name: sLast || last, email: parentHousehold ? e2 : null, class_year: null, grades, import_tags: [...household].sort(), ...hh, ...names, alumni_addressee: null, alumni_salutation: null });
    }
  }
  for (const sp of pending) {
    if (people.has(sp.re_id)) { issues.spouse_has_own_row++; continue; }   // their own row is richer: keep that one
    if (add(sp, 'spouse') && !sp.email) issues.no_email++;
  }
  return { people: [...people.values()], issues, examples, unknownTags: [], codes: [...codes.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20).map(([code, c]) => ({ code: code || '(blank)', ...c })) };
}

const FIELDS = ['first_name', 'last_name', 'email', 'class_year', 'ly_gift', 'ask_a', 'ask_b', 'giving_ytd', 'grades', 'import_tags', 'addressee', 'salutation', 'alumni_addressee', 'alumni_salutation', 'household_re_id', 'appeal_code'];
const BASE_COLS = 'id, re_id, first_name, last_name, email, class_year, ly_gift, ask_a, ask_b, grades, import_tags';
const NEW_COLS = ', giving_ytd, addressee, salutation, alumni_addressee, alumni_salutation, household_re_id, appeal_code';
const same = (a, b) => (Array.isArray(a) || Array.isArray(b)) ? JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort())
  : (a == null && b == null) || (a != null && b != null && String(a) === String(b)) || (typeof a === 'number' && Number(b) === a);

module.exports = function mountGivingDaysSync(app, { supabase, requireAdmin, skyRequest }) {
  let run = { state: 'idle' };      // in-memory status of the latest run
  let previewed = false;            // APPLY is refused until a preview has completed since the server started

  async function runQuery(id) {
    const ex = await skyRequest({ method: 'post', url: 'https://api.sky.blackbaud.com/query/queries/executebyid', params: { product: 'RE', module: 'None' }, data: { id } });
    const jobId = ex.data && ex.data.id;
    if (!jobId) throw new Error('Blackbaud did not return a job for query ' + id);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const j = await skyRequest({ method: 'get', url: 'https://api.sky.blackbaud.com/query/jobs/' + jobId, params: { product: 'RE', module: 'None', include_read_url: 1 } });
      const st = j.data && j.data.status;
      if (st === 'Completed') {
        const csv = (await axios.get(j.data.sas_uri, { responseType: 'text' })).data;
        return parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
      }
      if (['Failed', 'Cancelled'].includes(st)) throw new Error('The RE query job ' + st.toLowerCase() + '.');
    }
    throw new Error('The RE query took longer than 4 minutes.');
  }

  async function execute(apply, by) {
    const t0 = Date.now();
    run = { state: 'running', mode: apply ? 'apply' : 'preview', started: new Date().toISOString(), by };
    try {
      const rows = await runQuery(QUERY_ID());
      const headers = rows.length ? Object.keys(rows[0]) : [];
      const { roles, unmatched } = mapHeaders(headers);
      const { people, issues, examples, unknownTags, codes } = toPeople(rows, roles);
      // Columns added by sql/gd-13-sync.sql may not exist yet (a preview works either way): fall back to the older set.
      let have;
      try { have = await fetchAll(() => supabase.from('gd_donors').select(BASE_COLS + NEW_COLS)); }
      catch (e) { if (e && e.code === '42703') have = await fetchAll(() => supabase.from('gd_donors').select(BASE_COLS)); else throw e; }
      const byId = new Map(have.map(d => [String(d.re_id), d]));
      const seen = new Set(people.map(p => p.re_id));
      const { data: st } = await supabase.from('gd_settings').select('starts_at').eq('id', 1).single();
      const frozen = String(process.env.GD_SYNC_FREEZE_ASKS || 'on').toLowerCase() !== 'off' && st && Date.now() >= new Date(st.starts_at).getTime();
      const fields = FIELDS;
      const adds = [], changes = [], blankKept = { email: 0 };
      for (const p of people) {
        const d = byId.get(p.re_id);
        if (!d) { adds.push(p); continue; }
        const patch = {};
        for (const f of fields) {
          if ((f === 'ask_a' || f === 'ask_b') && frozen) continue;
          if (p[f] === undefined || d[f] === undefined) continue;   // not in the query, or the column is not in the table yet
          if (f === 'email' && !p.email && d.email) { blankKept.email++; continue; }   // never blank out an email we have
          if (!same(p[f], d[f])) patch[f] = p[f];
        }
        if (Object.keys(patch).length) changes.push({ id: d.id, re_id: p.re_id, patch });
      }
      const missing = have.filter(d => !seen.has(String(d.re_id)));
      const changedBy = {};
      for (const c of changes) for (const f of Object.keys(c.patch)) changedBy[f] = (changedBy[f] || 0) + 1;
      const result = {
        query_id: QUERY_ID(), rows: rows.length, people: people.length,
        headers, matched: Object.fromEntries(Object.entries(roles).map(([r, h]) => [ROLE_LABEL[r], h])),
        missing_roles: Object.keys(ALIASES).filter(r => !roles[r]).map(r => ROLE_LABEL[r]), unmatched_columns: unmatched,
        issues, examples, primary_codes: codes, unknown_tags: unknownTags, asks_frozen: !!frozen,
        would: { add: adds.length, update: changes.length, unchanged: people.length - adds.length - changes.length, missing_from_query: missing.length, changed_fields: changedBy, blank_email_kept: blankKept.email },
        sample: people.slice(0, 5),
        blocking: [!roles.re_id && 'The query has no RE ID column.', !(roles.first || roles.nick) && !roles.last && 'The query has no name columns.', !roles.email && 'The query has no email column.'].filter(Boolean),
      };
      if (!apply) { previewed = true; run = { state: 'done', mode: 'preview', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result }; return; }

      if (result.blocking.length) throw new Error('Not applied: ' + result.blocking.join(' '));
      const probe = await supabase.from('gd_donors').select('active, addressee, household_re_id, appeal_code').limit(1);
      if (probe.error) throw new Error('Not applied: run sql/gd-13-sync.sql and sql/gd-15-appeal-code.sql in Supabase first (they add the active, synced_at, giving_ytd, addressee, household and appeal_code columns).');
      const now = new Date().toISOString();
      // New people: a fresh personal-link code each.
      const taken = new Set((await fetchAll(() => supabase.from('gd_donors').select('token'))).map(d => d.token));
      const fresh = () => { for (;;) { const t = makeToken(); if (!taken.has(t)) { taken.add(t); return t; } } };
      for (let i = 0; i < adds.length; i += 200) {
        const chunk = adds.slice(i, i + 200).map(p => {
          const r = { token: fresh(), re_id: p.re_id, first_name: p.first_name, last_name: p.last_name, email: p.email, class_year: p.class_year, ly_gift: p.ly_gift, ask_a: p.ask_a, ask_b: p.ask_b, giving_ytd: p.giving_ytd, addressee: p.addressee, salutation: p.salutation, alumni_addressee: p.alumni_addressee, alumni_salutation: p.alumni_salutation, household_re_id: p.household_re_id, appeal_code: p.appeal_code, active: true, synced_at: now };
          if (p.grades !== undefined) r.grades = p.grades;
          if (p.import_tags !== undefined) r.import_tags = p.import_tags;
          return r;
        });
        const { error } = await supabase.from('gd_donors').insert(chunk);
        if (error) throw error;
      }
      for (let i = 0; i < changes.length; i += 10) {
        await Promise.all(changes.slice(i, i + 10).map(async c => {
          const { error } = await supabase.from('gd_donors').update({ ...c.patch, active: true, synced_at: now, updated_at: now }).eq('id', c.id);
          if (error) throw error;
        }));
      }
      // Everyone seen is active and stamped; everyone who left the query is marked inactive (kept, with their history).
      const seenIds = people.map(p => p.re_id).filter(id => byId.has(id));
      for (let i = 0; i < seenIds.length; i += 200) await supabase.from('gd_donors').update({ active: true, synced_at: now }).in('re_id', seenIds.slice(i, i + 200));
      const goneIds = missing.map(d => d.re_id);
      for (let i = 0; i < goneIds.length; i += 200) await supabase.from('gd_donors').update({ active: false }).in('re_id', goneIds.slice(i, i + 200));
      console.log(`[GD sync] applied by ${by}: +${adds.length} new, ${changes.length} updated, ${missing.length} inactive`);
      run = { state: 'done', mode: 'apply', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result };
    } catch (err) {
      const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data || '').slice(0, 200)}` : (err.message || String(err));
      console.error('[GD sync] failed:', detail);
      run = { state: 'error', mode: apply ? 'apply' : 'preview', started: run.started, finished: new Date().toISOString(), error: detail };
    }
  }

  app.post('/api/admin/gd/sync/start', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A sync is already running.' });
    const apply = !!(req.body && req.body.apply);
    if (apply && !previewed) return res.status(400).json({ error: 'Run a preview first.' });
    execute(apply, 'admin');
    res.status(202).json({ started: true });
  });
  app.get('/api/admin/gd/sync/status', requireAdmin, (req, res) => res.json({ ...run, query_id: QUERY_ID(), schedule: String(process.env.GD_SYNC_SCHEDULE || '').toLowerCase() === 'on' }));

  // Opt-in nightly apply at 3 a.m. Eastern (only after a preview has been run and applied by hand at least once on this server).
  if (require('./sky-instance').backgroundAllowed() && String(process.env.GD_SYNC_SCHEDULE || '').toLowerCase() === 'on') {
    let lastDay = '';
    setInterval(() => {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day = et.toISOString().slice(0, 10) + '|' + et.getFullYear() + et.getMonth() + et.getDate();
      if (et.getHours() === 3 && lastDay !== day && run.state !== 'running') { lastDay = day; previewed = true; execute(true, 'nightly'); }
    }, 10 * 60 * 1000).unref();
  }
};

module.exports._test = { mapHeaders, toPeople };
