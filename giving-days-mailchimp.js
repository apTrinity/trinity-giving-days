// Giving Days -> Mailchimp: PREVIEW ONLY (reads Mailchimp and the donor table; changes nothing in either).
//
// Shows what a sync would do to the Mailchimp audience: who is already there, who would be added,
// who would get the "Gave 26-27" tag, whose name differs, and who is in Mailchimp but not in the donor table.
// Contacts who unsubscribed or bounced are never touched. Nothing is ever deleted.
//
// Needs on Render: MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX (e.g. us12), MAILCHIMP_AUDIENCE_ID.
// The key is used only here on the server and is never sent to the browser.

const axios = require('axios');
const { fetchAll } = require('./giving-days-progress');

const GAVE_TAG = 'Gave 26-27';
const appealTag = code => 'Appeal: ' + code;
const lc = v => String(v || '').trim().toLowerCase();

function config() {
  const key = process.env.MAILCHIMP_API_KEY, dc = process.env.MAILCHIMP_SERVER_PREFIX, list = process.env.MAILCHIMP_AUDIENCE_ID;
  const missing = [!key && 'MAILCHIMP_API_KEY', !dc && 'MAILCHIMP_SERVER_PREFIX', !list && 'MAILCHIMP_AUDIENCE_ID'].filter(Boolean);
  return { key, dc, list, missing };
}

async function fetchMembers({ key, dc, list }) {
  const out = [];
  let total = null;
  for (let offset = 0; ; offset += 1000) {
    const r = await axios.get(`https://${dc}.api.mailchimp.com/3.0/lists/${list}/members`, {
      auth: { username: 'giving-days', password: key }, timeout: 60000,
      params: { count: 1000, offset, fields: 'total_items,members.email_address,members.status,members.merge_fields,members.tags' },
    });
    total = r.data.total_items;
    out.push(...(r.data.members || []));
    if (!r.data.members || r.data.members.length < 1000 || out.length >= total) break;
  }
  return out;
}

// Pure planning step (easy to test): donors + gift info + current Mailchimp members -> report.
// donors: active gd_donors rows. gaveHouseholds: Set of household ids who have given this year.
function plan(donors, gaveHouseholds, members) {
  const hh = d => d.household_re_id || d.re_id;
  const byEmail = new Map();
  let noEmail = 0;
  for (const d of donors) {
    if (!lc(d.email)) { noEmail++; continue; }
    const e = lc(d.email);
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(d);
  }
  const want = new Map();   // email -> { first, last, appeal, gave }
  for (const [e, a] of byEmail) {
    const lasts = [...new Set(a.map(x => x.last_name || '').filter(Boolean))];
    want.set(e, {
      email: e,
      first: a.length === 1 ? (a[0].first_name || '') : a.map(x => x.first_name || '').filter(Boolean).join(' & '),
      last: a.length === 1 ? (a[0].last_name || '') : lasts.join(' / '),
      appeal: (a.find(x => x.appeal_code) || {}).appeal_code || null,
      gave: a.some(x => gaveHouseholds.has(hh(x))),
    });
  }
  const have = new Map(members.map(m => [lc(m.email_address), m]));
  const r = { donors_with_email: want.size, donors_without_email: noEmail, mailchimp_members: members.length,
    already_in_mailchimp: 0, would_add: 0, skipped_not_subscribed: 0, name_differs: 0,
    gave_total: 0, would_tag_gave: 0, would_untag_gave: 0, would_tag_appeal: 0, mailchimp_only: 0,
    status_counts: {}, examples: { would_add: [], name_differs: [], mailchimp_only: [], skipped_not_subscribed: [] } };
  const push = (k, v) => { if (r.examples[k].length < 15) r.examples[k].push(v); };
  for (const m of members) r.status_counts[m.status] = (r.status_counts[m.status] || 0) + 1;
  for (const w of want.values()) {
    if (w.gave) r.gave_total++;
    const m = have.get(w.email);
    if (!m) { r.would_add++; push('would_add', `${w.first} ${w.last} <${w.email}>`.trim()); continue; }
    r.already_in_mailchimp++;
    if (m.status !== 'subscribed') {   // unsubscribed, cleaned, pending, transactional: never touched
      r.skipped_not_subscribed++; push('skipped_not_subscribed', `${w.email} (${m.status})`); continue;
    }
    const mf = m.merge_fields || {}, tags = (m.tags || []).map(t => t.name);
    if (lc(mf.FNAME) !== lc(w.first) || lc(mf.LNAME) !== lc(w.last)) { r.name_differs++; push('name_differs', `${w.email}: Mailchimp "${(mf.FNAME || '') + ' ' + (mf.LNAME || '')}" -> "${w.first} ${w.last}"`); }
    if (w.gave && !tags.includes(GAVE_TAG)) r.would_tag_gave++;
    if (!w.gave && tags.includes(GAVE_TAG)) r.would_untag_gave++;
    if (w.appeal && !tags.includes(appealTag(w.appeal))) r.would_tag_appeal++;
  }
  for (const m of members) if (!want.has(lc(m.email_address))) { r.mailchimp_only++; push('mailchimp_only', `${m.email_address} (${m.status})`); }
  return r;
}

module.exports = function mountGivingDaysMailchimp(app, { supabase, requireAdmin }) {
  let run = { state: 'idle' };

  async function execute(by) {
    const t0 = Date.now();
    run = { state: 'running', mode: 'preview', started: new Date().toISOString(), by };
    try {
      const cfg = config();
      if (cfg.missing.length) throw new Error('Not set on the server: ' + cfg.missing.join(', '));
      const [members, donors, gifts] = await Promise.all([
        fetchMembers(cfg),
        fetchAll(() => supabase.from('gd_donors').select('id, re_id, household_re_id, first_name, last_name, email, appeal_code, giving_ytd').eq('active', true)),
        fetchAll(() => supabase.from('gd_gifts').select('donor_id, email, is_test, excluded')),
      ]);
      const byId = new Map(donors.map(d => [d.id, d]));
      const gave = new Set();
      for (const d of donors) if (Number(d.giving_ytd) > 0) gave.add(d.household_re_id || d.re_id);
      for (const g of gifts) {
        if (g.is_test || g.excluded) continue;
        const d = byId.get(g.donor_id) || donors.find(x => g.email && lc(x.email) === lc(g.email));
        if (d) gave.add(d.household_re_id || d.re_id);
      }
      const result = plan(donors, gave, members);
      run = { state: 'done', mode: 'preview', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result };
    } catch (err) {
      const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data || '').slice(0, 200)}` : (err.message || String(err));
      console.error('[GD mailchimp] preview failed:', detail.replace(process.env.MAILCHIMP_API_KEY || '\u0000', '***'));
      run = { state: 'error', mode: 'preview', started: run.started, finished: new Date().toISOString(), error: detail.replace(process.env.MAILCHIMP_API_KEY || '\u0000', '***') };
    }
  }

  app.post('/api/admin/gd/mailchimp/preview', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A preview is already running.' });
    execute('admin');
    res.status(202).json({ started: true });
  });
  app.get('/api/admin/gd/mailchimp/status', requireAdmin, (req, res) => {
    const cfg = config();
    res.json({ ...run, configured: !cfg.missing.length, missing: cfg.missing });
  });
};

module.exports._test = { plan };
