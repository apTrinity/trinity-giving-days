// Giving Days gifts: saving a gift when the form completes, and the admin's view and edits of gifts.
// Tables: gd_gifts (see sql/gd-06-gifts.sql). Server-side access only.
// Progress (which gifts count, challenge values) lives in giving-days-progress.js.

const { TAGS } = require('./giving-days-admin');
const { TOKEN_RE } = require('./giving-days-donors');
const { loadGifts, giftTags, countStatus, invalidate } = require('./giving-days-progress');

const TAG_KEYS = TAGS.map(t => t.key);
const GRADES = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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

module.exports = function mountGivingDaysGifts(app, { supabase, requireAdmin, skyRequest, isLive }) {
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
  app.post('/api/gd/gift', async (req, res) => {
    const b = req.body || {};
    const transaction_id = str(b.transaction_id, 120);
    const amount = Number(b.amount);
    const email = str(b.email, 200).toLowerCase();
    if (!transaction_id) return res.status(400).json({ error: 'transaction_id is required.' });
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
      return res.status(502).json({ error: 'Payment capture failed.' });
    }

    // Payment is captured from here on: a database failure must not turn into an error for the donor.
    const declared = fromAffiliations(b.affiliations);
    const row = {
      transaction_id, amount,
      first_name: str(b.first_name, 100) || null, last_name: str(b.last_name, 100) || null,
      email: email || null, anonymous: b.anonymous === true,
      is_test: !isLive(),
      declared_tags: declared.tags, grades: declared.grades, class_year: declared.class_year,
    };
    try {
      row.donor_id = await findDonor(typeof b.token === 'string' ? b.token : '', email);
      const { data, error } = await supabase.from('gd_gifts').insert(row).select('id').single();
      if (error) {
        if (error.code === '23505') {  // two requests for the same transaction: the first one won
          const { data: dup } = await supabase.from('gd_gifts').select('id').eq('transaction_id', transaction_id).maybeSingle();
          return res.json({ success: true, gift_id: dup && dup.id || null });
        }
        throw error;
      }
      invalidate();
      return res.json({ success: true, gift_id: data.id });
    } catch (err) {
      console.error('[GD] UNRECORDED GIFT (payment captured, database write failed):', JSON.stringify(row), err.message || err);
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
          is_test: g.is_test, excluded: g.excluded, has_donor: !!g.donor_id,
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
      const { error } = await supabase.from('gd_gifts').delete().eq('id', req.params.id);
      if (error) throw error;
      invalidate();
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
};

module.exports.fromAffiliations = fromAffiliations;
