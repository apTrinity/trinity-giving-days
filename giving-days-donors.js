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

// Who-counts rule for challenges and audiences (see sql/gd-03, gd-04, gd-07): any tag AND any grade AND
// class-year range AND (if given) one of the specific class years. Empty = no limit.
function qualifies(c, donor) {
  const tags = donor.tags || [], grades = donor.grades || [], year = donor.class_year;
  if ((c.tags || []).length && !c.tags.some(t => tags.includes(t))) return false;
  if ((c.grades || []).length && !c.grades.some(g => grades.includes(g))) return false;
  if ((c.class_years || []).length && (year == null || !c.class_years.includes(year))) return false;
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

// A link tag from ?src=, for telling QR codes, emails and posts apart. Letters, digits, dash and underscore only.
const SRC_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const cleanSource = v => { const s = typeof v === 'string' ? v.trim().toLowerCase() : ''; return SRC_RE.test(s) ? s : null; };
const BOT_RE = /bot|crawl|spider|slurp|preview|scan|monitor|facebookexternalhit|curl|wget|python|headless/i;

const TAG_KEYS = ['alumni', 'current_parent', 'parent_of_alumni', 'faculty', 'grandparent', 'friend', 'new_family', 'alumna'];
const GRADE_KEYS = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

// A made-up visitor for demos, from /preview?p=<base64url JSON>. Validated field by field; never touches real data.
function demoPersona(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let p;
  try { p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  const year = Number(p.class_year), ly = Number(p.ly);
  return {
    first_name: typeof p.first_name === 'string' ? p.first_name.trim().slice(0, 40) : '',
    tags: (Array.isArray(p.tags) ? p.tags : []).filter(t => TAG_KEYS.includes(t)),
    grades: (Array.isArray(p.grades) ? p.grades.map(String) : []).filter(g => GRADE_KEYS.includes(g)),
    class_year: Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null,
    ly: isFinite(ly) && ly > 0 && ly <= 10000000 ? Math.round(ly) : null,
  };
}

module.exports = function mountGivingDaysDonors(app, { supabase, loadCampaign, audiences }) {
  const shield = require('./giving-days-shield')(supabase);
  const pageFile = path.join(__dirname, 'public', 'giving-days-v2.html');

  // The page file with the campaign (and, for a personal link, the visitor) written into it, so
  // the page needs no extra round trip. For a personal link this includes the name and email, so the gift form can
  // skip those fields (it shows the email masked), as the parents page does. Made-up demo donors have none.
  // Before launch (the shield, see giving-days-shield.js) the page is a teaser: no campaign data, no audience copy.
  async function renderPage(req, token, persona, opts) {
    let html = fs.readFileSync(pageFile, 'utf8');
    const shieldAt = await shield.activeFor(req, opts);
    if (shieldAt) persona = null;
    const data = {};
    if (!shieldAt) { try { data.campaign = await loadCampaign(); } catch (err) { console.error('giving-days page campaign:', err.message); } }
    let known = false;
    let auds = [];
    if (audiences && !shieldAt) { try { auds = await audiences.loadPublished(); } catch (err) { console.error('giving-days page audiences:', err.message); } }
    const finish = me => {
      me.qualifies = ((data.campaign && data.campaign.challenges) || []).filter(c => qualifies(c, me)).map(c => c.id);
      me.audience = audiences ? audiences.audienceFor(auds, me, qualifies) : null;
      data.me = me;
    };
    if (persona) {
      finish({ ...persona, demo: true });
      data.demo = true;
    } else if (token) {
      try {
        const { data: d, error } = await supabase.from('gd_donors')
          .select('first_name, last_name, email, class_year, grades, ly_gift, ask_a, ask_b, import_tags, tags_added, tags_removed').eq('token', token.toLowerCase()).maybeSingle();
        if (error) throw error;
        if (d) {
          known = true;
          finish({ first_name: d.first_name, last_name: d.last_name || '', email: d.email || '', tags: effectiveTags(d), grades: d.grades || [], class_year: d.class_year, ly: d.ly_gift != null ? Number(d.ly_gift) : null,
            ask_a: d.ask_a != null ? Number(d.ask_a) : null, ask_b: d.ask_b != null ? Number(d.ask_b) : null });
          data.token = token.toLowerCase();  // the visitor's own code, sent back with their gift so it is linked to their record
        }
      } catch (err) { console.error('giving-days page donor:', err.message); }
    }
    // Link tag (?src=): sent back with any gift, and the visit counted. Not for demos, admins or obvious bots.
    const src = cleanSource(req.query && req.query.src);
    if (src) {
      data.src = src;
      if (!persona && !(shield.hasPass && shield.hasPass(req)) && !BOT_RE.test(req.headers['user-agent'] || '')) {
        Promise.resolve(supabase.from('gd_visits').insert({ source: src })).then(r => { if (r && r.error) console.error('giving-days visit:', r.error.message); }, err => console.error('giving-days visit:', err.message));
      }
    }
    html = html.replace('<!--GD_DATA-->', `<script>window.__GD = ${safeJson(data)};</script>`);
    if (shieldAt) html = shield.apply(html, shieldAt);
    return { html, known };
  }

  const send = (res, html) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); res.type('html').send(html); };

  // Old shared address: send it to /preview, keeping a personal-link code if there is one.
  app.get('/preview-v2', (req, res) => {
    const q = new URLSearchParams();
    if (typeof req.query.t === 'string' && TOKEN_RE.test(req.query.t)) q.set('t', req.query.t);
    if (typeof req.query.p === 'string') q.set('p', req.query.p);
    res.redirect(302, '/preview' + (q.toString() ? '?' + q : ''));
  });

  // The public page; /preview?t=<code> previews a personalized visit.
  app.get('/preview', async (req, res) => {
    const t = typeof req.query.t === 'string' && TOKEN_RE.test(req.query.t) ? req.query.t : null;
    send(res, (await renderPage(req, t, demoPersona(req.query.p))).html);
  });

  // The pre-launch teaser with no Give buttons and no test-mode banner (for screenshots, designers and the public front door).
  const cleanTeaser = html => html
    .replace('</head>', '<style>#hero-give,#test-flag,.sticky-give,.btn-give{display:none!important}</style></head>')
    .replace(' You can make your gift now.', '');

  // Demo of the pre-launch teaser, shown whether or not the shield is switched on. ?clean=1: no Give buttons or test banner.
  app.get('/prelaunch', async (req, res) => {
    const html = (await renderPage(req, null, null, { force: true })).html;
    send(res, req.query.clean === '1' ? cleanTeaser(html) : html);
  });

  // The front door, giving.trinityschoolnyc.org: the clean teaser until the launch time, then the Giving Days page.
  // Link tags work here: giving.trinityschoolnyc.org/?src=qr-flyer
  app.get('/', async (req, res) => {
    const shieldAt = await shield.activeFor(req, { untilLaunch: true });
    const html = (await renderPage(req, null, null, { untilLaunch: true })).html;
    send(res, shieldAt ? cleanTeaser(html) : html);
  });

  // Personal link: /<code>. Registered after every real page, so real pages win.
  app.get('/:code', async (req, res, next) => {
    if (!TOKEN_RE.test(req.params.code)) return next();
    const id = visitorId(req);
    if (blocked(id)) return res.status(429).type('text').send('Too many attempts. Please try again in a few minutes.');
    const { html, known } = await renderPage(req, req.params.code);
    if (!known) recordMiss(id);
    send(res, html);
  });
};

module.exports.makeToken = makeToken;
module.exports.effectiveTags = effectiveTags;
module.exports.qualifies = qualifies;
module.exports.TOKEN_RE = TOKEN_RE;
module.exports.cleanSource = cleanSource;
module.exports.demoPersona = demoPersona;
