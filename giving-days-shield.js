// Giving Days pre-launch "shield": until the campaign start time (gd_settings.starts_at) the public page is a
// teaser with the countdown and a Give button. Campaign content (goal, challenges, leaderboards, donor names,
// FAQ) is left out of the HTML and withheld from /api/gd/campaign, not just hidden.
// It lifts by itself at starts_at. Admins keep the full page through a signed cookie (see givePass / hasPass).
// OPT-IN: the shield only protects the public page when GD_SHIELD=on is set on Render. Without it, /preview and
// personal links show the full page (demo mode). /prelaunch always shows the teaser, so it can be demoed either way.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASS_COOKIE = 'gd_pass';
const PASS_TTL_MS = 12 * 60 * 60 * 1000;
let instance = null;

module.exports = function getShield(supabase) {
  if (instance) return instance;
  const secret = process.env.SUPABASE_SERVICE_KEY || process.env.SKY_CLIENT_SECRET || 'gd-local-dev';
  const sign = exp => crypto.createHmac('sha256', secret).update('gd-pass:' + exp).digest('hex');

  // Only the start time is cached; whether the shield is up is decided on every request.
  let cached = null, cachedAt = 0;
  async function startsAt() {
    if (cached && Date.now() - cachedAt < 15000) return cached;
    const { data, error } = await supabase.from('gd_settings').select('starts_at').eq('id', 1).single();
    if (error) throw error;
    cached = new Date(data.starts_at); cachedAt = Date.now();
    return cached;
  }

  const cookieOf = req => {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + PASS_COOKIE + '=([^;]+)'));
    return m ? m[1] : '';
  };
  function hasPass(req) {
    const [exp, sig] = cookieOf(req).split('.');
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const want = sign(exp);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
  function givePass(res) {
    const exp = String(Date.now() + PASS_TTL_MS);
    res.append('Set-Cookie', `${PASS_COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${PASS_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`);
  }

  // The launch time if this visitor should see the teaser, else null. A failure to read settings
  // falls on the safe side: keep the shield up rather than show the campaign early.
  async function activeFor(req, { force = false } = {}) {
    if (!force) {
      if (String(process.env.GD_SHIELD || '').toLowerCase() !== 'on') return null;
      if (hasPass(req)) return null;
    }
    let t;
    try { t = await startsAt(); } catch (err) { console.error('giving-days-shield:', err.message); return new Date('2026-11-30T05:00:00Z'); }
    return force || Date.now() < t.getTime() ? t : null;
  }

  const fragment = fs.readFileSync(path.join(__dirname, 'public', 'giving-days-shield.html'), 'utf8');
  function teaser(startsAt) {
    const label = startsAt.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
    return fragment.replace(/^<!--[\s\S]*?-->\s*/, '').replace(/\{\{STARTS_ISO\}\}/g, startsAt.toISOString()).replace(/\{\{STARTS_LABEL\}\}/g, label);
  }

  // The full page file turned into the teaser page: campaign markup and script swapped out.
  function apply(html, startsAt) {
    return html
      .replace(/<!--SHIELD:BODY-->[\s\S]*?<!--\/SHIELD:BODY-->/, () => teaser(startsAt))
      .replace(/\/\*SHIELD:CUT\*\/[\s\S]*?\/\*\/SHIELD:CUT\*\//, 'const C = [];')
      .replace('Pledges count toward every challenge.', 'Pledges are welcome and count as gifts.');
  }

  instance = { activeFor, apply, givePass, hasPass };
  return instance;
};
