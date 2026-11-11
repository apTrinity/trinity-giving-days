// Giving Days -> Mailchimp: keeps the Mailchimp audience in step with the donor table.
//
// PREVIEW reads Mailchimp and the donor table and changes nothing in either.
// APPLY (only after a preview has been run on this server, and only when the preview has no blocking problems):
//   - adds people who are not in Mailchimp yet (first and last name are set ONLY for these new contacts)
//   - adds the tags "Gave 26-27" (household has given this year) and "Appeal: <code>" (RE appeal code),
//     and removes them again when they stop being true. No other tag on a contact is ever touched.
//   - saves each person's RE ID in the RE_ID merge field, so a changed email can be recognised later
//   - archives an old address only when the same RE ID now has a different email AND nobody else here uses the old one
// It never re-subscribes anyone (unsubscribed, cleaned and other non-subscribed contacts are left alone),
// never deletes anyone, and never overwrites the name of an existing contact.
//
// Needs on Render: MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX (e.g. us12), MAILCHIMP_AUDIENCE_ID.
// Optional: MAILCHIMP_NEW_STATUS (default "subscribed"), MAILCHIMP_MAX_ADDS (default 500), MAILCHIMP_MAX_ARCHIVES (default 100),
//           GD_MAILCHIMP_SCHEDULE=on (nightly apply at 4 a.m. Eastern, after one manual apply).
// The key is used only here on the server and is never sent to the browser.

const axios = require('axios');
const crypto = require('crypto');
const { fetchAll } = require('./giving-days-progress');

const GAVE_TAG = 'Gave 26-27';
const APPEAL_PREFIX = 'Appeal: ';
const appealTag = code => APPEAL_PREFIX + code;
const lc = v => String(v || '').trim().toLowerCase();
const hashOf = email => crypto.createHash('md5').update(lc(email)).digest('hex');

function config() {
  const key = process.env.MAILCHIMP_API_KEY, dc = process.env.MAILCHIMP_SERVER_PREFIX, list = process.env.MAILCHIMP_AUDIENCE_ID;
  const missing = [!key && 'MAILCHIMP_API_KEY', !dc && 'MAILCHIMP_SERVER_PREFIX', !list && 'MAILCHIMP_AUDIENCE_ID'].filter(Boolean);
  const newStatus = ['subscribed', 'pending'].includes(lc(process.env.MAILCHIMP_NEW_STATUS)) ? lc(process.env.MAILCHIMP_NEW_STATUS) : 'subscribed';
  const maxAdds = parseInt(process.env.MAILCHIMP_MAX_ADDS || '500', 10), maxArchives = parseInt(process.env.MAILCHIMP_MAX_ARCHIVES || '100', 10);
  return { key, dc, list, missing, newStatus, maxAdds, maxArchives };
}

const base = c => `https://${c.dc}.api.mailchimp.com/3.0/lists/${c.list}`;
const authOf = c => ({ username: 'giving-days', password: c.key });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchMembers(c) {
  const out = [];
  let total = null;
  for (let offset = 0; ; offset += 1000) {
    const r = await axios.get(`${base(c)}/members`, {
      auth: authOf(c), timeout: 60000,
      params: { count: 1000, offset, fields: 'total_items,members.email_address,members.status,members.merge_fields,members.tags' },
    });
    total = r.data.total_items;
    out.push(...(r.data.members || []));
    if (!r.data.members || r.data.members.length < 1000 || out.length >= total) break;
  }
  return out;
}

// Pure planning step (easy to test): donors + gift info + current Mailchimp members -> { report, actions }.
// donors: active gd_donors rows. gaveHouseholds: Set of household ids who have given this year.
function plan(donors, gaveHouseholds, members, limits = {}) {
  const hh = d => d.household_re_id || d.re_id;
  const byEmail = new Map();
  let noEmail = 0;
  for (const d of donors) {
    if (!lc(d.email)) { noEmail++; continue; }
    const e = lc(d.email);
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(d);
  }
  const want = new Map();   // email -> { first, last, appeal, gave, reid }
  for (const [e, a] of byEmail) {
    const lasts = [...new Set(a.map(x => x.last_name || '').filter(Boolean))];
    want.set(e, {
      email: e,
      first: a.length === 1 ? (a[0].first_name || '') : a.map(x => x.first_name || '').filter(Boolean).join(' & '),
      last: a.length === 1 ? (a[0].last_name || '') : lasts.join(' / '),
      appeal: (a.find(x => x.appeal_code) || {}).appeal_code || null,
      gave: a.some(x => gaveHouseholds.has(hh(x))),
      reid: String(a[0].re_id),
    });
  }
  const have = new Map(members.map(m => [lc(m.email_address), m]));
  const donorByReId = new Map(donors.map(d => [String(d.re_id), d]));
  const r = { donors_with_email: want.size, donors_without_email: noEmail, mailchimp_members: members.length,
    already_in_mailchimp: 0, would_add: 0, skipped_not_subscribed: 0, name_differs: 0,
    gave_total: 0, would_tag_gave: 0, would_untag_gave: 0, would_tag_appeal: 0, would_untag_appeal: 0, would_set_reid: 0, would_archive: 0, mailchimp_only: 0,
    status_counts: {}, blocking: [],
    examples: { would_add: [], name_differs: [], mailchimp_only: [], skipped_not_subscribed: [], would_archive: [] } };
  const actions = { adds: [], updates: [], removals: [], archives: [] };
  const push = (k, v) => { if (r.examples[k].length < 15) r.examples[k].push(v); };
  for (const m of members) r.status_counts[m.status] = (r.status_counts[m.status] || 0) + 1;

  for (const w of want.values()) {
    if (w.gave) r.gave_total++;
    const tagsWanted = [];
    if (w.gave) tagsWanted.push(GAVE_TAG);
    if (w.appeal) tagsWanted.push(appealTag(w.appeal));
    const m = have.get(w.email);
    if (!m) {
      r.would_add++; push('would_add', `${w.first} ${w.last} <${w.email}>`.trim());
      actions.adds.push({ email: w.email, first: w.first, last: w.last, reid: w.reid, tags: tagsWanted });
      if (w.gave) r.would_tag_gave++;
      if (w.appeal) r.would_tag_appeal++;
      continue;
    }
    r.already_in_mailchimp++;
    if (m.status !== 'subscribed') {   // unsubscribed, cleaned, pending, transactional: never touched
      r.skipped_not_subscribed++; push('skipped_not_subscribed', `${w.email} (${m.status})`); continue;
    }
    const mf = m.merge_fields || {}, tags = (m.tags || []).map(t => t.name);
    if (lc(mf.FNAME) !== lc(w.first) || lc(mf.LNAME) !== lc(w.last)) { r.name_differs++; push('name_differs', `${w.email}: Mailchimp "${(mf.FNAME || '') + ' ' + (mf.LNAME || '')}" -> "${w.first} ${w.last}"`); }
    const addTags = tagsWanted.filter(t => !tags.includes(t));
    const remove = tags.filter(t => (t === GAVE_TAG && !w.gave) || (t.startsWith(APPEAL_PREFIX) && t !== (w.appeal ? appealTag(w.appeal) : null)));
    if (w.gave && !tags.includes(GAVE_TAG)) r.would_tag_gave++;
    if (!w.gave && tags.includes(GAVE_TAG)) r.would_untag_gave++;
    if (w.appeal && !tags.includes(appealTag(w.appeal))) r.would_tag_appeal++;
    r.would_untag_appeal += remove.filter(t => t.startsWith(APPEAL_PREFIX)).length;
    const setReid = String(mf.RE_ID || '') !== w.reid;
    if (setReid) r.would_set_reid++;
    if (addTags.length || setReid) actions.updates.push({ email: w.email, reid: setReid ? w.reid : null, tags: addTags });
    if (remove.length) actions.removals.push({ email: w.email, remove });
  }

  // Changed email: a subscribed contact whose RE ID now has a different email, and no one else here uses the old address.
  for (const m of members) {
    const e = lc(m.email_address);
    if (want.has(e)) continue;   // someone here still uses this address
    r.mailchimp_only++; push('mailchimp_only', `${m.email_address} (${m.status})`);
    const rid = m.merge_fields && m.merge_fields.RE_ID ? String(m.merge_fields.RE_ID) : '';
    if (m.status !== 'subscribed' || !rid) continue;
    const d = donorByReId.get(rid);
    if (d && lc(d.email) && lc(d.email) !== e) {
      r.would_archive++; push('would_archive', `${m.email_address} -> ${d.email}`);
      actions.archives.push({ email: m.email_address, replacedBy: d.email });
    }
  }
  if (limits.maxAdds != null && actions.adds.length > limits.maxAdds) r.blocking.push(`${actions.adds.length} new contacts is more than the safety limit of ${limits.maxAdds} (MAILCHIMP_MAX_ADDS). Check the list, then raise the limit on Render.`);
  if (limits.maxArchives != null && actions.archives.length > limits.maxArchives) r.blocking.push(`${actions.archives.length} archives is more than the safety limit of ${limits.maxArchives} (MAILCHIMP_MAX_ARCHIVES).`);
  return { report: r, actions };
}

// ---- Apply helpers (talk to Mailchimp) ----
async function ensureReIdField(c) {
  const r = await axios.get(`${base(c)}/merge-fields`, { auth: authOf(c), params: { count: 100, fields: 'merge_fields.tag' }, timeout: 60000 });
  if ((r.data.merge_fields || []).some(f => f.tag === 'RE_ID')) return false;
  await axios.post(`${base(c)}/merge-fields`, { tag: 'RE_ID', name: 'RE ID', type: 'text', required: false, public: false }, { auth: authOf(c), timeout: 60000 });
  return true;
}

async function batchUpsert(c, items, summary) {
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const r = await axios.post(base(c), { members: chunk, update_existing: true }, { auth: authOf(c), timeout: 180000 });
    summary.created += r.data.total_created || 0;
    summary.updated += r.data.total_updated || 0;
    for (const e of (r.data.errors || [])) { summary.errors++; if (summary.error_examples.length < 10) summary.error_examples.push(`${e.email_address}: ${e.error}`); }
    await sleep(500);
  }
}

async function pool(items, size, fn) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) { const it = items[idx++]; await fn(it); }
  }));
}

module.exports = function mountGivingDaysMailchimp(app, { supabase, requireAdmin }) {
  let run = { state: 'idle' };
  let previewed = false, appliedOnce = false;
  let lastBlocking = [];

  async function load(cfg) {
    const [members, donors, gifts] = await Promise.all([
      fetchMembers(cfg),
      fetchAll(() => supabase.from('gd_donors').select('id, re_id, household_re_id, first_name, last_name, email, appeal_code, giving_ytd').eq('active', true)),
      fetchAll(() => supabase.from('gd_gifts').select('donor_id, email, is_test, excluded')),
    ]);
    const byId = new Map(donors.map(d => [d.id, d]));
    const byEmailD = new Map();
    for (const d of donors) if (lc(d.email) && !byEmailD.has(lc(d.email))) byEmailD.set(lc(d.email), d);
    const gave = new Set();
    for (const d of donors) if (Number(d.giving_ytd) > 0) gave.add(d.household_re_id || d.re_id);
    for (const g of gifts) {
      if (g.is_test || g.excluded) continue;
      const d = byId.get(g.donor_id) || (g.email && byEmailD.get(lc(g.email)));
      if (d) gave.add(d.household_re_id || d.re_id);
    }
    return { members, donors, gave };
  }

  async function execute(apply, by) {
    const t0 = Date.now();
    run = { state: 'running', mode: apply ? 'apply' : 'preview', started: new Date().toISOString(), by };
    const cfg = config();
    const scrub = s => (cfg.key ? String(s).split(cfg.key).join('***') : String(s));
    try {
      if (cfg.missing.length) throw new Error('Not set on the server: ' + cfg.missing.join(', '));
      const { members, donors, gave } = await load(cfg);
      const { report, actions } = plan(donors, gave, members, { maxAdds: cfg.maxAdds, maxArchives: cfg.maxArchives });
      lastBlocking = report.blocking;
      if (!apply) {
        previewed = true;
        run = { state: 'done', mode: 'preview', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result: report };
        return;
      }
      if (report.blocking.length) throw new Error('Not applied: ' + report.blocking.join(' '));
      const summary = { created: 0, updated: 0, errors: 0, error_examples: [], tags_removed: 0, archived: 0, merge_field_created: false };
      summary.merge_field_created = await ensureReIdField(cfg);
      const upserts = [
        ...actions.adds.map(a => ({ email_address: a.email, status: cfg.newStatus, merge_fields: { FNAME: a.first, LNAME: a.last, RE_ID: a.reid }, tags: a.tags })),
        ...actions.updates.map(u => { const o = { email_address: u.email, status: 'subscribed' }; if (u.reid) o.merge_fields = { RE_ID: u.reid }; if (u.tags.length) o.tags = u.tags; return o; }),
      ];
      await batchUpsert(cfg, upserts, summary);
      await pool(actions.removals, 8, async x => {
        try {
          await axios.post(`${base(cfg)}/members/${hashOf(x.email)}/tags`, { tags: x.remove.map(name => ({ name, status: 'inactive' })) }, { auth: authOf(cfg), timeout: 60000 });
          summary.tags_removed += x.remove.length;
        } catch (e) { summary.errors++; if (summary.error_examples.length < 10) summary.error_examples.push(`${x.email}: ${scrub(e.message)}`); }
      });
      await pool(actions.archives, 8, async x => {
        try { await axios.delete(`${base(cfg)}/members/${hashOf(x.email)}`, { auth: authOf(cfg), timeout: 60000 }); summary.archived++; }
        catch (e) { summary.errors++; if (summary.error_examples.length < 10) summary.error_examples.push(`${x.email}: ${scrub(e.message)}`); }
      });
      appliedOnce = true;
      console.log(`[GD mailchimp] applied by ${by}: +${summary.created} new, ${summary.updated} updated, ${summary.tags_removed} tags removed, ${summary.archived} archived, ${summary.errors} errors`);
      run = { state: 'done', mode: 'apply', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result: report, applied: summary };
    } catch (err) {
      const detail = scrub(err.response ? `${err.response.status} ${JSON.stringify(err.response.data || '').slice(0, 300)}` : (err.message || String(err)));
      console.error('[GD mailchimp] failed:', detail);
      run = { state: 'error', mode: apply ? 'apply' : 'preview', started: run.started, finished: new Date().toISOString(), error: detail };
    }
  }

  app.post('/api/admin/gd/mailchimp/preview', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A Mailchimp run is already in progress.' });
    execute(false, 'admin');
    res.status(202).json({ started: true });
  });
  app.post('/api/admin/gd/mailchimp/apply', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A Mailchimp run is already in progress.' });
    if (!previewed) return res.status(400).json({ error: 'Run a preview first.' });
    execute(true, 'admin');
    res.status(202).json({ started: true });
  });
  app.get('/api/admin/gd/mailchimp/status', requireAdmin, (req, res) => {
    const cfg = config();
    res.json({ ...run, configured: !cfg.missing.length, missing: cfg.missing, new_status: cfg.newStatus,
      schedule: String(process.env.GD_MAILCHIMP_SCHEDULE || '').toLowerCase() === 'on' });
  });

  // Opt-in nightly apply at 4 a.m. Eastern (after the 3 a.m. RE sync), only after one apply has been done by hand on this server.
  if (require('./sky-instance').backgroundAllowed() && String(process.env.GD_MAILCHIMP_SCHEDULE || '').toLowerCase() === 'on') {
    let lastDay = '';
    setInterval(() => {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day = et.getFullYear() + '-' + et.getMonth() + '-' + et.getDate();
      if (et.getHours() === 4 && lastDay !== day && run.state !== 'running' && appliedOnce) { lastDay = day; previewed = true; execute(true, 'nightly'); }
    }, 10 * 60 * 1000).unref();
  }
};

module.exports._test = { plan };
