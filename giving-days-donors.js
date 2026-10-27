// Giving Days personalization: random link codes, donor tags, and which challenges a donor counts toward.
// Tables: gd_donors (see sql/gd-05-donors.sql). Server-side access only.
// A personalized link is https://<site>/<6-character code>. Real pages always win over a code
// (this mounts last), and generated codes skip RESERVED.
// NOTE: if you add a page whose path is exactly 6 characters, add it to RESERVED.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';  // 31 characters: no 0/o, 1/i/l
const TOKEN_LEN = 6;
const TOKEN_RE = /^[a-hj-km-np-z2-9]{6}$/i;
const RESERVED = new Set(['admin', 'parent', 'giving', 'static']);

function makeToken() {
  for (;;) {
    let t = '';
    for (let i = 0; i < TOKEN_LEN; i++) t += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!RESERVED.has(t)) return t;
  }
}

// Tags a donor effectively has: import tags plus admin additions, minus admin removals.
function effectiveTags(d) {
  const removed = new Set(d.tags_removed || []);
  return [...new Set([...(d.import_tags || []), ...(d.tags_added || [])])].filter(t => !removed.has(t));
}

// Challenge rule (see sql/gd-03, gd-04): any tag AND any grade AND class-year range. Empty = no limit.
function qualifies(c, donor) {
  const tags = donor.tags || [], grades = donor.grades || [], year = donor.class_year;
  if ((c.tags || []).length && !c.tags.some(t => tags.includes(t))) return false;
  if ((c.grades || []).length && !c.grades.some(g => grades.includes(g))) return false;
  const lo = c.class_year_min, hi = c.class_year_max;
  if (lo != null || hi != null) {
    if (year == null) return false;
    if (lo != null && year < lo) return false;
    if (hi != null && year > hi) return false;
  }
  return true;
}

// Wrong-code guesses per visitor: 20 misses in 10 minutes and that visitor is paused.
const misses = new Map();
const MISS_LIMIT = 20, MISS_WINDOW_MS = 10 * 60 * 1000;
const visitorId = req => String((req.headers['x-forwarded-for'] || req.ip || '')).split(',')[0].trim();
function blocked(id) {
  const m = misses.get(id);
  if (!m) return false;
  if (Date.now() - m.start > MISS_WINDOW_MS) { misses.delete(id); return false; }
  return m.n >= MISS_LIMIT;
}
function recordMiss(id) {
  const m = misses.get(id);
  if (!m || Date.now() - m.start > MISS_WINDOW_MS) misses.set(id, { n: 1, start: Date.now() });
  else m.n++;
}

const safeJson = o => JSON.stringify(o).replace(/</g, '\\u003c');

module.exports = function mountGivingDaysDonors(app, { supabase, loadCampaign }) {
  const pageFile = path.join(__dirname, 'public', 'giving-days-v2.html');

  // The page file with the campaign (and, for a personal link, the visitor) written into it, so
  // the page needs no extra round trip. Nothing private goes in: first name, tags, grades, class year.
  async function renderPage(token) {
    let html = fs.readFileSync(pageFile, 'utf8');
    const data = {};
    try { data.campaign = await loadCampaign(); } catch (err) { console.error('giving-days page campaign:', err.message); }
    let known = false;
    if (token) {
      try {
        const { data: d, error } = await supabase.from('gd_donors')
          .select('first_name, class_year, grades, import_tags, tags_added, tags_removed').eq('token', token.toLowerCase()).maybeSingle();
        if (error) throw error;
        if (d) {
          known = true;
          const me = { first_name: d.first_name, tags: effectiveTags(d), grades: d.grades || [], class_year: d.class_year };
          me.qualifies = ((data.campaign && data.campaign.challenges) || []).filter(c => qualifies(c, me)).map(c => c.id);
          data.me = me;
        }
      } catch (err) { console.error('giving-days page donor:', err.message); }
    }
    html = html.replace('<!--GD_DATA-->', `<script>window.__GD = ${safeJson(data)};</script>`);
    return { html, known };
  }

  const send = (res, html) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); res.type('html').send(html); };

  // Preview of the public page; ?t=<code> previews a personalized visit.
  app.get('/preview-v2', async (req, res) => {
    const t = typeof req.query.t === 'string' && TOKEN_RE.test(req.query.t) ? req.query.t : null;
    send(res, (await renderPage(t)).html);
  });

  // Personal link: /<code>. Registered after every real page, so real pages win.
  app.get('/:code', async (req, res, next) => {
    if (!TOKEN_RE.test(req.params.code)) return next();
    const id = visitorId(req);
    if (blocked(id)) return res.status(429).type('text').send('Too many attempts. Please try again in a few minutes.');
    const { html, known } = await renderPage(req.params.code);
    if (!known) recordMiss(id);
    send(res, html);
  });
};

module.exports.makeToken = makeToken;
module.exports.effectiveTags = effectiveTags;
module.exports.qualifies = qualifies;
module.exports.TOKEN_RE = TOKEN_RE;
