// Giving Days: the RE gift import file. Online gifts made on the Giving Days page are not in Raiser's Edge yet, so the admin
// builds the import CSV (same layout as the parents campaign's "Export RE CSV"), staff import it in RE, then mark the gifts imported.
// Gifts that came FROM RE (transaction id "re-...") are never exported, and test gifts never are.
// Needs sql/gd-19-re-import.sql (gd_gifts.re_synced_at, gd_settings.re_import).

const DEFAULTS = {
  campaign: 'Unrest. Oper.',     // CampID
  fund: '2026-2027 Annual',      // FundID
  appeal: '',                    // GFAppeal (blank = none)
  ack_status: 'Not Acknowledged',// GFAck
  letter: 'Trinity Fund',        // GFLtrCode
  big_min: '',                   // gifts of at least this amount use big_letter instead (blank = off)
  big_letter: '',
};
const FIELDS = Object.keys(DEFAULTS);
const COLUMNS = ['ImportID', 'GiftID', 'donor_name', 'GFType', 'GFDate', 'GFTAmt', 'GFAnon', 'GFRef', 'CampID', 'FundID', 'GFAppeal', 'GFPayMeth',
  'GFCCType', 'GFCardholderName', 'GFAck', 'GFLtrCode', 'GFAttrImpID', 'GFAttrCat', 'GFAttrDesc', 'GFAttrDate'];

const toCSV = arr => arr.map(v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',');
const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: '2-digit' });
const cardType = raw => (String(raw || '').toLowerCase().replace(/\s+/g, '') === 'americanexpress' ? 'American Express' : String(raw || ''));
// Formula-looking text in a spreadsheet is a risk: a name starting with = + - @ is shown as plain text.
const safe = v => { const s = String(v == null ? '' : v); return /^[=+\-@]/.test(s) ? "'" + s : s; };

module.exports = function mountGivingDaysReExport(app, { supabase, requireAdmin, skyRequest }) {
  const fail = (res, err) => {
    console.error('giving-days-reexport:', err.message || err);
    const missing = err && (err.code === '42703' || /re_synced_at|re_import/.test(err.message || ''));
    res.status(500).json({ error: missing ? 'Run sql/gd-19-re-import.sql in Supabase first (it adds the columns this tool needs).' : 'Something went wrong. Please try again.' });
  };

  async function settings() {
    const { data, error } = await supabase.from('gd_settings').select('re_import').eq('id', 1).single();
    if (error && error.code !== '42703') throw error;
    return { ...DEFAULTS, ...((data && data.re_import) || {}) };
  }

  // Every real online gift, oldest first. "Online" = not one of the gifts imported from RE.
  async function onlineGifts() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('gd_gifts').select('*').eq('is_test', false).not('transaction_id', 'like', 're-%')
        .order('created_at').order('id').range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  app.get('/api/admin/gd/re-export/settings', requireAdmin, async (req, res) => {
    try { res.json({ settings: await settings(), defaults: DEFAULTS }); } catch (err) { fail(res, err); }
  });

  app.put('/api/admin/gd/re-export/settings', requireAdmin, async (req, res) => {
    const b = req.body || {}, next = {};
    for (const k of FIELDS) next[k] = typeof b[k] === 'string' ? b[k].trim().slice(0, 120) : '';
    if (next.big_min !== '' && !(Number(next.big_min) > 0)) return res.status(400).json({ error: 'The "at least" amount must be a number, or blank.' });
    if (next.big_min !== '' && !next.big_letter) return res.status(400).json({ error: 'Enter the letter code for the larger gifts, or clear the amount.' });
    try {
      const { error } = await supabase.from('gd_settings').update({ re_import: next }).eq('id', 1);
      if (error) throw error;
      res.json({ ok: true, settings: next });
    } catch (err) { fail(res, err); }
  });

  // How many online gifts are waiting for RE (for the toolbar), and how many of those have no RE ID to import against.
  app.get('/api/admin/gd/re-export/status', requireAdmin, async (req, res) => {
    try {
      const gifts = await onlineGifts();
      const waiting = gifts.filter(g => !g.re_synced_at);
      const ids = [...new Set(waiting.map(g => g.donor_id).filter(Boolean))];
      let noRe = waiting.filter(g => !g.donor_id).length;
      const re = new Map();
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('gd_donors').select('id, re_id').in('id', ids.slice(i, i + 200));
        if (error) throw error;
        (data || []).forEach(d => re.set(d.id, d.re_id));
      }
      noRe += waiting.filter(g => g.donor_id && !re.get(g.donor_id)).length;
      res.json({ waiting: waiting.length, waiting_total: waiting.reduce((t, g) => t + Number(g.amount), 0), no_re_id: noRe, imported: gifts.length - waiting.length });
    } catch (err) { fail(res, err); }
  });

  // The CSV. ?ids=a,b,c exports just those gifts (still only online, real ones); without it, every gift not yet marked imported.
  app.get('/api/admin/gd/re-export', requireAdmin, async (req, res) => {
    try {
      const want = typeof req.query.ids === 'string' && req.query.ids ? new Set(req.query.ids.split(',')) : null;
      const [all, cfg] = await Promise.all([onlineGifts(), settings()]);
      const seq = new Map(all.map((g, i) => [g.id, i + 1]));   // stable: a gift keeps its number whatever else is exported
      const gifts = all.filter(g => want ? want.has(g.id) : !g.re_synced_at);
      if (!gifts.length) return res.json({ empty: true, message: want ? 'None of the checked gifts can be exported (test gifts and gifts that came from RE are left out).' : 'No gifts waiting for RE.' });

      const donorIds = [...new Set(gifts.map(g => g.donor_id).filter(Boolean))], re = new Map();
      for (let i = 0; i < donorIds.length; i += 200) {
        const { data, error } = await supabase.from('gd_donors').select('id, re_id').in('id', donorIds.slice(i, i + 200));
        if (error) throw error;
        (data || []).forEach(d => re.set(d.id, d.re_id));
      }

      const rows = [toCSV(COLUMNS)];
      for (const g of gifts) {
        const full = [g.first_name, g.last_name].filter(Boolean).join(' ');
        let type = '', holder = full;
        try {
          const t = await skyRequest({ method: 'get', url: `https://api.sky.blackbaud.com/payments/v1/transactions/${encodeURIComponent(g.transaction_id)}`, timeout: 20000 }, process.env.BBMS_API_KEY);
          type = cardType(t.data && t.data.credit_card && t.data.credit_card.card_type);
          holder = (t.data && t.data.credit_card && t.data.credit_card.name) || full;
        } catch (e) { console.warn(`giving-days-reexport: card lookup failed for ${g.transaction_id}: ${e.response ? e.response.status : e.message}`); }
        const amt = Number(g.amount);
        const big = cfg.big_min !== '' && amt >= Number(cfg.big_min);
        rows.push(toCSV([
          re.get(g.donor_id) || '',
          `GDGIV-${String(seq.get(g.id)).padStart(4, '0')}`,
          safe(full), 'Cash', fmtDate(g.created_at), amt.toFixed(2), g.anonymous ? 'Y' : '', '',
          cfg.campaign, cfg.fund, cfg.appeal, 'Credit Card', type, safe(holder),
          cfg.ack_status, big ? cfg.big_letter : cfg.letter,
          '', 'BBMS Transaction ID', g.transaction_id, fmtDate(g.created_at),
        ]));
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="gd-re-gift-import-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(rows.join('\n'));
    } catch (err) { fail(res, err); }
  });

  // After the import in RE: stamp the checked gifts (ids) as imported, or clear the stamp (undo: true).
  app.post('/api/admin/gd/re-export/mark', requireAdmin, async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(i => typeof i === 'string').slice(0, 2000) : [];
    if (!ids.length) return res.status(400).json({ error: 'Check the gifts you imported first.' });
    try {
      const { data, error } = await supabase.from('gd_gifts').update({ re_synced_at: req.body.undo ? null : new Date().toISOString() })
        .in('id', ids).eq('is_test', false).not('transaction_id', 'like', 're-%').select('id');
      if (error) throw error;
      res.json({ count: (data || []).length });
    } catch (err) { fail(res, err); }
  });
};
