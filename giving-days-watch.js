// Security tripwires: email the developer (through giving-days-alert) the moment something suspicious happens, so nobody has to be
// reading the Render logs. Every function here is fire-and-forget and NEVER throws: a watcher must not break a request.
//
// What it watches
//   adminRefused      a valid login that is not on the ADMIN_EMAILS list tried an admin route
//   adminUnauthorized 10+ admin requests with no/invalid login from one IP within 5 minutes (probing)
//   adminData         10+ pulls of the big data lists (households, old gifts, all donors) from one IP within 10 minutes (scraping)
//   foreignReferer    our logo/fonts/config loaded from a site that is not ours (a copied page), once per new site
//   notConfigured     ADMIN_EMAILS is missing, so every admin request is being refused
//
// Limits so it cannot spam: the same alert kind is sent at most once per 30 minutes, and never more than 10 emails an hour.

const { alertStaff } = require('./giving-days-alert');

const SENSITIVE_RE = /^\/api\/admin\/(households|gifts|gd\/donors\/all)\/?$/i;
const COOLDOWN_MS = 30 * 60 * 1000;
const HOURLY_CAP = 10;

function makeWatch({ send = alertStaff, now = () => Date.now() } = {}) {
  const lastSent = new Map();     // alert key -> time last emailed
  let sentTimes = [];             // times of emails in the last hour
  const hits = new Map();         // "kind|ip" -> recent timestamps

  const ipOf = req => String((req.headers && req.headers['x-forwarded-for']) || req.ip || 'unknown').split(',')[0].trim().slice(0, 64);

  function notify(key, subject, lines) {
    try {
      const t = now();
      if (lastSent.has(key) && t - lastSent.get(key) < COOLDOWN_MS) return false;
      sentTimes = sentTimes.filter(x => t - x < 60 * 60 * 1000);
      if (sentTimes.length >= HOURLY_CAP) return false;
      lastSent.set(key, t); sentTimes.push(t);
      if (lastSent.size > 500) lastSent.clear();
      Promise.resolve(send('SECURITY: ' + subject, lines)).catch(() => {});
      return true;
    } catch (e) { return false; }
  }

  // true when this key has been hit `threshold` times inside `windowMs`
  function burst(kind, req, windowMs, threshold) {
    const k = kind + '|' + ipOf(req), t = now();
    const arr = (hits.get(k) || []).filter(x => t - x < windowMs);
    arr.push(t);
    hits.set(k, arr);
    if (hits.size > 2000) hits.clear();
    return arr.length >= threshold;
  }

  const where = req => `${req.method} ${req.path} from ${ipOf(req)}`;

  return {
    notify,
    adminRefused(req, user) {
      try {
        notify('refused:' + ipOf(req), 'admin login refused (not on the allowlist)', [
          `A signed-in user tried an admin route and was refused: ${where(req)}`,
          `Account: ${(user && user.email) || 'no email'} (id ${(user && user.id) || '?'}), email confirmed: ${!!(user && (user.email_confirmed_at || user.confirmed_at))}`,
          'If this is not one of your staff, someone created an account. Check Supabase > Authentication > Users and delete it; confirm sign-ups are still off.',
        ]);
      } catch (e) {}
    },
    adminUnauthorized(req) {
      try {
        if (burst('unauth', req, 5 * 60 * 1000, 10)) notify('unauth:' + ipOf(req), 'someone is probing the admin routes', [
          `10 or more admin requests without a valid login in 5 minutes. Latest: ${where(req)}`,
          'Probably an internet scanner (they get 401 and nothing else), but it is the same opening move as the 11/28 incident.',
        ]);
      } catch (e) {}
    },
    adminData(req) {
      try {
        if (SENSITIVE_RE.test(req.path || '') && burst('data', req, 10 * 60 * 1000, 10)) notify('data:' + ipOf(req), 'bulk pull of admin data lists', [
          `10 or more pulls of the households / gifts / donors lists in 10 minutes, with a valid login. Latest: ${where(req)}`,
          `Account: ${(req.user && req.user.email) || 'unknown'}`,
          'If this is not you, sign the account out (Supabase > Authentication > Users) and check the Render logs for this IP.',
        ]);
      } catch (e) {}
    },
    foreignReferer(host, path) {
      try {
        notify('ref:' + host, `our files are being loaded from another site (${host})`, [
          `${path} was requested with a Referer from ${host}, which is not one of our sites.`,
          'This is what a copied (look-alike) giving page looks like. Open that address, and if it is a fake, report it to the registrar and Google Safe Browsing and warn parents.',
        ]);
      } catch (e) {}
    },
    notConfigured() {
      try {
        notify('noadmin', 'ADMIN_EMAILS is not set: admin is locked', ['Every admin request is being refused because the ADMIN_EMAILS environment variable on Render is missing or empty.']);
      } catch (e) {}
    },
  };
}

module.exports = makeWatch();
module.exports.makeWatch = makeWatch;
