// Giving Days gifts: saving a gift when the form completes, and the admin's view and edits of gifts.
// Tables: gd_gifts (see sql/gd-06-gifts.sql). Server-side access only.
// Progress (which gifts count, challenge values) lives in giving-days-progress.js.

const { TAGS } = require('./giving-days-admin');
const { TOKEN_RE, qualifies, cleanSource } = require('./giving-days-donors');
const { loadGifts, giftTags, countStatus, invalidate } = require('./giving-days-progress');
const { sendGiftEmails, sendUnrecordedGiftAlert, sendSystemAlert, buildPersonalization } = require('./giving-days-emails');

const TAG_KEYS = TAGS.map(t => t.key);
const GRADES = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const name = v => str(v, 100).replace(/[<>]/g, '');   // names are shown on the public donor wall; angle brackets are never part of a real name

// The tags, grades and class year a donor declared on the form. Form affiliations look like
// [{ type: 'alumni', class_year }, { type: 'current_parent', grade }, { type: 'faculty' }].
function fromAffiliations(list) {
  const tags = new Set(), grades = new Set();
  let year = null;
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || !TAG_KEYS.includes(a.type)) continue;
    tags.add(a.type);
    if (a.type === 'alumni' && Number.isInteger(a.class_year) && a.class_year >= 1900 && a.class_year <= 2100) year = a.class_year;
    if (a.type === 'current_parent' && GRADES.includes(String(a.grade))) grades.add(String(a.grade));
  }
  return { tags: [...tags], grades: GRADES.filter(g => grades.has(g)), class_year: year };
}

module.exports = function mountGivingDaysGifts(app, { supabase, requireAdmin, skyRequest, isLive, loadCampaign, audiences }) {
  const fail = (res, err, status = 500) => {
    console.error('giving-days-gifts:', err.message || err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
  };

  // The donor record a gift belongs to: the personal link it came through, else a matching email.
  async function findDonor(token, email) {
    if (token && TOKEN_RE.test(token)) {
      const { data } = await supabase.from('gd_donors').select('id').eq('token', token.toLowerCase()).maybeSingle();
      if (data) return data.id;
    }
    if (email) {
      const { data } = await supabase.from('gd_donors').select('id').ilike('email', email.replace(/[\\%_]/g, '\\$&')).limit(1);
      if (data && data.length) return data[0].id;
    }
    return null;
  }

  // Public: called by the gift form once Blackbaud Checkout reports success.
  // Captures the payment first (no money moves if that fails), then records the gift.
  // Generous per-address limit (a whole table of donors can share one school network); it stops scripts, not people.
  app.post('/api/gd/gift', require('./giving-days-ratelimit').limiter(60, 10 * 60 * 1000, 'Too many requests. Please wait a few minutes and try again.'), async (req, res) => {
    const b = req.body || {};
    const transaction_id = str(b.transaction_id, 120);
    const amount = Number(b.amount);
    const email = str(b.email, 200).toLowerCase();
    if (!transaction_id) return res.status(400).json({ error: 'transaction_id is required.' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transaction_id)) return res.status(400).json({ error: 'transaction_id is not valid.' });   // Blackbaud ids are UUIDs: do not spend a Blackbaud call on anything else
    if (!isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'amount must be between 0 and 1,000,000.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'email is not valid.' });

    try {
      const { data: already } = await supabase.from('gd_gifts').select('id').eq('transaction_id', transaction_id).maybeSingle();
      if (already) return res.json({ success: true, gift_id: already.id });
    } catch (err) { return fail(res, err); }

    try {
      const r = await skyRequest({
        method: 'post',
        url: `https://api.sky.blackbaud.com/payments/v1/transactions/${encodeURIComponent(transaction_id)}/capture`,
        data: { amount: Math.round(amount * 100) },
        headers: { 'Content-Type': 'application/json' },
      }, process.env.BBMS_API_KEY);
      console.log(`[GD] Payment captured: ${transaction_id} state: ${r.data && r.data.state || r.status}`);
    } catch (err) {
      console.error('[GD] BBMS capture failed:', err.response && err.response.status, JSON.stringify(err.response && err.response.data || err.message));
      // Tell the team right away (at most one email an hour): a donor just saw "could not confirm your gift".
      try {
        await sendSystemAlert('A gift payment could not be captured', `<p><strong>A donor's payment could not be completed on the Giving Days page.</strong> If this keeps happening, gifts are failing.</p><p>Amount: ${esc(String(amount))}<br>Transaction: <code>${esc(transaction_id)}</code><br>Reason: <code>${esc(String((err.response && err.response.data && (err.response.data.message || err.response.data.error)) || err.message || 'unknown').slice(0, 300))}</code></p><p>Check the Render logs for "[GD] BBMS capture failed". If it mentions re-authorization, restart the service on Render, or visit /auth/blackbaud on the live site.</p>`, 'capture');
      } catch (alertErr) { console.error('[GD] capture alert failed:', alertErr.message || alertErr); }
      return res.status(502).json({ error: 'Payment capture failed.' });
    }

    // Payment is captured from here on: a database failure must not turn into an error for the donor.
    const declared = fromAffiliations(b.affiliations);
    const row = {
      transaction_id, amount,
      first_name: name(b.first_name) || null, last_name: name(b.last_name) || null,
      email: email || null, anonymous: b.anonymous === true,
      is_test: !isLive(),
      declared_tags: declared.tags, grades: declared.grades, class_year: declared.class_year,
    };
    // "My employer matches gifts" from the form (columns from sql/gd-14-employer-match.sql).
    const match = b.employer_match === true ? { employer_match: true, employer: str(b.employer, 200) || null } : null;
    try {
      row.donor_id = await findDonor(typeof b.token === 'string' ? b.token : '', email);
      const source = cleanSource(b.source);
      const withSource = source ? { ...row, source } : row;
      let { data, error } = await supabase.from('gd_gifts').insert(match ? { ...withSource, ...match } : withSource).select('id').single();
      // Source and employer-match are optional columns (sql/gd-12 and gd-14). If one has not been added yet, record the gift without it rather than lose it.
      if (error && match && error.code === '42703') ({ data, error } = await supabase.from('gd_gifts').insert(withSource).select('id').single());
      if (error && source && error.code === '42703') ({ data, error } = await supabase.from('gd_gifts').insert(row).select('id').single());
      if (error) {
        if (error.code === '23505') {  // two requests for the same transaction: the first one won
          const { data: dup } = await supabase.from('gd_gifts').select('id').eq('transaction_id', transaction_id).maybeSingle();
          return res.json({ success: true, gift_id: dup && dup.id || null });
        }
        throw error;
      }
      invalidate();
      // Answer the page now so the counter can refresh right away; the receipt and staff note go out behind the response.
      res.json({ success: true, gift_id: data.id });
      // Receipt to the donor and a note to staff (test gifts go to Andrew only). Never blocks or fails the gift.
      try {
        let donor = null;
        if (row.donor_id) {
          const r = await supabase.from('gd_donors')
            .select('re_id, first_name, class_year, grades, ly_gift, import_tags, tags_added, tags_removed').eq('id', row.donor_id).maybeSingle();
          donor = r.data;
        }
        const gift = { ...row, ...(match || {}), id: data.id, created_at: new Date().toISOString() };
        // Personal touches: the donor's audience text (reunion, senior parents, ...), the challenges they count toward, where their class stands.
        let personal = null;
        try {
          const tags = giftTags({ ...gift, _donor: donor, tags_added: [], tags_removed: [] }).tags;
          const profile = {
            first_name: gift.first_name || (donor && donor.first_name) || '', tags,
            grades: [...new Set([...(gift.grades || []), ...((donor && donor.grades) || [])])],
            class_year: gift.class_year != null ? gift.class_year : donor ? donor.class_year : null,
            ly: donor && donor.ly_gift != null ? Number(donor.ly_gift) : null,
          };
          personal = buildPersonalization(gift, profile, {
            campaign: loadCampaign ? await loadCampaign() : null,
            audiences: audiences ? await audiences.loadPublished() : [],
            audienceFor: audiences && audiences.audienceFor, qualifies,
          });
        } catch (pErr) { console.error('[GD] email personalization skipped:', pErr.message || pErr); }
        await sendGiftEmails(gift, donor, personal);
      } catch (mailErr) { console.error('[GD] gift emails failed:', mailErr.message || mailErr); }
      return;
    } catch (err) {
      console.error('[GD] UNRECORDED GIFT (payment captured, database write failed):', JSON.stringify(row), err.message || err);
      try { await sendUnrecordedGiftAlert({ ...row, ...(match || {}), created_at: new Date().toISOString() }); } catch (mailErr) { console.error('[GD] alert email failed:', mailErr.message || mailErr); }
      return res.json({ success: true, gift_id: null });
    }
  });

  // Admin: every gift with its effective tags (and where each came from) and whether it counts.
  app.get('/api/admin/gd/gifts', requireAdmin, async (req, res) => {
    try {
      const [gifts, s] = await Promise.all([
        loadGifts(supabase),
        supabase.from('gd_settings').select('starts_at, ends_at, gifts_count_from, test_gifts_count').eq('id', 1).single(),
      ]);
      if (s.error) throw s.error;
      const out = gifts.reverse().map(g => {
        const t = giftTags(g);
        return {
          id: g.id, created_at: g.created_at, amount: Number(g.amount),
          first_name: g.first_name, last_name: g.last_name, email: g.email, anonymous: g.anonymous,
          is_test: g.is_test, excluded: g.excluded, has_donor: !!g.donor_id, source: g.source || null,
          class_year: g.class_year != null ? g.class_year : g._donor ? g._donor.class_year : null,
          grades: g.grades, tags: t.tags, tag_sources: t.sources,
          status: countStatus(g, s.data),
        };
      });
      const counted = out.filter(g => g.status === 'counts');
      const people = new Set(counted.map(g => g.email ? g.email.toLowerCase() : g.id));
      res.json({
        gifts: out, tags: TAGS,
        summary: {
          total: out.length, counted: counted.length, donors: people.size,
          raised: counted.reduce((t, g) => t + g.amount, 0),
          test: out.filter(g => g.is_test).length,
        },
      });
    } catch (err) { fail(res, err); }
  });

  // Admin: gifts that were not tied to a donor record (the donor used an email we do not have), each with the
  // donor records that look like the same person: same last name, best first-name match first.
  // Registered before the /gifts/:id routes so "unlinked" is not read as an id.
  app.get('/api/admin/gd/gifts/unlinked', requireAdmin, async (req, res) => {
    try {
      const { data: gifts, error } = await supabase.from('gd_gifts')
        .select('id, created_at, amount, first_name, last_name, email, is_test, excluded, anonymous')
        .is('donor_id', null).order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      const byLast = new Map();
      const lasts = [...new Set((gifts || []).map(g => (g.last_name || '').trim().toLowerCase()).filter(Boolean))];
      for (const ln of lasts) {
        const { data } = await supabase.from('gd_donors').select('id, first_name, last_name, email, re_id, class_year')
          .ilike('last_name', ln.replace(/[\\%_]/g, '\\$&')).limit(25);
        byLast.set(ln, data || []);
      }
      const norm = v => (v || '').trim().toLowerCase();
      const out = (gifts || []).map(g => {
        const f = norm(g.first_name);
        const cands = (byLast.get(norm(g.last_name)) || []).map(d => {
          const df = norm(d.first_name);
          const score = f && df === f ? 3 : f && df && (df.startsWith(f) || f.startsWith(df)) ? 2 : f && df && df[0] === f[0] ? 1 : 0;
          return { id: d.id, first_name: d.first_name || '', last_name: d.last_name || '', email: d.email || '', re_id: d.re_id, class_year: d.class_year, score };
        }).sort((a, b) => b.score - a.score).slice(0, 5);
        return { ...g, amount: Number(g.amount), suggestions: cands };
      });
      res.json({ gifts: out });
    } catch (err) { fail(res, err); }
  });

  // Admin: tie a gift to a donor record (or, with donor_id null, undo that). The donor's tags then apply to the gift.
  app.put('/api/admin/gd/gifts/:id/link', requireAdmin, async (req, res) => {
    const donorId = req.body && req.body.donor_id;
    try {
      if (donorId != null) {
        const { data: d, error: de } = await supabase.from('gd_donors').select('id').eq('id', donorId).maybeSingle();
        if (de) throw de;
        if (!d) return res.status(404).json({ error: 'Donor not found.' });
      }
      const { data, error } = await supabase.from('gd_gifts').update({ donor_id: donorId == null ? null : donorId, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'Gift not found.' });
      invalidate();
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // Admin: per link tag, how many times the page was opened, how many gifts followed and what they raised.
  // Counts only gifts that count toward progress (real, in the window, not excluded).
  app.get('/api/admin/gd/sources', requireAdmin, async (req, res) => {
    try {
      const [gifts, s, v] = await Promise.all([
        loadGifts(supabase),
        supabase.from('gd_settings').select('starts_at, ends_at, gifts_count_from, test_gifts_count').eq('id', 1).single(),
        supabase.from('gd_visits').select('source'),
      ]);
      if (s.error) throw s.error;
      if (v.error && v.error.code !== '42P01') throw v.error;   // 42P01: gd-12 not run yet
      const by = {};
      const row = k => (by[k] = by[k] || { source: k, visits: 0, gifts: 0, raised: 0, test_gifts: 0 });
      for (const r of (v.data || [])) row(r.source).visits++;
      for (const g of gifts) {
        if (!g.source) continue;
        if (g.is_test) { row(g.source).test_gifts++; continue; }
        if (countStatus(g, s.data) !== 'counts') continue;
        const r = row(g.source); r.gifts++; r.raised += Number(g.amount);
      }
      const sources = Object.values(by).map(r => ({ ...r, conversion: r.visits ? r.gifts / r.visits : null }))
        .sort((a, b) => b.raised - a.raised || b.visits - a.visits);
      res.json({ sources, ready: !v.error });
    } catch (err) { fail(res, err); }
  });

  // Admin: fix a gift. `tags` is the full list the gift should end up with; the server works out what was
  // added or removed compared with what the form and the donor record say. Also class year and exclude.
  app.put('/api/admin/gd/gifts/:id', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(b, 'excluded')) patch.excluded = b.excluded === true;
    if (Object.prototype.hasOwnProperty.call(b, 'class_year')) {
      if (b.class_year === null || b.class_year === '') patch.class_year = null;
      else {
        const y = Number(b.class_year);
        if (!Number.isInteger(y) || y < 1900 || y > 2100) return res.status(400).json({ error: 'Class year must be a four-digit year, like 2015.' });
        patch.class_year = y;
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, 'tags')) {
      if (!Array.isArray(b.tags)) return res.status(400).json({ error: 'tags must be a list.' });
      const bad = b.tags.find(t => !TAG_KEYS.includes(t));
      if (bad !== undefined) return res.status(400).json({ error: `Unknown affiliation "${bad}".` });
    }
    if (!Object.keys(patch).length && !Array.isArray(b.tags)) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      const { data: g, error: ge } = await supabase.from('gd_gifts').select('*').eq('id', req.params.id).maybeSingle();
      if (ge) throw ge;
      if (!g) return res.status(404).json({ error: 'Gift not found.' });
      if (Array.isArray(b.tags)) {
        let donor = null;
        if (g.donor_id) {
          const r = await supabase.from('gd_donors').select('import_tags, tags_added, tags_removed').eq('id', g.donor_id).maybeSingle();
          donor = r.data;
        }
        const base = new Set(giftTags({ ...g, tags_added: [], tags_removed: [], _donor: donor }).tags);
        const want = new Set(b.tags);
        patch.tags_added = [...want].filter(t => !base.has(t));
        patch.tags_removed = [...base].filter(t => !want.has(t));
      }
      const { error } = await supabase.from('gd_gifts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', g.id);
      if (error) throw error;
      invalidate();
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // Admin: delete test gifts (all of them), or one gift. Real gifts are only ever excluded, never deleted here in bulk.
  app.delete('/api/admin/gd/test-gifts', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('gd_gifts').delete().eq('is_test', true).select('id');
      if (error) throw error;
      invalidate();
      res.json({ ok: true, deleted: (data || []).length });
    } catch (err) { fail(res, err); }
  });

  app.delete('/api/admin/gd/gifts/:id', requireAdmin, async (req, res) => {
    try {
      const { data: g, error: readErr } = await supabase.from('gd_gifts').select('is_test').eq('id', req.params.id).maybeSingle();
      if (readErr) throw readErr;
      if (!g) return res.status(404).json({ error: 'Gift not found.' });
      // A real gift has money behind it in Blackbaud (or RE). Deleting the record would leave a charged donor with no gift here,
      // and an offline gift would simply be re-imported. Use Edit > "Don't count this gift" instead.
      if (!g.is_test) return res.status(400).json({ error: "Real gifts can't be deleted. Open the gift with Edit and choose not to count it: the record stays, and it is left out of the totals." });
      const { error } = await supabase.from('gd_gifts').delete().eq('id', req.params.id);
      if (error) throw error;
      invalidate();
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
};

module.exports.fromAffiliations = fromAffiliations;
