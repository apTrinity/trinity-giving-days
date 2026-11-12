// Giving Days offline gifts: gifts entered in Raiser's Edge (checks, cash, stock, phone) are pulled in from a saved
// RE query and recorded as gifts, so they count toward progress, challenges and donor totals like online gifts do.
// Works like the parents campaign's offline sync: the QUERY decides which gifts qualify (the "line in the sand":
// gift date from the launch, fund, type ...). This code only reads what the query returns.
//
// Query: a normal (many-row) gift query. Needs, per gift: the gift's ID, the constituent's system record ID,
// the amount and the gift date (anonymous and fund are optional). If the query returns only a gift ID, each gift is
// looked up through the API instead (slower).
// Runs by itself every 30 minutes once GD_OFFLINE_QUERY_ID is set (GD_OFFLINE_SCHEDULE=off turns that off), and on demand from
// the admin ("Sync now"; "Check only" shows what would happen without saving). No approval step: a gift whose constituent is on
// the donor list is recorded automatically, once (transaction id "re-<gift id>"); if its amount changes in RE the recorded
// amount follows. A gift whose constituent is NOT on the donor list is never recorded: it is called out in the admin (red
// banner) and emailed to staff, and is picked up automatically on a later run once the person is on the list.

const axios = require('axios');
const { parse } = require('csv-parse/sync');
const { fetchAll, invalidate } = require('./giving-days-progress');
const { sendOfflineUnmatchedAlert } = require('./giving-days-emails');

const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  name:      ['constituentname', 'name', 'donorname', 'fullname', 'constituentfullname'],
  gift_id:   ['giftsystemrecordid', 'giftid', 'giftsystemid', 'giftrecordid', 'giftsystemrecord'],
  re_id:     ['constituentsystemrecordid', 'constituentsystemid', 'constituentrecordid', 'constituentid', 'constituentqueryrecordid', 'reid', 'qrecid'],
  amount:    ['amount', 'giftamount', 'giftamt', 'amountreceived', 'receiptamount'],
  date:      ['giftdate', 'date', 'datereceived'],
  anonymous: ['anonymous', 'isanonymous', 'giftanonymous'],
  fund:      ['fund', 'funddescription', 'giftfund'],
};
const LABEL = { name: 'Constituent name', gift_id: 'Gift ID', re_id: 'Constituent system record ID', amount: 'Amount', date: 'Gift date', anonymous: 'Anonymous', fund: 'Fund' };

function mapHeaders(headers) {
  const by = new Map(headers.map(h => [norm(h), h]));
  const roles = {};
  for (const [role, names] of Object.entries(ALIASES)) for (const n of names) if (by.has(n)) { roles[role] = by.get(n); break; }
  // A bare "System Record ID" is the gift's own ID when the query also names the constituent separately.
  if (!roles.gift_id && by.has('systemrecordid')) roles.gift_id = by.get('systemrecordid');
  return roles;
}
const money = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
const yes = v => /^(y|yes|true|1|x)/i.test(String(v == null ? '' : v).trim());
// A gift date has no time: record it at noon Eastern so it lands on the right day.
function giftTime(v) {
  const s = String(v || '').trim(); let y, m, d, x;
  if ((x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { m = +x[1]; d = +x[2]; y = +x[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00-05:00`).toISOString();
}

module.exports = function mountGivingDaysOffline(app, { supabase, requireAdmin, skyRequest }) {
  let run = { state: 'idle' };
  let alert = { count: 0, total: 0, gifts: [] }, emailed = new Set();
  // A query ID typed in the admin is used for that one run only. The automatic 30-minute import always follows the
  // GD_OFFLINE_QUERY_ID setting on the server, so trying out another query can never re-point it.
  const queryId = body => {
    const raw = body && body.query_id != null && body.query_id !== '' ? body.query_id : process.env.GD_OFFLINE_QUERY_ID;
    const n = parseInt(raw, 10); return isFinite(n) && n !== 0 ? n : null;
  };

  async function runQuery(id) {
    const ex = await skyRequest({ method: 'post', url: 'https://api.sky.blackbaud.com/query/queries/executebyid', params: { product: 'RE', module: 'None' }, data: { id } });
    const jobId = ex.data && ex.data.id;
    if (!jobId) throw new Error('Blackbaud did not return a job for query ' + id);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const j = await skyRequest({ method: 'get', url: 'https://api.sky.blackbaud.com/query/jobs/' + jobId, params: { product: 'RE', module: 'None', include_read_url: 1 } });
      const st = j.data && j.data.status;
      if (st === 'Completed') {
        const csv = (await axios.get(j.data.sas_uri, { responseType: 'text', timeout: 120000 })).data;
        return parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
      }
      if (['Failed', 'Cancelled'].includes(st)) throw new Error('The RE query job ' + st.toLowerCase() + '.');
    }
    throw new Error('The RE query took longer than 4 minutes.');
  }

  const LOOKUP_MAX = 300;
  async function execute(apply, by, id) {
    const t0 = Date.now();
    run = { state: 'running', mode: apply ? 'apply' : 'preview', started: new Date().toISOString(), by, query_id: id };
    try {
      const rows = await runQuery(id);
      const headers = rows.length ? Object.keys(rows[0]) : [];
      const roles = mapHeaders(headers);
      const blocking = [];
      if (!roles.gift_id) blocking.push('The query has no gift ID column (a column named Gift ID or Gift System Record ID).');
      const gifts = [], skipped = { no_id: 0, no_amount: 0, lookups: 0, lookup_failed: 0 };
      for (const r of rows) {
        const gid = String(r[roles.gift_id] || '').trim();
        if (!gid) { skipped.no_id++; continue; }
        let g = { gift_id: gid, re_id: roles.re_id ? String(r[roles.re_id] || '').trim() : '', amount: roles.amount ? money(r[roles.amount]) : null,
          at: roles.date ? giftTime(r[roles.date]) : null, name: roles.name ? String(r[roles.name] || '').trim() : '', raw_date: roles.date ? r[roles.date] : '', anonymous: roles.anonymous ? yes(r[roles.anonymous]) : false, fund: roles.fund ? r[roles.fund] : '' };
        if ((!g.re_id || g.amount == null || !g.at) && skipped.lookups < LOOKUP_MAX) {   // fill the gaps from the gift record itself
          skipped.lookups++;
          try {
            const d = (await skyRequest({ method: 'get', url: 'https://api.sky.blackbaud.com/gift/v1/gifts/' + encodeURIComponent(gid) })).data || {};
            g.re_id = g.re_id || String(d.constituent_id || '');
            if (g.amount == null && d.amount) g.amount = money(d.amount.value);
            g.at = g.at || giftTime(d.date);
            if (d.is_anonymous) g.anonymous = true;
          } catch (e) { skipped.lookup_failed++; }
        }
        if (g.amount == null || !(g.amount > 0)) { skipped.no_amount++; continue; }
        gifts.push(g);
      }
      if (!gifts.length && rows.length && !blocking.length) blocking.push('No usable gifts: the query needs the constituent ID, amount and date columns (or just a gift ID).');

      const donors = await fetchAll(() => supabase.from('gd_donors').select('id, re_id, first_name, last_name, email').order('id'));
      const byRe = new Map(donors.map(d => [String(d.re_id), d]));
      const existing = await fetchAll(() => supabase.from('gd_gifts').select('id, transaction_id, amount').like('transaction_id', 're-%').order('id'));
      const have = new Map(existing.map(g => [g.transaction_id, g]));
      const adds = [], changes = [], unmatched = [];
      let same = 0;
      for (const g of gifts) {
        const tid = 're-' + g.gift_id, cur = have.get(tid);
        if (cur) { if (Math.abs(Number(cur.amount) - g.amount) > 0.001) changes.push({ id: cur.id, amount: g.amount }); else same++; continue; }
        const d = byRe.get(g.re_id);
        if (!d) { unmatched.push(g); continue; }
        adds.push({ transaction_id: tid, amount: g.amount, first_name: d.first_name, last_name: d.last_name, email: d.email, anonymous: g.anonymous,
          is_test: false, donor_id: d.id, source: 'offline', ...(g.at ? { created_at: g.at } : {}) });
      }
      const dates = gifts.map(g => g.at).filter(Boolean).sort();
      const sum = a => a.reduce((t, x) => t + Number(x.amount), 0);
      const result = {
        query_id: id, rows: rows.length, headers, matched: Object.fromEntries(Object.entries(roles).map(([r, h]) => [LABEL[r], h])),
        missing_roles: Object.keys(ALIASES).filter(r => !roles[r]).map(r => LABEL[r]), skipped,
        gifts: gifts.length, first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
        would: { add: adds.length, add_total: sum(adds), update: changes.length, already_recorded: same, unmatched: unmatched.length, unmatched_total: sum(unmatched) },
        sample: adds.slice(0, 5).map(a => ({ who: [a.first_name, a.last_name].filter(Boolean).join(' '), amount: a.amount, at: a.created_at || null })),
        unmatched_examples: unmatched.slice(0, 8).map(g => ({ re_id: g.re_id || '(none)', gift_id: g.gift_id, amount: g.amount })),
        unmatched_all: unmatched.slice(0, 50).map(g => ({ re_id: g.re_id, gift_id: g.gift_id, amount: g.amount, name: g.name, date: g.at ? g.at.slice(0, 10) : '' })),
        blocking,
      };
      alert = { count: unmatched.length, total: sum(unmatched), gifts: result.unmatched_all, at: new Date().toISOString() };
      if (!apply) { run = { state: 'done', mode: 'preview', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result }; return; }
      if (blocking.length) throw new Error('Not applied: ' + blocking.join(' '));

      for (let i = 0; i < adds.length; i += 200) {
        let chunk = adds.slice(i, i + 200);
        let { error } = await supabase.from('gd_gifts').insert(chunk);
        if (error && error.code === '42703') ({ error } = await supabase.from('gd_gifts').insert(chunk.map(({ source, ...rest }) => rest)));   // gd-12 not run: no source column
        if (error) throw error;
      }
      for (const c of changes) {
        const { error } = await supabase.from('gd_gifts').update({ amount: c.amount, updated_at: new Date().toISOString() }).eq('id', c.id);
        if (error) throw error;
      }
      if (adds.length || changes.length) invalidate();
      const fresh = unmatched.filter(g => !emailed.has(g.gift_id));
      if (fresh.length) {
        try { await sendOfflineUnmatchedAlert(alert.gifts.filter(g => fresh.some(f => f.gift_id === g.gift_id))); fresh.forEach(g => emailed.add(g.gift_id)); }
        catch (e) { console.error('[GD offline] alert email failed:', e.message); }
      }
      console.log(`[GD offline] applied by ${by}: +${adds.length} gifts, ${changes.length} amounts updated, ${unmatched.length} unmatched`);
      run = { state: 'done', mode: 'apply', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result };
    } catch (err) {
      const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data || '').slice(0, 200)}` : (err.message || String(err));
      console.error('[GD offline] failed:', detail);
      run = { state: 'error', mode: apply ? 'apply' : 'preview', started: run.started, finished: new Date().toISOString(), error: detail, query_id: id };
    }
  }

  app.post('/api/admin/gd/offline/start', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'An offline gift sync is already running.' });
    const id = queryId(req.body);
    if (!id) return res.status(400).json({ error: 'Enter the RE query ID for the offline gifts first.' });
    const apply = !!(req.body && req.body.apply);
    execute(apply, 'admin', id);
    res.status(202).json({ started: true });
  });
  const { backgroundAllowed } = require('./sky-instance');
  const scheduled = () => backgroundAllowed() && !!queryId({}) && String(process.env.GD_OFFLINE_SCHEDULE || 'on').toLowerCase() !== 'off' && process.env.SKIP_RE_RESOLUTION !== 'true';
  app.get('/api/admin/gd/offline/status', requireAdmin, (req, res) => res.json({ ...run, query_id: run.query_id || queryId({}), configured_id: queryId({}), schedule: scheduled(), alert }));

  // Automatic: 90 seconds after the server starts, then every 30 minutes (only when a query ID is set).
  const tick = () => { const id = queryId({}); if (scheduled() && run.state !== 'running') execute(true, 'automatic', id); };
  setTimeout(() => { tick(); setInterval(tick, 30 * 60 * 1000).unref(); }, 90 * 1000).unref();
};

module.exports._test = { mapHeaders, giftTime };
