// ─────────────────────────────────────────────────────────────────────────────
// Trinity Giving Days — Server
// ─────────────────────────────────────────────────────────────────────────────
// Route map:
//   GET  /                        → serves the giving day HTML page
//   POST /api/lookup              → searches RE NXT for a constituent by email
//   POST /api/gift                → BBMS capture, writes gift + affiliations to Supabase
//   GET  /api/leaderboard         → alumni + parent leaderboard, stats, recent gifts
//   GET  /api/parents/leaderboard → parent-only leaderboard (parentsSupabase)
//   POST /api/parents/gift        → BBMS capture, writes to parentsSupabase
//   GET  /api/health              → Supabase connection check
//   GET  /api/sync-offline        → manual trigger for offline gift sync
//   GET  /auth/blackbaud          → starts the SKY API OAuth flow (one-time browser visit)
//   GET  /auth/blackbaud/callback → receives the OAuth code and exchanges it for tokens
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express      = require('express');
const axios        = require('axios');
const path         = require('path');
const { Resend }   = require('resend');
const { createClient } = require('@supabase/supabase-js');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function gradeLabel(grade) {
  if (!grade) return '—';
  if (grade === 'K') return 'Kindergarten';
  const n = parseInt(grade);
  const sfx = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${sfx} Grade`;
}

// ─── Confirmation email ───────────────────────────────────────────────────────
async function sendConfirmationEmail(gift, affiliations) {
  if (!resend || !gift.email) return false;

  const affLabels = (affiliations || []).map(a => {
    if (a.type === 'alumni'          && a.class_year) return `Alumni, Class of ${a.class_year}`;
    if ((a.type === 'current_parent' || a.type === 'parents') && a.grade) return `${gradeLabel(a.grade)} Parent`;
    if (a.type === 'parent_of_alumni') return 'Parent of Alumni';
    if (a.type === 'faculty')          return 'Faculty / Staff';
    if (a.type === 'grandparent')      return 'Grandparent';
    if (a.type === 'friend')           return 'Friend of Trinity';
    return null;
  }).filter(Boolean).join(', ');

  const amountFormatted = '$' + parseFloat(gift.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const { error } = await resend.emails.send({
    from: 'Trinity Fund <trinityfund@trinityschoolnyc.org>',
    to:   gift.email,
    subject: 'Thank you for your gift to Trinity School',
    html: `
      <div style="max-width:600px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#222;background:#fff;">

        <!-- Header -->
        <div style="padding:24px 32px 20px;border-bottom:1px solid #ddd;">
          <img src="https://givecampus.s3-accelerate.amazonaws.com/uploads/project/share_image/72106/facebook_small_trinity_giving_days_2025_logo.png"
               alt="Trinity School" width="180" style="display:block;" />
        </div>

        <!-- Body -->
        <div style="padding:28px 32px 8px;font-size:15px;line-height:1.7;">
          <p style="margin:0 0 16px;">Dear ${gift.first_name},</p>
          <p style="margin:0 0 16px;">Thank you for your gift of <strong>${amountFormatted}</strong> to the 2025-2026 Trinity Fund during Trinity Giving Days 2026. Your generosity means a great deal to our school and helps us continue to provide the very best education for our students.</p>
          <p style="margin:0 0 16px;">Should you have any questions or need assistance regarding your gift, please don't hesitate to contact us at <a href="mailto:trinityfund@trinityschoolnyc.org" style="color:#1C2D5E;">trinityfund@trinityschoolnyc.org</a>.</p>
          <p style="margin:0 0 16px;">Again, thank you so much for your support.</p>
          <p style="margin:0 0 4px;">Gratefully,</p>
          <p style="margin:0 0 28px;">Myles, Ed, Francie, Abigail, Li-An, Migdalia, Philip, Sarah and Andrew<br>Trinity School Advancement Office</p>
        </div>

        <!-- Divider -->
        <div style="border-top:1px solid #ddd;margin:0 32px;"></div>

        <!-- Matching gifts -->
        <div style="padding:20px 32px;font-size:15px;line-height:1.7;">
          <p style="margin:0 0 8px;"><strong><em>DOUBLE THE IMPACT OF YOUR SUPPORT!</em></strong></p>
          <p style="margin:0 0 8px;">Did you know that many companies match employee donations to Trinity?</p>
          <p style="margin:0;"><a href="https://www.trinityschoolnyc.org/support-trinity/matching-gifts" style="color:#1C2D5E;">CLICK HERE to find out if your employer participates and what the next steps would be.</a></p>
        </div>

        <!-- Divider -->
        <div style="border-top:1px solid #ddd;margin:0 32px;"></div>

        <!-- Transaction details -->
        <div style="padding:20px 32px 32px;font-size:13px;color:#555;">
          <table cellpadding="5" style="border-collapse:collapse;">
            <tr><td style="padding-right:20px;">Amount</td><td><strong style="color:#222;">${amountFormatted}</strong></td></tr>
            <tr><td style="padding-right:20px;">Fund</td><td style="color:#222;">${gift.fund}</td></tr>
            ${affLabels ? `<tr><td style="padding-right:20px;">Credited to</td><td style="color:#222;">${affLabels}</td></tr>` : ''}
            <tr><td style="padding-right:20px;">Transaction ID</td><td style="font-family:monospace;font-size:11px;color:#222;">${gift.transaction_id}</td></tr>
          </table>
        </div>

      </div>
    `,
  });

  if (error) { console.error('Resend error:', error); return false; }
  console.log(`Confirmation email sent to ${gift.email}`);
  return true;
}

// ─── Staff notification email ─────────────────────────────────────────────────
const STAFF_EMAILS = [
  'andrew.peterson@trinityschoolnyc.org',
];

async function sendStaffNotification(gift, affiliations) {
  if (!resend) return false;

  const amountFormatted = '$' + parseFloat(gift.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const affilRows = (affiliations || []).map(a => {
    if (a.type === 'alumni'          && a.class_year) return `Alumni — Class of ${a.class_year}`;
    if ((a.type === 'current_parent' || a.type === 'parents') && a.grade)       return `Current Parent — ${gradeLabel(a.grade)}`;
    if ((a.type === 'current_parent' || a.type === 'parents') && a.class_year)  return `Current Parent — Class of '${String(a.class_year).slice(-2)}`;
    if (a.type === 'current_parent' || a.type === 'parents') return 'Current Parent';
    if (a.type === 'parent_of_alumni') return 'Parent of Alumni';
    if (a.type === 'grandparent')      return 'Grandparent';
    if (a.type === 'faculty')          return 'Faculty / Staff';
    if (a.type === 'friend')           return 'Friend of Trinity';
    return a.type;
  }).filter(Boolean);

  const { error } = await resend.emails.send({
    from:    'Trinity Fund <trinityfund@trinityschoolnyc.org>',
    to:      STAFF_EMAILS,
    subject: `[Giving Days] ${amountFormatted} — ${gift.first_name} ${gift.last_name}`,
    html: `
      <div style="max-width:560px;margin:0 auto;font-family:Arial,sans-serif;font-size:14px;color:#222;">
        <div style="background:#1C2D5E;color:#fff;padding:16px 24px;border-bottom:3px solid #B8922A;">
          <strong style="font-size:16px;">New Gift — Trinity Giving Days 2026</strong>
        </div>
        <div style="padding:20px 24px;">
          <table cellpadding="7" style="border-collapse:collapse;width:100%;">
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;width:130px;">Donor</td>
              <td><strong>${gift.first_name} ${gift.last_name}</strong></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Email</td>
              <td>${gift.email || '—'}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Amount</td>
              <td><strong>${amountFormatted}</strong></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Fund</td>
              <td>${gift.fund}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Affiliation(s)</td>
              <td>${affilRows.length > 0 ? affilRows.join('<br>') : '—'}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Date</td>
              <td>${new Date(gift.created_at).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}</td>
            </tr>
            <tr>
              <td style="color:#666;">Transaction ID</td>
              <td style="font-family:monospace;font-size:12px;">${gift.transaction_id}</td>
            </tr>
          </table>
        </div>
      </div>
    `,
  });

  if (error) { console.error('Staff notification error:', error); return false; }
  console.log(`Staff notification sent for gift ${gift.id}`);
  return true;
}

// ─── Parents: confirmation email ─────────────────────────────────────────────
async function sendParentsConfirmationEmail(gift, affiliations) {
  if (!resend || !gift.email) return false;

  const amountFormatted = '$' + parseFloat(gift.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const gradeLabels = (affiliations || [])
    .filter(a => a.affiliation_type === 'current_parent' && a.grade)
    .map(a => gradeLabel(a.grade))
    .filter(Boolean);
  const gradeStr = gradeLabels.length > 0 ? gradeLabels.join(' and ') + ' family' : 'Trinity parent family';

  const { error } = await resend.emails.send({
    from: 'Trinity Fund <trinityfund@trinityschoolnyc.org>',
    to:   gift.email,
    subject: 'Thank you for your gift to the Trinity Fund',
    html: `
      <div style="max-width:600px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#222;background:#fff;">

        <!-- Header -->
        <div style="background:#172853;padding:24px 32px 20px;border-bottom:3px solid #F2CC07;">
          <img src="https://givecampus.s3-accelerate.amazonaws.com/uploads/project/share_image/72106/facebook_small_trinity_giving_days_2025_logo.png"
               alt="Trinity Fund 2025–2026" width="180" style="display:block;" />
        </div>

        <!-- Body -->
        <div style="padding:28px 32px 8px;font-size:15px;line-height:1.7;">
          <p style="margin:0 0 16px;">Dear ${gift.first_name},</p>
          <p style="margin:0 0 16px;">Thank you for your gift of <strong>${amountFormatted}</strong> to the 2025–2026 Trinity Fund. Your participation as a ${gradeStr} helps strengthen our entire school community — and moves your grade up the leaderboard.</p>
          <p style="margin:0 0 16px;">Every family that gives, at any level, counts toward our goal of 100% parent participation. We are grateful to have you with us.</p>
          <p style="margin:0 0 16px;">If you have any questions about your gift, please contact us at <a href="mailto:trinityfund@trinityschoolnyc.org" style="color:#1C2D5E;">trinityfund@trinityschoolnyc.org</a>.</p>
          <p style="margin:0 0 4px;">With gratitude,</p>
          <p style="margin:0 0 28px;">Myles, Ed, Francie, Abigail, Li-An, Migdalia, Philip, Sarah and Andrew<br>Trinity School Advancement Office</p>
        </div>

        <!-- Divider -->
        <div style="border-top:1px solid #ddd;margin:0 32px;"></div>

        <!-- Matching gifts -->
        <div style="padding:20px 32px;background:#F9F7F2;border-left:4px solid #F2CC07;">
          <p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#172853;">Double your impact with a matching gift.</p>
          <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#444;">Many companies match employee donations to schools like Trinity — meaning your gift could be worth twice as much at no extra cost to you.</p>
          <a href="https://www.trinityschoolnyc.org/support-trinity/matching-gifts" style="display:inline-block;background:#172853;color:#F2CC07;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.05em;text-transform:uppercase;padding:10px 20px;text-decoration:none;">Check if your employer matches →</a>
        </div>

        <!-- Divider -->
        <div style="border-top:1px solid #ddd;margin:0 32px;"></div>

        <!-- Transaction details -->
        <div style="padding:20px 32px 32px;font-size:13px;color:#555;">
          <table cellpadding="5" style="border-collapse:collapse;">
            <tr><td style="padding-right:20px;">Amount</td><td><strong style="color:#222;">${amountFormatted}</strong></td></tr>
            <tr><td style="padding-right:20px;">Fund</td><td style="color:#222;">${gift.fund}</td></tr>
            ${gradeLabels.length > 0 ? `<tr><td style="padding-right:20px;">Credited to</td><td style="color:#222;">${gradeLabels.join(', ')} Parent</td></tr>` : ''}
            <tr><td style="padding-right:20px;">Transaction ID</td><td style="font-family:monospace;font-size:11px;color:#222;">${gift.transaction_id}</td></tr>
          </table>
        </div>

      </div>
    `,
  });

  if (error) { console.error('[Parents] Resend error:', error); return false; }
  console.log(`[Parents] Confirmation email sent to ${gift.email}`);
  return true;
}

// ─── Parents: staff notification email ───────────────────────────────────────
const PARENTS_STAFF_EMAILS = [
  'andrew.peterson@trinityschoolnyc.org',
];

async function sendParentsStaffNotification(gift, affiliations) {
  if (!resend) return false;

  const amountFormatted = '$' + parseFloat(gift.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const gradeRows = (affiliations || [])
    .filter(a => a.affiliation_type === 'current_parent' && a.grade)
    .map(a => gradeLabel(a.grade) + ' Parent');
  const gradeStr = gradeRows.length > 0 ? gradeRows.join(', ') : 'Current Parent';

  const { error } = await resend.emails.send({
    from:    'Trinity Fund <trinityfund@trinityschoolnyc.org>',
    to:      PARENTS_STAFF_EMAILS,
    subject: `[Parents] ${amountFormatted} — ${gift.first_name} ${gift.last_name}`,
    html: `
      <div style="max-width:560px;margin:0 auto;font-family:Arial,sans-serif;font-size:14px;color:#222;">
        <div style="background:#172853;color:#fff;padding:16px 24px;border-bottom:3px solid #F2CC07;">
          <strong style="font-size:16px;">New Gift — Parents Campaign 2025–2026</strong>
        </div>
        <div style="padding:20px 24px;">
          <table cellpadding="7" style="border-collapse:collapse;width:100%;">
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;width:130px;">Donor</td>
              <td><strong>${gift.first_name} ${gift.last_name}</strong></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Email</td>
              <td>${gift.email || '—'}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Amount</td>
              <td><strong>${amountFormatted}</strong></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Grade(s)</td>
              <td>${gradeStr}</td>
            </tr>
            ${gift.household_import_id ? `<tr style="border-bottom:1px solid #eee;"><td style="color:#666;">Household ID</td><td style="font-family:monospace;font-size:12px;">${gift.household_import_id}</td></tr>` : ''}
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Date</td>
              <td>${new Date(gift.created_at).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}</td>
            </tr>
            <tr>
              <td style="color:#666;">Transaction ID</td>
              <td style="font-family:monospace;font-size:12px;">${gift.transaction_id}</td>
            </tr>
          </table>
        </div>
      </div>
    `,
  });

  if (error) { console.error('[Parents] Staff notification error:', error); return false; }
  console.log(`[Parents] Staff notification sent for gift ${gift.id}`);
  return true;
}

// ─── Parents emergency notification (Supabase down after payment captured) ───
async function sendParentsEmergencyNotification(gift, rawAffiliations) {
  if (!resend) return false;

  const amountFormatted = '$' + parseFloat(gift.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const gradeStr = (rawAffiliations || [])
    .filter(a => (a.type || a.affiliation_type) === 'current_parent' && a.grade)
    .map(a => gradeLabel(a.grade))
    .join(', ') || 'Unknown — check transaction in BBMS';

  const payload = JSON.stringify({
    transaction_id:     gift.transaction_id,
    amount:             gift.amount,
    first_name:         gift.first_name,
    last_name:          gift.last_name,
    email:              gift.email,
    fund:               gift.fund,
    household_import_id: gift.household_import_id || null,
    affiliations:       rawAffiliations,
  }, null, 2);

  const { error } = await resend.emails.send({
    from:    'Trinity Fund <trinityfund@trinityschoolnyc.org>',
    to:      PARENTS_STAFF_EMAILS,
    subject: `⚠️ ACTION REQUIRED — Parents gift not recorded — ${amountFormatted} — ${gift.first_name} ${gift.last_name}`,
    html: `
      <div style="max-width:580px;margin:0 auto;font-family:Arial,sans-serif;font-size:14px;color:#222;">
        <div style="background:#B91C1C;color:#fff;padding:16px 24px;">
          <strong style="font-size:17px;">⚠️ Supabase write failed — manual entry required</strong>
        </div>
        <div style="background:#FEF2F2;border-left:4px solid #B91C1C;padding:14px 20px;font-size:13px;line-height:1.6;">
          A payment was successfully captured by BBMS but <strong>could not be saved to the database</strong>
          (Supabase was unreachable). The donor's card was charged. This gift will not appear on the leaderboard
          until it is entered manually.
        </div>
        <div style="padding:20px 24px;">
          <table cellpadding="7" style="border-collapse:collapse;width:100%;">
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;width:150px;">Donor</td>
              <td><strong>${gift.first_name} ${gift.last_name}</strong></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Email</td>
              <td>${gift.email || '—'}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Amount</td>
              <td><strong>${amountFormatted}</strong></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Grade(s)</td>
              <td>${gradeStr}</td>
            </tr>
            ${gift.household_import_id ? `<tr style="border-bottom:1px solid #eee;"><td style="color:#666;">Household ID</td><td style="font-family:monospace;font-size:12px;">${gift.household_import_id}</td></tr>` : ''}
            <tr style="border-bottom:1px solid #eee;">
              <td style="color:#666;">Fund</td>
              <td>${gift.fund || 'Annual Fund'}</td>
            </tr>
            <tr>
              <td style="color:#666;">Transaction ID</td>
              <td style="font-family:monospace;font-size:12px;">${gift.transaction_id}</td>
            </tr>
          </table>
        </div>
        <div style="padding:0 24px 20px;">
          <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#666;text-transform:uppercase;letter-spacing:.05em;">Full payload (for manual Supabase insert)</p>
          <pre style="background:#f5f5f5;padding:12px;font-size:11px;overflow-x:auto;white-space:pre-wrap;">${payload}</pre>
        </div>
      </div>
    `,
  });

  if (error) {
    console.error('[Parents] Emergency notification send failed:', error);
    return false;
  }
  console.warn('[Parents] Emergency notification sent — gift requires manual Supabase entry');
  return true;
}

// ─── Timestamped console logging ─────────────────────────────────────────────
const _log  = console.log.bind(console);
const _warn = console.warn.bind(console);
const _err  = console.error.bind(console);
const ts = () => new Date().toLocaleTimeString();
console.log   = (...a) => _log(`[${ts()}]`, ...a);
console.warn  = (...a) => _warn(`[${ts()}]`, ...a);
console.error = (...a) => _err(`[${ts()}]`, ...a);

// ─── Supabase client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Parents campaign Supabase client ─────────────────────────────────────────
const parentsSupabase = (process.env.SUPABASE_URL_PARENTS && process.env.SUPABASE_KEY_PARENTS)
  ? createClient(process.env.SUPABASE_URL_PARENTS, process.env.SUPABASE_KEY_PARENTS)
  : null;
if (!parentsSupabase) console.warn('SUPABASE_URL_PARENTS / SUPABASE_KEY_PARENTS not set — /api/parents/* routes will return 503.');

// In-memory cache for the parents leaderboard — served on Supabase outage
let parentsLeaderboardCache = null;

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Token state ──────────────────────────────────────────────────────────────
// Seeded from env vars, then kept in sync with Supabase so tokens survive
// server restarts and redeploys on Render/Railway.
let tokens = {
  access_token:  process.env.SKY_ACCESS_TOKEN  || null,
  refresh_token: process.env.SKY_REFRESH_TOKEN || null,
};

async function loadTokensFromSupabase() {
  const { data } = await supabase.from('sky_tokens').select('access_token, refresh_token').eq('id', 1).single();
  if (data && data.refresh_token) {
    tokens.access_token  = data.access_token;
    tokens.refresh_token = data.refresh_token;
    console.log('Tokens loaded from Supabase.');
  } else {
    console.log('No tokens in Supabase — using .env values.');
  }
}

async function saveTokensToSupabase() {
  await supabase.from('sky_tokens').upsert({
    id:            1,
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    updated_at:    new Date().toISOString(),
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION A: SKY API OAuth helpers
// ─────────────────────────────────────────────────────────────────────────────

// Blackbaud OAuth endpoints
const BB_AUTH_URL    = 'https://oauth2.sky.blackbaud.com/authorization';
const BB_TOKEN_URL   = 'https://oauth2.sky.blackbaud.com/token';
const REDIRECT_URI   = process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/blackbaud/callback`;

// Step A1 — Start the OAuth flow. Visit http://localhost:3001/auth/blackbaud in your browser.
app.get('/auth/blackbaud', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.SKY_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
  });
  res.redirect(`${BB_AUTH_URL}?${params}`);
});

// Step A2 — Blackbaud redirects back here with a ?code= parameter.
// We exchange it for an access token + refresh token and print them to the console.
app.get('/auth/blackbaud/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code returned from Blackbaud.');

  try {
    const response = await axios.post(BB_TOKEN_URL, new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     process.env.SKY_CLIENT_ID,
      client_secret: process.env.SKY_CLIENT_SECRET,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    tokens.access_token  = response.data.access_token;
    tokens.refresh_token = response.data.refresh_token;
    await saveTokensToSupabase();

    console.log('Tokens saved to Supabase.');
    res.send('<h2>Authorized.</h2><p>Tokens saved. You can close this tab and continue.</p>');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('OAuth exchange failed — check terminal for details.');
  }
});

// Step A3 — Refresh the access token when it expires (access tokens last ~60 min)
async function refreshAccessToken() {
  if (!tokens.refresh_token) throw new Error('No refresh token available. Run the OAuth flow first.');

  const response = await axios.post(BB_TOKEN_URL, new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokens.refresh_token,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    auth: { username: process.env.SKY_CLIENT_ID, password: process.env.SKY_CLIENT_SECRET },
  });

  tokens.access_token  = response.data.access_token;
  tokens.refresh_token = response.data.refresh_token;
  await saveTokensToSupabase();

  console.log('Access token refreshed and saved to Supabase.');
  return tokens.access_token;
}

// Step A4 — Wrapper that retries once with a fresh token if we get a 401
// Pass subscriptionKey to override the default (e.g. for Payments API calls)
async function skyRequest(config, subscriptionKey) {
  config.headers = {
    ...config.headers,
    'Authorization':          `Bearer ${tokens.access_token}`,
    'Bb-Api-Subscription-Key': subscriptionKey || process.env.SKY_SUBSCRIPTION_KEY,
  };

  try {
    return await axios(config);
  } catch (err) {
    if (err.response?.status === 401) {
      // Token expired — refresh and retry once
      await refreshAccessToken();
      config.headers['Authorization'] = `Bearer ${tokens.access_token}`;
      return await axios(config);
    }
    throw err;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION B: Constituent resolution
// ─────────────────────────────────────────────────────────────────────────────
// Tries email → name → create new. Returns { id, match_type }
// match_type: 'email' | 'name' | 'created'

async function resolveConstituent(first_name, last_name, email) {
  // 1. Email lookup
  if (email) {
    console.log('Step 1: searching by email:', email);
    const res = await skyRequest({
      method: 'get',
      url: 'https://api.sky.blackbaud.com/constituent/v1/constituents/search',
      params: { search_text: email, limit: 5 },
    });
    const match = (res.data?.value || []).find(c =>
      c.email && c.email.toLowerCase() === email.toLowerCase()
    );
    if (match) return { id: match.id, match_type: 'email' };
    console.log('Step 1: no email match found');
  }

  // 2. Name lookup
  if (first_name && last_name) {
    console.log('Step 2: searching by name:', first_name, last_name);
    const res = await skyRequest({
      method: 'get',
      url: 'https://api.sky.blackbaud.com/constituent/v1/constituents/search',
      params: { search_text: `${first_name} ${last_name}`, limit: 5 },
    });
    console.log('Name search results:', JSON.stringify(res.data?.value || [], null, 2));
    const match = (res.data?.value || []).find(c => {
      const name = (c.name || '').toLowerCase();
      return name.includes(first_name.toLowerCase()) && name.includes(last_name.toLowerCase());
    });
    if (match) return { id: match.id, match_type: 'name' };
    console.log('Step 2: no name match found');
  }

  // 3. Create new constituent
  console.log('Step 3: creating new constituent');
  const res = await skyRequest({
    method: 'post',
    url: 'https://api.sky.blackbaud.com/constituent/v1/constituents',
    data: {
      type:  'Individual',
      first: first_name,
      last:  last_name,
      email: email ? { address: email, type: 'Email 1' } : undefined,
    },
    headers: { 'Content-Type': 'application/json' },
  });
  const id = res.data?.id;
  if (!id) throw new Error('Constituent created but no ID returned');
  return { id, match_type: 'created' };
}


// Called when the donor enters their email on the giving form.
// Searches RE NXT for a constituent matching that email.
// Returns: name, system record ID, alumni class year, current parent status.

app.post('/api/lookup', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    // Search RE NXT for constituents matching this email
    const search = await skyRequest({
      method: 'get',
      url: 'https://api.sky.blackbaud.com/constituent/v1/constituents/search',
      params: { search_text: email, limit: 5 },
    });

    const results = search.data?.value || [];
    if (results.length === 0) {
      return res.json({ found: false, message: 'No record found for this email.' });
    }

    // Take the first match — in production you'd handle multiple matches
    const match = results[0];
    const constituentId = match.id;

    // Fetch full constituent record to get class year, constituent codes, etc.
    const [constituentRes, codesRes] = await Promise.all([
      skyRequest({ method: 'get', url: `https://api.sky.blackbaud.com/constituent/v1/constituents/${constituentId}` }),
      skyRequest({ method: 'get', url: `https://api.sky.blackbaud.com/constituent/v1/constituents/${constituentId}/constituentcodes` }),
    ]);

    const constituent = constituentRes.data;
    const codes = codesRes.data?.value || [];

    // Determine primary constituent code (lowest sequence number, active only)
    const activeCodes = codes.filter(c => !c.inactive);
    activeCodes.sort((a, b) => a.sequence - b.sequence);
    const primaryCode = activeCodes[0]?.description || '';

    // Determine class year for leaderboard attribution
    // Alumni: use their class year attribute
    // Parents: use their current child's class year (from relationships — simplified here)
    const classYear = constituent.class_of || null;
    const isAlumni  = ['Alumni', 'Withdrawn Alumni', 'St Agatha Alumnae'].includes(primaryCode);
    const isParent  = primaryCode === 'Current Parent';

    return res.json({
      found: true,
      constituent: {
        id:          constituentId,
        name:        `${constituent.first} ${constituent.last}`,
        primary_code: primaryCode,
        class_year:  classYear,
        is_alumni:   isAlumni,
        is_parent:   isParent,
        // Leaderboard label shown to donor
        class_label: isAlumni && classYear
          ? `Class of ${classYear}`
          : isParent
          ? 'Current Parent'
          : primaryCode || 'Trinity Community',
      },
    });
  } catch (err) {
    console.error('Lookup error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Constituent lookup failed.', detail: err.response?.data || err.message });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// SECTION D: Gift entry into Supabase
// ─────────────────────────────────────────────────────────────────────────────
// Flow:
//   1. POST /api/gift → resolves constituent in RE (email → name → create)
//   2. Writes gift row to Supabase gifts table
//   3. Writes one affiliation_credits row per affiliation selected
//   4. RE batch import happens separately (end-of-day job — not built yet)

app.post('/api/gift', async (req, res) => {
  const { transaction_id, amount, first_name, last_name, email, fund, affiliations, anonymous } = req.body;

  if (!transaction_id || !amount) {
    return res.status(400).json({ error: 'transaction_id and amount are required.' });
  }

  try {
    // 1. Capture the payment via the Checkout Transaction endpoint
    // Converts the BBMS authorization into a completed charge
    const captureRes = await skyRequest({
      method: 'post',
      url: `https://api.sky.blackbaud.com/payments/v1/transactions/${transaction_id}/capture`,
      data: {
        amount: Math.round(amount * 100), // cents
      },
      headers: { 'Content-Type': 'application/json' },
    }, process.env.BBMS_API_KEY);
    console.log(`Payment captured: ${transaction_id} — state: ${captureRes.data?.state || captureRes.status}`);


    // 2. Save gift to Supabase immediately — no RE call, donor gets instant response
    const { data: gift, error: giftError } = await supabase
      .from('gifts')
      .insert({
        transaction_id,
        amount,
        fund:              'Annual Fund',
        first_name,
        last_name,
        email,
        constituent_id:    null, // resolved async by background job
        match_type:        null,
        source:            'online',
        anonymous:         anonymous || false,
        confirmation_sent: false,
      })
      .select()
      .single();

    if (giftError) throw new Error('Supabase gift insert failed: ' + giftError.message);
    console.log(`Gift saved to Supabase: ${gift.id}`);

    // Save affiliation credits — optimistically set counts_toward_total=true if
    // this is the first gift we've seen from this email. Background job will
    // correct it later if constituent lookup reveals a duplicate.
    let firstGift = true;
    if (email && process.env.SKIP_RE_RESOLUTION !== 'true') {
      const { data: prior } = await supabase
        .from('gifts')
        .select('id')
        .eq('email', email)
        .neq('id', gift.id)
        .limit(1);
      if (prior && prior.length > 0) firstGift = false;
    }

    if (affiliations && affiliations.length > 0) {
      const credits = affiliations.map(aff => ({
        gift_id:             gift.id,
        affiliation_type:    aff.type,
        class_year:          aff.class_year || null,
        grade:               aff.grade || null,
        counts_toward_total: firstGift,
      }));

      const { error: creditsError } = await supabase
        .from('affiliation_credits')
        .insert(credits);

      if (creditsError) throw new Error('Supabase affiliation insert failed: ' + creditsError.message);
      console.log(`${credits.length} affiliation credit(s) saved for gift ${gift.id} (counts_toward_total=${firstGift})`);
    }

    // Send confirmation email and mark as sent
    const giftWithFund = { ...gift, fund: fund || 'Annual Fund' };
    const emailSent = await sendConfirmationEmail(giftWithFund, affiliations);
    if (emailSent) {
      await supabase.from('gifts').update({ confirmation_sent: true }).eq('id', gift.id);
    }

    // Send internal staff notification
    await sendStaffNotification(giftWithFund, affiliations);

    return res.json({ success: true, gift_id: gift.id });

  } catch (err) {
    console.error('Gift error:', err.response?.status, JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: 'Gift failed.', detail: err.response?.data || err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Background job: resolve constituents for unmatched gifts
// ─────────────────────────────────────────────────────────────────────────────
// Runs every 2 minutes. Finds gifts with no constituent_id, resolves them
// against RE NXT, updates Supabase with the constituent ID and match type,
// and sets counts_toward_total on the first affiliation credit.

async function resolveUnmatchedGifts() {
  const { data: gifts, error } = await supabase
    .from('gifts')
    .select('*')
    .is('constituent_id', null)
    .eq('source', 'online');

  if (error) { console.error('resolveUnmatchedGifts query error:', error.message); return; }
  if (!gifts || gifts.length === 0) return;

  if (process.env.SKIP_RE_RESOLUTION === 'true') {
    // Skip RE API calls but still set counts_toward_total so leaderboard works locally
    for (const gift of gifts) {
      const { data: existing } = await supabase
        .from('affiliation_credits')
        .select('id')
        .eq('gift_id', gift.id)
        .eq('counts_toward_total', true)
        .limit(1);
      if (existing && existing.length > 0) continue; // already set

      // Check if this email has a prior gift with counts_toward_total=true
      let isFirst = true;
      if (gift.email) {
        const { data: prior } = await supabase
          .from('gifts')
          .select('id')
          .eq('email', gift.email)
          .neq('id', gift.id)
          .limit(1);
        if (prior && prior.length > 0) {
          const { data: priorCredited } = await supabase
            .from('affiliation_credits')
            .select('id')
            .eq('gift_id', prior[0].id)
            .eq('counts_toward_total', true)
            .limit(1);
          if (priorCredited && priorCredited.length > 0) isFirst = false;
        }
      }

      if (isFirst) {
        await supabase
          .from('affiliation_credits')
          .update({ counts_toward_total: true })
          .eq('gift_id', gift.id);
        console.log(`SKIP_RE_RESOLUTION: set counts_toward_total=true for gift ${gift.id}`);
      }

      // Mark constituent_id so Render's background job doesn't pick this up
      await supabase
        .from('gifts')
        .update({ constituent_id: 'LOCAL_TEST', match_type: 'local_test' })
        .eq('id', gift.id);
    }
    return;
  }

  console.log(`Resolving ${gifts.length} unmatched gift(s)...`);

  for (const gift of gifts) {
    try {
      // Try email → name match only (no auto-create yet)
      let constituent_id = null;
      let match_type = null;

      // Email lookup
      if (gift.email) {
        const res = await skyRequest({
          method: 'get',
          url: 'https://api.sky.blackbaud.com/constituent/v1/constituents/search',
          params: { search_text: gift.email, limit: 5 },
        });
        const match = (res.data?.value || []).find(c =>
          c.email && c.email.toLowerCase() === gift.email.toLowerCase()
        );
        if (match) { constituent_id = match.id; match_type = 'email'; }
      }

      // Name lookup
      if (!constituent_id && gift.first_name && gift.last_name) {
        const res = await skyRequest({
          method: 'get',
          url: 'https://api.sky.blackbaud.com/constituent/v1/constituents/search',
          params: { search_text: `${gift.first_name} ${gift.last_name}`, limit: 5 },
        });
        const match = (res.data?.value || []).find(c => {
          const name = (c.name || '').toLowerCase();
          return name.includes(gift.first_name.toLowerCase()) && name.includes(gift.last_name.toLowerCase());
        });
        if (match) { constituent_id = match.id; match_type = 'name'; }
      }

      // No match found — increment attempts counter
      if (!constituent_id) {
        const attempts = (gift.resolve_attempts || 0) + 1;
        await supabase.from('gifts').update({ resolve_attempts: attempts }).eq('id', gift.id);

        if (attempts < 3) {
          console.log(`Gift ${gift.id}: no match found (attempt ${attempts}/3), will retry.`);
          continue;
        }

        // 3 failed attempts — create new constituent
        console.log(`Gift ${gift.id}: no match after 3 attempts, creating new constituent.`);
        const res = await skyRequest({
          method: 'post',
          url: 'https://api.sky.blackbaud.com/constituent/v1/constituents',
          data: {
            type:  'Individual',
            first: gift.first_name,
            last:  gift.last_name,
            email: gift.email ? { address: gift.email, type: 'Email 1' } : undefined,
          },
          headers: { 'Content-Type': 'application/json' },
        });
        constituent_id = res.data?.id;
        match_type = 'created';
      }

      // Check if this is their first gift (for counts_toward_total)
      const { count: priorGifts } = await supabase
        .from('gifts')
        .select('id', { count: 'exact', head: true })
        .eq('constituent_id', String(constituent_id))
        .not('constituent_id', 'is', null);

      const isFirstGift = (priorGifts || 0) === 0;

      // Update gift row with constituent ID
      await supabase
        .from('gifts')
        .update({ constituent_id: String(constituent_id), match_type })
        .eq('id', gift.id);

      // Set counts_toward_total on the first affiliation credit for this gift
      if (isFirstGift) {
        const { data: credits } = await supabase
          .from('affiliation_credits')
          .select('id')
          .eq('gift_id', gift.id)
          .limit(1);

        if (credits && credits.length > 0) {
          await supabase
            .from('affiliation_credits')
            .update({ counts_toward_total: true })
            .eq('id', credits[0].id);
        }
      }

      console.log(`Resolved gift ${gift.id}: constituent ${constituent_id} (${match_type}), first gift: ${isFirstGift}`);
    } catch (err) {
      console.error(`Failed to resolve gift ${gift.id}:`, err.response?.data || err.message);
    }
  }
}

// Run immediately on startup, then every 2 minutes
loadTokensFromSupabase().then(() => {
  resolveUnmatchedGifts();
  setInterval(resolveUnmatchedGifts, 2 * 60 * 1000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Offline gift sync — polls RE NXT every 30 min for gifts entered by staff
// (checks, DAFs, pledges, etc.) and writes them to Supabase.
// ─────────────────────────────────────────────────────────────────────────────

// Giving day config — set in .env or defaults here
const GIVING_DAY_START = process.env.GIVING_DAY_START || '2026-05-01'; // YYYY-MM-DD
const GIVING_DAY_END   = process.env.GIVING_DAY_END   || '2026-05-02'; // YYYY-MM-DD
const GIVING_DAY_FUND  = process.env.GIVING_DAY_FUND  || 'Annual Fund';

// Current school year's graduating class (seniors).
// Before July → this calendar year. July onward → next year.
function currentGradYear() {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
}

// Compute a child's grade from their RE graduation year.
// Returns 'K', '1'–'12', or null if not currently enrolled.
function gradeFromGradYear(gradYear) {
  const grade = 12 - (gradYear - currentGradYear());
  if (grade < 0 || grade > 12) return null;
  if (grade === 0) return 'K';
  return String(grade);
}

// Maps every Trinity constituent code description to a giving-day affiliation type.
// Codes not listed here are ignored (orgs, incoming, vendors, etc.)
const CODE_TO_AFFILIATION = {
  'Trustee':                                   'friend',
  'Current Parent':                            'current_parent',
  'Alumni':                                    'alumni',
  'Current Grandparent':                       'grandparent',
  'Current Faculty & Staff':                   'faculty',
  'Former Trustee':                            'friend',
  'Parent of Alumni':                          'parent_of_alumni',
  'Grandparent of Alumni':                     'grandparent',
  'Withdrawn Alumni':                          'alumni',
  'Faculty and Staff Emeriti':                 'faculty',
  'St Agatha Alumnae':                         'alumni',
  'AfterSchool/Athletics/Coaches/Other staff': 'friend',
  'Current Student':                           'friend',
  'Current Parent on Leave':                   'current_parent',
  'Current Student on Leave':                  'friend',
  'Withdrawn Parent':                          'parent_of_alumni',
  'Withdrawn Grandparent':                     'grandparent',
  'Withdrawn Student':                         'friend',
  'Former Faculty & Staff':                    'friend',
  'Incoming Parent':                           'friend',
  'Incoming Grandparent':                      'friend',
  'Friend':                                    'friend',
  'Widow of Alumni':                           'friend',
};

// Given an already-fetched constituent record, derive giving-day affiliations.
// Uses constituent codes as the source of truth for affiliation type.
// Fetches education records (for alumni class year) and relationships (for parent grade) as needed.
async function deriveAffiliations(c, constituentId) {
  const affiliations = [];

  // Fetch constituent codes
  let codes = [];
  try {
    const codesRes = await skyRequest({
      method: 'get',
      url: `https://api.sky.blackbaud.com/constituent/v1/constituents/${constituentId}/constituentcodes`,
    });
    codes = codesRes.data?.value || [];
  } catch (err) {
    console.error(`deriveAffiliations: constituent codes fetch failed for ${constituentId}:`, err.message);
  }

  // Map active codes → unique affiliation types.
  // 'friend' is a fallback — drop it if any more specific affiliation exists.
  const affilTypes = new Set();
  codes.filter(c => !c.inactive).forEach(code => {
    const type = CODE_TO_AFFILIATION[code.description];
    if (type) affilTypes.add(type);
  });
  if (affilTypes.size > 1 && affilTypes.has('friend')) affilTypes.delete('friend');

  // Alumni — look up education records for class year
  if (affilTypes.has('alumni')) {
    try {
      const edRes = await skyRequest({
        method: 'get',
        url: `https://api.sky.blackbaud.com/constituent/v1/constituents/${constituentId}/educations`,
      });
      const trinityEd = (edRes.data?.value || []).find(e =>
        e.school === 'Trinity School' && e.class_of
      );
      affiliations.push({ type: 'alumni', class_year: trinityEd ? parseInt(trinityEd.class_of) : null });
    } catch (err) {
      console.error(`deriveAffiliations: education fetch failed for ${constituentId}:`, err.message);
      affiliations.push({ type: 'alumni', class_year: null });
    }
    affilTypes.delete('alumni');
  }

  // Current Parent — look up relationships for children's grades
  if (affilTypes.has('current_parent')) {
    try {
      const relsRes = await skyRequest({
        method: 'get',
        url: `https://api.sky.blackbaud.com/constituent/v1/constituents/${constituentId}/relationships`,
        params: { limit: 500 },
      });
      const children = (relsRes.data?.value || []).filter(r =>
        ['Son', 'Daughter', 'Child'].includes(r.type)
      );
      if (children.length > 0) {
        children.forEach(child => {
          const yearMatch = (child.name || '').match(/\b(20\d{2})\b/);
          if (yearMatch) {
            const grade = gradeFromGradYear(parseInt(yearMatch[1]));
            if (grade) affiliations.push({ type: 'current_parent', grade });
            else       affiliations.push({ type: 'current_parent', grade: null });
          } else {
            affiliations.push({ type: 'current_parent', grade: null });
          }
        });
      } else {
        affiliations.push({ type: 'current_parent', grade: null });
      }
    } catch (err) {
      console.error(`deriveAffiliations: relationships fetch failed for ${constituentId}:`, err.message);
      affiliations.push({ type: 'current_parent', grade: null });
    }
    affilTypes.delete('current_parent');
  }

  // All remaining types (grandparent, parent_of_alumni, faculty, friend)
  affilTypes.forEach(type => affiliations.push({ type }));

  // Fallback
  if (affiliations.length === 0) affiliations.push({ type: 'friend' });

  return affiliations;
}

async function syncOfflineGifts() {
  if (process.env.SKIP_RE_RESOLUTION === 'true') {
    console.log('syncOfflineGifts: SKIP_RE_RESOLUTION=true, skipping.');
    return;
  }

  try {
    console.log('syncOfflineGifts: checking RE for offline gifts...');

    const listId = process.env.OFFLINE_SYNC_LIST_ID;
    if (!listId) {
      console.log('syncOfflineGifts: no OFFLINE_SYNC_LIST_ID set, skipping.');
      return;
    }

    // Step 1: Submit the query execution job
    const execRes = await skyRequest({
      method: 'post',
      url: 'https://api.sky.blackbaud.com/query/queries/executebyid',
      params: { product: 'RE', module: 'None' },
      data: { id: parseInt(listId) },
    });
    const jobId = execRes.data?.id;
    if (!jobId) throw new Error('No job ID returned from query execution');
    console.log(`syncOfflineGifts: query job started — ${jobId}`);

    // Step 2: Poll /query/jobs/{jobId} until Completed
    let sasUri = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const jobRes = await skyRequest({
        method: 'get',
        url: `https://api.sky.blackbaud.com/query/jobs/${jobId}`,
        params: { product: 'RE', module: 'None', include_read_url: 1 },
      });
      const status = jobRes.data?.status;
        if (status === 'Completed') { sasUri = jobRes.data.sas_uri; break; }
      if (['Failed', 'Cancelled'].includes(status)) throw new Error(`Query job ${status}`);
    }
    if (!sasUri) throw new Error('Query job did not complete in time');

    // Step 3: Download CSV results from SAS URI (no auth needed — pre-signed URL)
    const csvRes = await axios.get(sasUri);
    const csvLines = csvRes.data.trim().split('\n');
    const headers = csvLines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    // Step 4: Find gift ID column and fetch full detail for each gift
    const idCol = headers.findIndex(h =>
      ['Gift ID', 'Gift System ID', 'System Record ID', 'ID'].includes(h)
    );
    if (idCol === -1) throw new Error(`Gift ID column not found in query output. Headers: ${headers.join(', ')}`);

    const offlineGifts = [];
    for (let i = 1; i < csvLines.length; i++) {
      const cols = csvLines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const giftId = cols[idCol];
      if (!giftId) continue;
      const giftRes = await skyRequest({
        method: 'get',
        url: `https://api.sky.blackbaud.com/gift/v1/gifts/${giftId}`,
      });
      if (giftRes.data) offlineGifts.push(giftRes.data);
    }
    console.log(`syncOfflineGifts: query returned ${offlineGifts.length} gift(s)`);

    if (offlineGifts.length === 0) {
      console.log('syncOfflineGifts: no gifts found in giving day window.');
      return;
    }

    console.log(`syncOfflineGifts: ${offlineGifts.length} gift(s) to process...`);

    for (const reGift of offlineGifts) {
      const reGiftId = String(reGift.id);

      // Skip if already synced
      const { data: existing } = await supabase
        .from('gifts')
        .select('id')
        .eq('transaction_id', reGiftId)
        .eq('source', 'offline')
        .limit(1);
      if (existing && existing.length > 0) continue;

      const constituentId = String(reGift.constituent_id);

      // Fetch constituent record
      let constituent;
      try {
        const cRes = await skyRequest({
          method: 'get',
          url: `https://api.sky.blackbaud.com/constituent/v1/constituents/${constituentId}`,
        });
        constituent = cRes.data;
      } catch (err) {
        console.error(`syncOfflineGifts: can't fetch constituent ${constituentId}:`, err.message);
        continue;
      }

      const firstName = constituent.first || '';
      const lastName  = constituent.last  || '';
      const email     = constituent.email?.address || null;
      const amount    = parseFloat(reGift.amount?.value || 0);
      const fund      = reGift.fund?.description || GIVING_DAY_FUND;

      // Derive affiliations
      const affiliations = await deriveAffiliations(constituent, constituentId);

      // First-gift check for counts_toward_total
      const { count: priorCount } = await supabase
        .from('gifts')
        .select('id', { count: 'exact', head: true })
        .eq('constituent_id', constituentId);
      const isFirstGift = (priorCount || 0) === 0;

      // Insert gift
      const { data: gift, error: giftError } = await supabase
        .from('gifts')
        .insert({
          transaction_id:    reGiftId,
          amount,
          fund,
          first_name:        firstName,
          last_name:         lastName,
          email,
          constituent_id:    constituentId,
          match_type:        'offline',
          source:            'offline',
          anonymous:         reGift.is_anonymous || false,
          confirmation_sent: false,
        })
        .select()
        .single();

      if (giftError) {
        console.error(`syncOfflineGifts: insert failed for gift ${reGiftId}:`, giftError.message);
        continue;
      }

      // Insert affiliation credits
      if (affiliations.length > 0) {
        const credits = affiliations.map(aff => ({
          gift_id:             gift.id,
          affiliation_type:    aff.type,
          class_year:          aff.class_year || null,
          grade:               aff.grade      || null,
          counts_toward_total: isFirstGift,
        }));
        await supabase.from('affiliation_credits').insert(credits);
      }

      console.log(`syncOfflineGifts: synced ${firstName} ${lastName} $${amount} — ${affiliations.map(a => a.type + (a.class_year ? ' ' + a.class_year : '') + (a.grade ? ' gr.' + a.grade : '')).join(', ')}`);
    }

  } catch (err) {
    console.error('syncOfflineGifts error:', err.response?.data || err.message);
  }
}

// Sync offline gifts on startup and every 30 minutes
setTimeout(() => {
  syncOfflineGifts();
  setInterval(syncOfflineGifts, 30 * 60 * 1000);
}, 5000); // 5s delay so tokens are loaded before first run

// ─────────────────────────────────────────────────────────────────────────────
// Parents offline gift sync
// Pulls parent Annual Fund gifts from RE (via a saved query) and upserts them
// into parentsSupabase so the leaderboard stays accurate without RE integration.
// Requires OFFLINE_SYNC_PARENTS_LIST_ID env var (RE query ID).
// ─────────────────────────────────────────────────────────────────────────────
let parentsOfflineSyncRunning = false;

async function syncParentsOfflineGifts() {
  if (process.env.SKIP_RE_RESOLUTION === 'true') {
    console.log('syncParentsOfflineGifts: SKIP_RE_RESOLUTION=true, skipping.');
    return;
  }
  if (!parentsSupabase) {
    console.log('syncParentsOfflineGifts: parentsSupabase not configured, skipping.');
    return;
  }
  if (parentsOfflineSyncRunning) {
    console.log('syncParentsOfflineGifts: already running, skipping.');
    return;
  }
  parentsOfflineSyncRunning = true;

  try {
    console.log('syncParentsOfflineGifts: checking RE for offline parent gifts...');

    const listId = process.env.OFFLINE_SYNC_PARENTS_LIST_ID;
    if (!listId) {
      console.log('syncParentsOfflineGifts: no OFFLINE_SYNC_PARENTS_LIST_ID set, skipping.');
      return;
    }

    // Step 1: Submit the query execution job
    const execRes = await skyRequest({
      method: 'post',
      url: 'https://api.sky.blackbaud.com/query/queries/executebyid',
      params: { product: 'RE', module: 'None' },
      data: { id: parseInt(listId) },
    });
    const jobId = execRes.data?.id;
    if (!jobId) throw new Error('No job ID returned from query execution');
    console.log(`syncParentsOfflineGifts: query job started — ${jobId}`);

    // Step 2: Poll until completed
    let sasUri = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const jobRes = await skyRequest({
        method: 'get',
        url: `https://api.sky.blackbaud.com/query/jobs/${jobId}`,
        params: { product: 'RE', module: 'None', include_read_url: 1 },
      });
      const status = jobRes.data?.status;
      if (status === 'Completed') { sasUri = jobRes.data.sas_uri; break; }
      if (['Failed', 'Cancelled'].includes(status)) throw new Error(`Query job ${status}`);
    }
    if (!sasUri) throw new Error('Query job did not complete in time');

    // Step 3: Download CSV results
    const csvRes = await axios.get(sasUri);
    const csvLines = csvRes.data.trim().split('\n');
    const headers = csvLines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    // Step 4: Find gift ID column and fetch full gift detail from RE
    const idCol = headers.findIndex(h =>
      ['Gift ID', 'Gift System ID', 'System Record ID', 'ID'].includes(h)
    );
    if (idCol === -1) throw new Error(`Gift ID column not found. Headers: ${headers.join(', ')}`);

    const offlineGifts = [];
    for (let i = 1; i < csvLines.length; i++) {
      const cols = csvLines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const giftId = cols[idCol];
      if (!giftId) continue;
      const giftRes = await skyRequest({
        method: 'get',
        url: `https://api.sky.blackbaud.com/gift/v1/gifts/${giftId}`,
      });
      if (giftRes.data) offlineGifts.push(giftRes.data);
    }
    console.log(`syncParentsOfflineGifts: query returned ${offlineGifts.length} gift(s)`);

    if (offlineGifts.length === 0) {
      console.log('syncParentsOfflineGifts: no gifts to process.');
      return;
    }

    for (const reGift of offlineGifts) {
      const reGiftId      = String(reGift.id);
      const constituentId = String(reGift.constituent_id);

      // Skip if already synced
      const { data: existing } = await parentsSupabase
        .from('gifts')
        .select('id')
        .eq('transaction_id', reGiftId)
        .eq('source', 'offline')
        .limit(1);
      if (existing && existing.length > 0) continue;

      // Match to a household via parent_constituents
      // A gift could be from the primary OR the spouse (fid = constituentId + 'S'),
      // but both share the same household_import_id.
      const { data: pc } = await parentsSupabase
        .from('parent_constituents')
        .select('fid, first_name, last_name, email, household_import_id')
        .or(`fid.eq.${constituentId},fid.eq.${constituentId}S`)
        .limit(1)
        .maybeSingle();

      if (!pc) {
        console.warn(`syncParentsOfflineGifts: constituent ${constituentId} not in parent_constituents — skipping gift ${reGiftId}`);
        continue;
      }

      const { household_import_id } = pc;

      // Use cached name/email from parent_constituents; try RE for fresher data
      let firstName = pc.first_name;
      let lastName  = pc.last_name;
      let email     = pc.email;
      try {
        const cRes = await skyRequest({
          method: 'get',
          url: `https://api.sky.blackbaud.com/constituent/v1/constituents/${constituentId}`,
        });
        firstName = cRes.data.first || firstName;
        lastName  = cRes.data.last  || lastName;
        email     = cRes.data.email?.address || email;
      } catch (err) {
        console.warn(`syncParentsOfflineGifts: couldn't fetch RE constituent ${constituentId} — using cached data`);
      }

      const amount = parseFloat(reGift.amount?.value || 0);
      const fund   = reGift.fund?.description || 'Annual Fund';

      // Look up household grades
      const { data: household } = await parentsSupabase
        .from('parent_households')
        .select('grades')
        .eq('household_import_id', household_import_id)
        .maybeSingle();
      const grades = household?.grades || [];

      // First-gift check — dedup by household
      const { data: priorGifts } = await parentsSupabase
        .from('gifts')
        .select('id')
        .eq('household_import_id', household_import_id)
        .limit(1);
      const isFirstGift = !priorGifts || priorGifts.length === 0;

      // Insert gift
      const { data: gift, error: giftError } = await parentsSupabase
        .from('gifts')
        .insert({
          transaction_id:     reGiftId,
          amount,
          fund,
          first_name:         firstName,
          last_name:          lastName,
          email,
          constituent_id:     constituentId,
          match_type:         'offline',
          source:             'offline',
          anonymous:          reGift.is_anonymous || false,
          confirmation_sent:  false,
          household_import_id,
        })
        .select()
        .single();

      if (giftError) {
        console.error(`syncParentsOfflineGifts: insert failed for gift ${reGiftId}:`, giftError.message);
        continue;
      }

      // Build affiliation credits from household grades
      if (grades.length > 0) {
        const credits = grades.map(grade => ({
          gift_id:             gift.id,
          affiliation_type:    'current_parent',
          class_year:          grade === 'K' ? 2038 : (2038 - parseInt(grade)),
          grade,
          counts_toward_total: isFirstGift,
        }));
        await parentsSupabase.from('affiliation_credits').insert(credits);
      }

      console.log(`syncParentsOfflineGifts: synced ${firstName} ${lastName} $${amount} — household ${household_import_id} — grades: ${grades.join(', ') || 'none'}`);
    }

  } catch (err) {
    console.error('syncParentsOfflineGifts error:', err.response?.data || err.message);
  } finally {
    parentsOfflineSyncRunning = false;
  }
}

// Sync parents offline gifts on startup and every 30 minutes
setTimeout(() => {
  syncParentsOfflineGifts();
  setInterval(syncParentsOfflineGifts, 30 * 60 * 1000);
}, 8000); // slight offset from main sync to avoid simultaneous SKY API calls

// ─────────────────────────────────────────────────────────────────────────────
// Leaderboard — reads from Supabase, returns ranked alumni + parent boards,
// overall stats, recent gifts, and challenge progress
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  try {
    const [creditsResult, giftsResult, sumResult] = await Promise.all([
      supabase
        .from('affiliation_credits')
        .select('gift_id, affiliation_type, class_year, grade, counts_toward_total'),
      supabase
        .from('gifts')
        .select('id, first_name, last_name, amount, created_at, affiliation_credits(affiliation_type, class_year, grade)')
        .neq('anonymous', true)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('gifts')
        .select('id, amount, email, constituent_id, first_name, last_name'),
    ]);

    const credits    = creditsResult.data  || [];
    const recentRows = giftsResult.data    || [];
    const allGifts   = sumResult.data      || [];

    const totalRaised  = allGifts.reduce((s, g) => s + (parseFloat(g.amount) || 0), 0);
    const counted      = credits.filter(c => c.counts_toward_total);

    // Count unique donors from the gifts table directly — dedup by constituent_id
    // when resolved, fall back to email for unresolved gifts.
    const donorSet = new Set();
    allGifts.forEach(g => {
      if (g.constituent_id && g.constituent_id !== 'LOCAL_TEST') {
        donorSet.add('cid:' + g.constituent_id);
      } else if (g.first_name && g.last_name) {
        donorSet.add('name:' + g.first_name.toLowerCase() + '|' + g.last_name.toLowerCase());
      } else {
        donorSet.add('gift:' + g.id);
      }
    });
    const totalDonors = donorSet.size;

    // Group alumni credits by class_year — only counted credits
    const alumniMap = {};
    counted.forEach(c => {
      if (c.affiliation_type === 'alumni' && c.class_year) {
        if (!alumniMap[c.class_year]) alumniMap[c.class_year] = new Set();
        alumniMap[c.class_year].add(c.gift_id);
      }
    });
    const alumni = Object.entries(alumniMap)
      .map(([year, set]) => ({ class_year: parseInt(year), donors: set.size }))
      .sort((a, b) => b.donors - a.donors);

    // Group current parents — only counted credits
    const parentsMap = {};
    counted.forEach(c => {
      if (c.affiliation_type !== 'current_parent' && c.affiliation_type !== 'parents') return;
      const key = c.grade ? ('grade:' + c.grade) : c.class_year ? ('year:' + c.class_year) : null;
      if (!key) return;
      if (!parentsMap[key]) parentsMap[key] = { grade: c.grade || null, class_year: c.class_year || null, gifts: new Set() };
      parentsMap[key].gifts.add(c.gift_id);
    });
    const parents = Object.values(parentsMap)
      .map(e => ({ grade: e.grade, class_year: e.class_year, donors: e.gifts.size }))
      .sort((a, b) => b.donors - a.donors);

    // Format recent gifts — pick the most informative affiliation label when a donor has multiple
    const recent_gifts = recentRows.map(g => {
      const affs = g.affiliation_credits || [];
      const pick =
        affs.find(a => a.affiliation_type === 'alumni' && a.class_year) ||
        affs.find(a => (a.affiliation_type === 'current_parent' || a.affiliation_type === 'parents') && (a.grade || a.class_year)) ||
        affs[0];
      let affiliation = 'Trinity Community';
      if (pick) {
        const t = pick.affiliation_type;
        if      (t === 'alumni' && pick.class_year)                                  affiliation = `Class of ${pick.class_year}`;
        else if ((t === 'current_parent' || t === 'parents') && pick.grade)          affiliation = `${gradeLabel(pick.grade)} Parent`;
        else if ((t === 'current_parent' || t === 'parents') && pick.class_year)     affiliation = `Class of '${String(pick.class_year).slice(-2)} Parent`;
        else if (t === 'parent_of_alumni')                                           affiliation = 'Parent of Alumni';
        else if (t === 'faculty')                                                    affiliation = 'Faculty / Staff';
        else if (t === 'grandparent')                                                affiliation = 'Grandparent';
        else if (t === 'friend')                                                     affiliation = 'Friend of Trinity';
      }
      return {
        name:        g.first_name ? `${g.first_name[0]}. ${g.last_name}` : 'Anonymous',
        affiliation,
        amount:      parseFloat(g.amount) || 0,
        created_at:  g.created_at,
      };
    });

    // Affiliation breakdown — percentage of total donors per type
    const AFFIL_LABELS = {
      alumni:           'Alumni',
      current_parent:   'Current Parent',
      parent_of_alumni: 'Parent of Alumni',
      grandparent:      'Grandparent',
      faculty:          'Faculty / Staff',
      friend:           'Friend of Trinity',
    };
    const affilMap = {};
    counted.forEach(c => {
      if (!affilMap[c.affiliation_type]) affilMap[c.affiliation_type] = new Set();
      affilMap[c.affiliation_type].add(c.gift_id);
    });
    const affil_breakdown = totalDonors > 0
      ? Object.entries(affilMap)
          .map(([type, gifts]) => ({
            label: AFFIL_LABELS[type] || type,
            pct:   Math.round(gifts.size / totalDonors * 100),
          }))
          .sort((a, b) => b.pct - a.pct)
      : [];

    res.json({ alumni, parents, total_donors: totalDonors, total_raised: totalRaised, recent_gifts, affil_breakdown });
  } catch (err) {
    console.error('Leaderboard error:', err.message);
    res.status(500).json({ error: 'Leaderboard query failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Parents campaign — separate Supabase, grade-only leaderboard
// ─────────────────────────────────────────────────────────────────────────────

// YTD parent participation baseline — families that gave before this campaign page.
// Grade key matches the grade stored in affiliation_credits ('K', '1'–'12').
// PARENT_BASELINE_TOTAL is the count of UNIQUE families (< sum of per-grade counts,
// because families with multiple children appear in more than one grade row).
const PARENT_GRADE_BASELINE = {
  '12': 85, '11': 52, '10': 61, '9': 61, '8': 28,
   '7': 29,  '6': 27,  '5': 24, '4': 35, '3': 36,
   '2': 43,  '1': 42,  'K': 47,
};
const PARENT_BASELINE_TOTAL = 429;

// Total families per grade (denominator for participation %)
const PARENT_GRADE_TOTALS = {
  '12': 125, '11': 114, '10': 118, '9': 114, '8': 62,
   '7':  65,  '6':  58,  '5':  60, '4':  61, '3': 63,
   '2':  62,  '1':  58,  'K':  62,
};

// ─── Parents: constituent / household lookup ───────────────────────────────
app.get('/api/parents/lookup', async (req, res) => {
  if (!parentsSupabase) return res.status(503).json({ error: 'Parents database not configured.' });

  const { fid, email } = req.query;
  if (!fid && !email) return res.status(400).json({ error: 'fid or email required.' });

  try {
    // ── Email lookup (step-1 form path) ──────────────────────────────────────
    if (email) {
      const { data: constituent } = await parentsSupabase
        .from('parent_constituents')
        .select('fid, household_import_id, first_name, last_name, email')
        .ilike('email', email.trim())
        .maybeSingle();

      if (!constituent) return res.json({ found: false });

      const { data: household } = await parentsSupabase
        .from('parent_households')
        .select('household_name, grades')
        .eq('household_import_id', constituent.household_import_id)
        .maybeSingle();

      const { data: priorGift } = await parentsSupabase
        .from('gifts')
        .select('id')
        .eq('household_import_id', constituent.household_import_id)
        .limit(1);

      return res.json({
        found:                true,
        fid:                  constituent.fid,
        first_name:           constituent.first_name,
        last_name:            constituent.last_name || null,
        household_import_id:  constituent.household_import_id,
        grades:               household?.grades || [],
        already_gave:         !!(priorGift && priorGift.length > 0),
      });
    }

    // ── fid lookup ────────────────────────────────────────────────────────────
    let firstName         = null;
    let householdImportId = null;

    const { data: constituent } = await parentsSupabase
      .from('parent_constituents')
      .select('household_import_id, first_name, last_name, email')
      .eq('fid', fid)
      .maybeSingle();

    if (constituent) {
      householdImportId = constituent.household_import_id;
      firstName         = constituent.first_name;
    } else {
      // fid may be a household_import_id directly (before constituent table is seeded)
      householdImportId = fid;
    }

    const { data: household } = await parentsSupabase
      .from('parent_households')
      .select('household_name, grades, is_hh2')
      .eq('household_import_id', householdImportId)
      .maybeSingle();

    if (!household) return res.status(404).json({ error: 'Household not found.' });

    const { data: priorGift } = await parentsSupabase
      .from('gifts')
      .select('id')
      .eq('household_import_id', householdImportId)
      .limit(1);

    return res.json({
      found:                true,
      fid,
      first_name:           firstName,
      last_name:            constituent?.last_name || null,
      email:                constituent?.email     || null,
      household_import_id:  householdImportId,
      household_name:       household.household_name,
      grades:               household.grades,
      already_gave:         !!(priorGift && priorGift.length > 0),
    });

  } catch (err) {
    console.error('[Parents] Lookup error:', err.message);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

app.get('/api/parents/leaderboard', async (req, res) => {
  if (!parentsSupabase) return res.status(503).json({ error: 'Parents database not configured.' });

  try {
    const [creditsResult, giftsResult, sumResult] = await Promise.all([
      parentsSupabase
        .from('affiliation_credits')
        .select('gift_id, affiliation_type, class_year, grade, counts_toward_total'),
      parentsSupabase
        .from('gifts')
        .select('id, first_name, last_name, household_import_id, anonymous, amount, created_at, affiliation_credits(affiliation_type, class_year, grade)')
        .order('created_at', { ascending: false })
        .limit(10),
      parentsSupabase
        .from('gifts')
        .select('id, amount, email, constituent_id, first_name, last_name, household_import_id'),
    ]);

    const credits    = creditsResult.data  || [];
    const recentRows = giftsResult.data    || [];
    const allGifts   = sumResult.data      || [];

    // Live totals — only real gifts from this page
    const totalRaised = allGifts.reduce((s, g) => s + (parseFloat(g.amount) || 0), 0);
    const counted     = credits.filter(c => c.counts_toward_total);

    // Unique live donor count — prefer household dedup, fall back to name/email
    const donorSet = new Set();
    allGifts.forEach(g => {
      if (g.household_import_id) {
        donorSet.add('hh:' + g.household_import_id);
      } else if (g.constituent_id && g.constituent_id !== 'LOCAL_TEST') {
        donorSet.add('cid:' + g.constituent_id);
      } else if (g.first_name && g.last_name) {
        donorSet.add('name:' + g.first_name.toLowerCase() + '|' + g.last_name.toLowerCase());
      } else {
        donorSet.add('gift:' + g.id);
      }
    });
    // Total = baseline (families who gave YTD) + new live gifts through this page
    const totalDonors = PARENT_BASELINE_TOTAL + donorSet.size;

    // Per-grade live counts from this page
    const liveGradeMap = {};
    counted.forEach(c => {
      if (c.affiliation_type !== 'current_parent') return;
      const key = c.grade || (c.class_year ? ('cy:' + c.class_year) : null);
      if (!key) return;
      if (!liveGradeMap[key]) liveGradeMap[key] = { grade: c.grade || null, class_year: c.class_year || null, liveGifts: new Set() };
      liveGradeMap[key].liveGifts.add(c.gift_id);
    });

    // Merge baseline + live counts, compute participation %
    const gradeKeys = new Set([...Object.keys(PARENT_GRADE_BASELINE), ...Object.keys(liveGradeMap)]);
    const parents = Array.from(gradeKeys).map(key => {
      const baseline = PARENT_GRADE_BASELINE[key] || 0;
      const live     = liveGradeMap[key] ? liveGradeMap[key].liveGifts.size : 0;
      const entry    = liveGradeMap[key];
      const donors   = baseline + live;
      const total    = PARENT_GRADE_TOTALS[key] || null;
      const pct      = total ? Math.round(donors / total * 100) : null;
      return {
        grade:      entry ? entry.grade      : key === 'K' ? 'K' : key.startsWith('cy:') ? null : key,
        class_year: entry ? entry.class_year : null,
        donors,
        total,
        pct,
      };
    }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

    // Recent gifts — live only, non-anonymous
    // Batch-fetch household members for all recent gifts that have a household_import_id
    const recentHHIds = [...new Set(recentRows.map(g => g.household_import_id).filter(Boolean))];
    const householdLastNames = {};
    if (recentHHIds.length > 0) {
      const { data: hhMembers } = await parentsSupabase
        .from('parent_constituents')
        .select('household_import_id, last_name')
        .in('household_import_id', recentHHIds);
      (hhMembers || []).forEach(m => {
        if (!m.last_name) return;
        if (!householdLastNames[m.household_import_id]) householdLastNames[m.household_import_id] = new Set();
        householdLastNames[m.household_import_id].add(m.last_name);
      });
    }

    const recent_gifts = recentRows.map(g => {
      const affs = g.affiliation_credits || [];

      // Collect all distinct grades for this household gift
      const gradeSet = new Set(
        affs
          .filter(a => a.affiliation_type === 'current_parent' && a.grade)
          .map(a => a.grade)
      );
      const sortedGrades = [...gradeSet].sort((a, b) => {
        const na = a === 'K' ? 0 : parseInt(a);
        const nb = b === 'K' ? 0 : parseInt(b);
        return na - nb;
      });
      // Short labels for combining: "8th", "3rd", "K" — "Grade" appended once at the end
      const gradeShorts = sortedGrades.map(gr => {
        if (gr === 'K') return 'Kindergarten';
        const n = parseInt(gr);
        const sfx = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
        return `${n}${sfx}`;
      });
      let affiliation = 'Trinity Parent';
      if (gradeShorts.length === 1) {
        affiliation = gradeShorts[0] === 'Kindergarten' ? 'Kindergarten Parent' : `${gradeShorts[0]} Grade Parent`;
      } else {
        const allButLast = gradeShorts.slice(0, -1).join(', ');
        const last = gradeShorts[gradeShorts.length - 1];
        const suffix = last === 'Kindergarten' ? ' Parent' : ' Grade Parent';
        affiliation = `${allButLast} & ${last}${suffix}`;
      }

      // Build family name
      let name;
      if (g.anonymous) {
        name = 'Anonymous Trinity Family';
      } else {
        const lastNameSet = g.household_import_id
          ? (householdLastNames[g.household_import_id] || new Set([g.last_name]))
          : new Set([g.last_name]);
        const lastNames = [...lastNameSet].filter(Boolean);
        if (lastNames.length === 0) {
          name = 'A Trinity Family';
        } else if (lastNames.length === 1) {
          name = `The ${lastNames[0]} Family`;
        } else {
          const words0 = lastNames[0].toLowerCase().split(/[\s\-]+/);
          const words1 = lastNames[1].toLowerCase().split(/[\s\-]+/);
          const hasOverlap = words0.some(w => w.length > 1 && words1.includes(w));
          if (hasOverlap) {
            const compound = lastNames[0].length >= lastNames[1].length ? lastNames[0] : lastNames[1];
            name = `The ${compound} Family`;
          } else {
            name = `${lastNames[0]} & ${lastNames[1]} Family`;
          }
        }
      }

      return {
        name: g.anonymous ? 'Trinity Family' : name,
        affiliation: g.anonymous ? 'Anonymous' : affiliation,
        amount:     parseFloat(g.amount) || 0,
        created_at: g.created_at,
      };
    });

    const payload = { parents, total_donors: totalDonors, total_raised: totalRaised, recent_gifts };
    parentsLeaderboardCache = payload;
    res.json(payload);
  } catch (err) {
    console.error('Parents leaderboard error:', err.message);
    if (parentsLeaderboardCache) {
      console.warn('[Parents] Leaderboard Supabase error — serving cached data');
      return res.json({ ...parentsLeaderboardCache, cached: true });
    }
    // No cache yet — return baseline-only data so the page isn't broken
    const fallbackParents = Object.entries(PARENT_GRADE_BASELINE).map(([key, donors]) => ({
      grade:      key === 'K' ? 'K' : key.startsWith('cy:') ? null : key,
      class_year: null,
      donors,
      total:      PARENT_GRADE_TOTALS[key] || null,
      pct:        PARENT_GRADE_TOTALS[key] ? Math.round(donors / PARENT_GRADE_TOTALS[key] * 100) : null,
    })).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
    res.json({ parents: fallbackParents, total_donors: PARENT_BASELINE_TOTAL, total_raised: 0, recent_gifts: [], cached: true });
  }
});

app.post('/api/parents/gift', async (req, res) => {
  if (!parentsSupabase) return res.status(503).json({ error: 'Parents database not configured.' });

  const { transaction_id, amount, first_name, last_name, email, fund, household_import_id, affiliations, anonymous } = req.body;
  if (!transaction_id || !amount) {
    return res.status(400).json({ error: 'transaction_id and amount are required.' });
  }

  // ── Step 1: BBMS capture ──────────────────────────────────────────────────
  // If this fails, no money was taken — safe to return an error.
  try {
    const captureRes = await skyRequest({
      method: 'post',
      url: `https://api.sky.blackbaud.com/payments/v1/transactions/${transaction_id}/capture`,
      data: { amount: Math.round(amount * 100) },
      headers: { 'Content-Type': 'application/json' },
    }, process.env.BBMS_API_KEY);
    console.log(`[Parents] Payment captured: ${transaction_id} — state: ${captureRes.data?.state || captureRes.status}`);
  } catch (captureErr) {
    console.error('[Parents] BBMS capture failed:', captureErr.response?.status, JSON.stringify(captureErr.response?.data || captureErr.message));
    return res.status(500).json({ error: 'Payment capture failed.', detail: captureErr.response?.data || captureErr.message });
  }

  // ── Step 2: Supabase writes ───────────────────────────────────────────────
  // Payment is captured. A Supabase failure must NOT block the donor's thank-you
  // or leave the gift unrecorded silently. We catch errors here, send an emergency
  // staff email with the full payload, and still return success to the client.
  let gift = null;
  let affsToSave = [];
  let supabaseOk = false;

  try {
    // 2a. Look up household grades if household_import_id provided
    let householdGrades = [];
    if (household_import_id) {
      const { data: hh } = await parentsSupabase
        .from('parent_households')
        .select('grades')
        .eq('household_import_id', household_import_id)
        .maybeSingle();
      householdGrades = hh?.grades || [];
    }

    // 2b. Save gift
    const { data: giftData, error: giftError } = await parentsSupabase
      .from('gifts')
      .insert({
        transaction_id,
        amount,
        fund:                 fund || 'Annual Fund',
        first_name,
        last_name,
        email,
        constituent_id:       null,
        match_type:           null,
        source:               'online',
        anonymous:            anonymous || false,
        confirmation_sent:    false,
        household_import_id:  household_import_id || null,
      })
      .select()
      .single();

    if (giftError) throw new Error('Gift insert failed: ' + giftError.message);
    gift = giftData;
    console.log(`[Parents] Gift saved: ${gift.id}`);

    // 2c. First-gift check — dedup by household, then email
    let firstGift = true;
    if (household_import_id) {
      const { data: prior } = await parentsSupabase
        .from('gifts')
        .select('id')
        .eq('household_import_id', household_import_id)
        .neq('id', gift.id)
        .limit(1);
      if (prior && prior.length > 0) firstGift = false;
    } else if (email) {
      const { data: prior } = await parentsSupabase
        .from('gifts')
        .select('id')
        .eq('email', email)
        .neq('id', gift.id)
        .limit(1);
      if (prior && prior.length > 0) firstGift = false;
    }

    // 2d. Build and save affiliation credits
    affsToSave = householdGrades.length > 0
      ? householdGrades.map(grade => ({
          gift_id:             gift.id,
          affiliation_type:    'current_parent',
          class_year:          grade === 'K' ? 2038 : (2038 - parseInt(grade)),
          grade:               grade,
          counts_toward_total: firstGift,
        }))
      : (affiliations || []).map(aff => ({
          gift_id:             gift.id,
          affiliation_type:    aff.type,
          class_year:          aff.class_year || null,
          grade:               aff.grade      || null,
          counts_toward_total: firstGift,
        }));

    if (affsToSave.length > 0) {
      const { error: creditsError } = await parentsSupabase
        .from('affiliation_credits')
        .insert(affsToSave);
      if (creditsError) throw new Error('Affiliation insert failed: ' + creditsError.message);
      console.log(`[Parents] ${affsToSave.length} affiliation credit(s) saved for gift ${gift.id} (counts_toward_total=${firstGift})`);
    }

    supabaseOk = true;

  } catch (dbErr) {
    // Log the full payload so Render captures it — last resort if email also fails
    console.error('[Parents] ⚠️  Supabase write failed AFTER payment capture. Manual entry required.');
    console.error('[Parents] UNRECORDED GIFT:', JSON.stringify({
      transaction_id, amount, first_name, last_name, email,
      fund: fund || 'Annual Fund', household_import_id, affiliations,
    }));
    console.error('[Parents] DB error:', dbErr.message);
  }

  // ── Step 3: Emails ────────────────────────────────────────────────────────
  if (supabaseOk && gift) {
    // Normal path — gift recorded, send standard emails
    const giftWithFund = { ...gift, fund: fund || 'Annual Fund' };
    const emailSent = await sendParentsConfirmationEmail(giftWithFund, affsToSave);
    if (emailSent) {
      await parentsSupabase.from('gifts').update({ confirmation_sent: true }).eq('id', gift.id);
    }
    await sendParentsStaffNotification(giftWithFund, affsToSave);
  } else {
    // Supabase failed — send emergency alert to staff and confirmation to donor
    const syntheticGift = { transaction_id, amount, first_name, last_name, email, fund: fund || 'Annual Fund', household_import_id };
    await sendParentsEmergencyNotification(syntheticGift, affiliations || []);
    await sendParentsConfirmationEmail(syntheticGift, (affiliations || []).map(aff => ({
      affiliation_type: aff.type, grade: aff.grade || null, class_year: aff.class_year || null,
    })));
  }

  // Always return success — the payment went through regardless of Supabase state
  return res.json({ success: true, gift_id: gift?.id || null });
});

// ─────────────────────────────────────────────────────────────────────────────
// Health check — confirms Supabase connection and returns gift count
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const { count, error } = await supabase
    .from('gifts')
    .select('id', { count: 'exact', head: true });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, gifts_in_db: count });
});

app.get('/api/sync-offline', async (req, res) => {
  try {
    await syncOfflineGifts();
    res.json({ ok: true, message: 'Offline sync complete' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/parents/sync-offline', async (req, res) => {
  try {
    await syncParentsOfflineGifts();
    res.json({ ok: true, message: 'Parents offline sync complete' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nTrinity Giving Days server running at http://localhost:${PORT}`);
  console.log(`\nIf SKY API tokens are not yet in .env, authorize here:`);
  console.log(`  http://localhost:${PORT}/auth/blackbaud\n`);
});
