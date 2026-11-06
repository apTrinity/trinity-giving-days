// Giving Days emails: the donor's confirmation/receipt and the staff notification, sent when a gift is saved.
// Sent through Resend from trinityfund@trinityschoolnyc.org (replies go to the same address).
//
// TEST gifts (made in Blackbaud's test mode) never reach donors or the staff list: both emails go only to
// GD_TEST_EMAIL (default: Andrew) with a [TEST] label, so nobody gets a "thank you" for a gift that charged nothing.
// Env: RESEND_API_KEY (required), GD_TEST_EMAIL, GD_STAFF_EMAILS (comma-separated; overrides the default list).

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = 'Trinity Fund <trinityfund@trinityschoolnyc.org>';
const REPLY_TO = 'trinityfund@trinityschoolnyc.org';
const SITE = 'https://giving.trinityschoolnyc.org';
const RE_RECORD_URL = id => `https://app.blackbaud.com/constituent/records/${encodeURIComponent(id)}?envid=p-De4NWbbqzUeno2SrGlrLIQ&svcid=renxt`;

const DEFAULT_STAFF = [
  'abigail.bedrick@trinityschoolnyc.org',
  'andrew.peterson@trinityschoolnyc.org',
  'edward.griffin@trinityschoolnyc.org',
  'frances.shafer@trinityschoolnyc.org',
  'migdalia.villanueva@trinityschoolnyc.org',
  'myles.amend@trinityschoolnyc.org',
  'philip.bien@trinityschoolnyc.org',
];
const staffList = () => (process.env.GD_STAFF_EMAILS ? process.env.GD_STAFF_EMAILS.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_STAFF);
const testAddress = () => process.env.GD_TEST_EMAIL || 'andrew.peterson@trinityschoolnyc.org';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = d => new Date(d || Date.now()).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });

const TAG_LABEL = { alumni: 'Alumni', current_parent: 'Current parent', parent_of_alumni: 'Parent of alumni', faculty: 'Faculty / staff', grandparent: 'Grandparent', friend: 'Friend of Trinity', new_family: 'New family', alumna: 'Alumna' };
function connections(g) {
  const out = [];
  for (const t of g.declared_tags || []) {
    if (t === 'alumni') out.push(g.class_year ? `Alumni, Class of ${g.class_year}` : 'Alumni');
    else if (t === 'current_parent') out.push((g.grades || []).length ? `Current parent, grade${g.grades.length > 1 ? 's' : ''} ${g.grades.join(', ')}` : 'Current parent');
    else if (TAG_LABEL[t]) out.push(TAG_LABEL[t]);
  }
  return out;
}

// ── Personalization ──────────────────────────────────────────────────────────
// The audience text (reunion alumni, senior parents, ...) is the same text the admin edits for the gift form.
const fillText = (t, { first_name, class_year, ly }) => {
  const out = String(t || '').replace(/\{\{\s*(first_name|class_year|ly_gift)\s*\}\}/g, (m, k) =>
    k === 'first_name' ? first_name || '' : k === 'class_year' ? class_year || '' : ly ? '$' + Math.round(ly).toLocaleString('en-US') : '')
    .replace(/^\s*[,;:]\s*/, '').replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
};

// What this donor's gift did: their audience text, the challenges they count toward (with progress), and where their
// class or grade stands. Before the campaign opens none of the campaign numbers are shown (the public page is hidden too).
// deps: { campaign, audiences, audienceFor, qualifies }; profile: { first_name, tags, grades, class_year, ly }.
function buildPersonalization(gift, profile, deps) {
  const out = { audience: null, challenges: [], standing: [] };
  const { campaign, audiences, audienceFor, qualifies } = deps || {};
  if (audiences && audienceFor && qualifies) {
    const a = audienceFor(audiences, profile, qualifies);
    if (a) out.audience = { heading: fillText(a.heading, profile), body: fillText(a.body, profile) };
  }
  if (!campaign || !campaign.settings || Date.now() < new Date(campaign.settings.starts_at).getTime()) return out;
  const at = new Date(gift.created_at || Date.now()).getTime();
  for (const c of campaign.challenges || []) {
    if (!qualifies(c, profile)) continue;
    const lo = c.starts_at ? new Date(c.starts_at).getTime() : -Infinity, hi = c.ends_at ? new Date(c.ends_at).getTime() : Infinity;
    if (at < lo || at >= hi) continue;
    const cur = Number(c.current_value), target = Number(c.target), match = c.kind === 'match', done = !match && cur >= target;
    out.challenges.push({
      name: c.name, match, done, pct: Math.max(2, Math.min(100, Math.round(cur / target * 100))),
      prize: match ? target : Number(c.prize || 0),
      line: match ? `${money(cur).replace('.00', '')} of ${money(target).replace('.00', '')} matched`
        : done ? `${target} of ${target} ${c.unit || 'donors'}: goal met!`
        : `${cur} of ${target} ${c.unit || 'donors'} · ${target - cur} to go`,
    });
  }
  const wall = campaign.wall || {}, isAlum = (profile.tags || []).some(t => t === 'alumni' || t === 'alumna');
  const classes = wall.classes || {};
  if (isAlum && profile.class_year && classes[profile.class_year]) {
    const n = classes[profile.class_year], rank = 1 + Object.values(classes).filter(v => v > n).length;
    out.standing.push(`Class of ${profile.class_year}: ${n} donor${n === 1 ? '' : 's'} so far, #${rank} among classes`);
  }
  if ((profile.tags || []).includes('current_parent')) {
    for (const gr of profile.grades || []) {
      const n = (wall.grades || {})[gr];
      if (n) out.standing.push(`${gr === 'K' ? 'Kindergarten' : 'Grade ' + gr} parents: ${n} donor${n === 1 ? '' : 's'} so far`);
    }
  }
  return out;
}

const audienceCard = a => !a || (!a.heading && !a.body) ? '' : `
    <div style="margin:4px 0 20px;background-color:#EEF1F6;border-top:4px solid #FCB104;padding:16px 22px 14px;">
      ${a.heading ? `<p style="margin:0 0 6px;font-size:17px;font-weight:bold;color:#02193B;">${esc(a.heading)}</p>` : ''}
      ${a.body ? `<p style="margin:0;font-size:15px;line-height:1.65;color:#333;">${esc(a.body)}</p>` : ''}
    </div>`;

const impactCard = p => {
  const ch = p.challenges || [], st = p.standing || [];
  if (!ch.length && !st.length) return '';
  const rows = ch.map(c => `
        <div style="margin:0 0 14px;">
          <div style="font-size:15px;font-weight:bold;color:#02193B;">${esc(c.name)}${c.prize ? ` <span style="font-weight:normal;color:#787878;font-size:13px;">&middot; ${money(c.prize).replace('.00', '')} ${c.match ? 'match' : 'bonus'}</span>` : ''}</div>
          <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:6px 0 4px;"><tr>
            <td style="height:8px;background-color:#FCB104;width:${c.pct}%;font-size:0;line-height:0;">&nbsp;</td>
            <td style="height:8px;background-color:#E4E2DC;font-size:0;line-height:0;">&nbsp;</td></tr></table>
          <div style="font-family:Arial,sans-serif;font-size:12px;color:#555;">${esc(c.line)}</div>
        </div>`).join('');
  const standing = st.length ? `<div style="font-family:Arial,sans-serif;font-size:13px;color:#02193B;line-height:1.7;${ch.length ? 'border-top:1px solid #E4E2DC;padding-top:10px;' : ''}">${st.map(x => '&#9679; ' + esc(x)).join('<br>')}</div>` : '';
  return `
    <div style="margin:4px 0 22px;background-color:#ffffff;border:1px solid #E4E2DC;border-top:4px solid #FCB104;padding:16px 22px 14px;">
      <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase;color:#02193B;padding-bottom:10px;">${ch.length ? 'Your gift counts toward' : 'Where your community stands'}</div>
      ${rows}${standing}
    </div>`;
};

// ── Donor confirmation ───────────────────────────────────────────────────────
// Mirrors the Giving Days page: navy header with the seal and wordmark, white main area with the logo and a
// yellow-highlighted headline, white cards with yellow top edges, yellow button, navy footer with a yellow top edge.
// Email-safe: tables/inline styles, Georgia standing in for the page's Lora, images served from the site.
function renderConfirmation(g, p) {
  p = p || {};
  const amount = money(g.amount), first = esc(g.first_name || 'friend');
  const society = Number(g.amount) >= 1709
    ? `<p style="margin:0 0 16px;color:#444;">Gifts of $1,709 or more are recognized in the <strong style="color:#02193B;">1709 Society</strong>, and we are delighted to have you among its members.</p>` : '';
  const test = g.is_test
    ? `<div style="background-color:#FCB104;color:#02193B;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;text-align:center;padding:10px 16px;">TEST GIFT. This is a test of the gift confirmation email. Nothing was charged.</div>` : '';
  const td = (k, v, bold) => `<tr><td style="padding:9px 18px 9px 0;border-top:1px solid #E4E2DC;color:#787878;font-size:13px;font-family:Arial,sans-serif;">${k}</td><td style="padding:9px 0;border-top:1px solid #E4E2DC;color:#02193B;font-size:14px;${bold ? 'font-weight:bold;' : ''}">${v}</td></tr>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head>
<body style="margin:0;padding:0;background-color:#f0ede8;">
<div style="max-width:600px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#222;background-color:#ffffff;">
  ${test}
  <!-- Header: the page's navy bar with the seal and wordmark -->
  <div style="background-color:#02193B;border-bottom:3px solid #FCB104;padding:12px 24px;">
    <table cellpadding="0" cellspacing="0" align="center" style="border-collapse:collapse;"><tr>
      <td style="padding-right:12px;vertical-align:middle;"><img src="${SITE}/seal-reverse.png" alt="" width="32" height="34" style="display:block;"></td>
      <td style="vertical-align:middle;text-align:left;line-height:1.2;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;font-weight:bold;color:#ffffff;">Trinity <em style="color:#FCB104;">Giving Days</em></div>
        <div style="font-family:Arial,sans-serif;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#ffffff;margin-top:3px;">November 30 &ndash; December 4, 2026</div>
      </td>
    </tr></table>
  </div>
  <!-- Main (white) -->
  <div style="background-color:#ffffff;padding:30px 32px 6px;text-align:center;">
    <img src="${SITE}/giving-days-email-logo.png" alt="Trinity School Giving Days" width="280" style="display:inline-block;max-width:100%;height:auto;">
    <h1 style="margin:22px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.25;font-weight:bold;color:#02193B;">Thank you, <span style="border-bottom:5px solid #FCB104;">${first}</span>.</h1>
  </div>
  <div style="padding:18px 32px 6px;font-size:16px;line-height:1.7;background-color:#ffffff;">
    <p style="margin:0 0 16px;color:#444;">Thank you for your gift of <strong style="color:#02193B;">${amount}</strong> to the Trinity Fund during Trinity Giving Days. Every gift, at every level, supports Trinity students and teachers, and your support means a great deal to our whole community.</p>
    ${society}
    ${audienceCard(p.audience)}${impactCard(p)}
    <p style="margin:0 0 16px;color:#444;">Giving Days run from November 30 to December 4. Follow along as our community comes together at <a href="${SITE}" style="color:#02193B;font-weight:bold;">giving.trinityschoolnyc.org</a>.</p>
    <p style="margin:0 0 16px;color:#444;">If you have any questions about your gift, please write to us at <a href="mailto:trinityfund@trinityschoolnyc.org" style="color:#02193B;">trinityfund@trinityschoolnyc.org</a>.</p>
    <p style="margin:0 0 4px;color:#444;">With gratitude,</p>
    <p style="margin:0 0 26px;color:#02193B;font-weight:bold;">Oz, Francie, Abigail, Li-An, Migdalia, Philip, Sarah and Andrew<br><span style="font-weight:normal;color:#787878;">Trinity School Advancement Office</span></p>
  </div>
  <!-- Gift card: white with a yellow top edge, like the page's cards -->
  <div style="padding:0 32px 22px;background-color:#ffffff;">
    <div style="background-color:#ffffff;border:1px solid #E4E2DC;border-top:4px solid #FCB104;padding:16px 22px 12px;">
      <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase;color:#02193B;padding-bottom:8px;">Your gift</div>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
        ${td('Amount', amount, true)}
        ${td('Fund', 'Trinity Fund')}
        ${td('Date', esc(when(g.created_at)))}
        ${td('Transaction ID', esc(g.transaction_id))}
      </table>
    </div>
  </div>
  <!-- Matching gifts: warm-gray card, yellow top edge, yellow button -->
  <div style="padding:0 32px 34px;background-color:#ffffff;">
    <div style="background-color:#F4F2ED;border-top:4px solid #FCB104;padding:20px 24px 24px;">
      <p style="margin:0 0 6px;font-size:17px;font-weight:bold;color:#02193B;">Double your impact with a matching gift.</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#444;">Many companies match employee donations to schools like Trinity, so your gift could be worth twice as much at no extra cost to you.</p>
      <a href="https://www.trinityschoolnyc.org/support-trinity/matching-gifts" style="display:inline-block;background-color:#FCB104;color:#02193B;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;padding:14px 26px;text-decoration:none;">Check if your employer matches &rarr;</a>
    </div>
  </div>
  <!-- Footer: navy with a yellow top edge, seal and address like the page -->
  <div style="background-color:#02193B;border-top:4px solid #FCB104;padding:24px 32px 26px;text-align:center;font-family:Arial,sans-serif;">
    <img src="${SITE}/seal-reverse.png" alt="" width="38" height="40" style="display:inline-block;">
    <p style="margin:10px 0 4px;font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:bold;color:#ffffff;">Trinity School</p>
    <p style="margin:0 0 14px;font-size:12px;color:#ffffff;">139 West 91st Street &middot; New York, NY 10024</p>
    <p style="margin:0;font-size:11px;color:#ffffff;line-height:1.7;">You received this email because you made a gift to the Trinity Fund.<br>Questions? <a href="mailto:trinityfund@trinityschoolnyc.org" style="color:#FCB104;">trinityfund@trinityschoolnyc.org</a> &middot; (212) 932-6860</p>
  </div>
</div>
</body></html>`;
}

// ── Staff notification ───────────────────────────────────────────────────────
function renderStaff(g, donor) {
  const row = (k, v, strong) => `<tr style="border-bottom:1px solid #eee;"><td style="color:#666;width:140px;">${k}</td><td style="color:#222;">${strong ? '<strong>' + v + '</strong>' : v}</td></tr>`;
  const conn = connections(g);
  const known = donor && donor.re_id
    ? `Yes: <a href="${RE_RECORD_URL(donor.re_id)}" style="color:#02193B;">open in Raiser's Edge (${esc(donor.re_id)})</a>` : (g.donor_id ? 'Yes (record linked)' : 'No match found');
  return `<div style="max-width:560px;margin:0 auto;font-family:Arial,sans-serif;font-size:14px;color:#222;background-color:#ffffff;">
  <div style="background-color:#02193B;color:#ffffff;padding:16px 24px;border-bottom:3px solid #FCB104;"><strong style="font-size:16px;color:#ffffff;">New gift: Giving Days 2026${g.is_test ? ' (TEST)' : ''}</strong></div>
  <div style="padding:20px 24px;"><table cellpadding="7" style="border-collapse:collapse;width:100%;">
    ${row('Donor', esc((g.first_name || '') + ' ' + (g.last_name || '')), true)}
    ${row('Email', esc(g.email || '—'))}
    ${row('Amount', esc(money(g.amount)), true)}
    ${row('Connections', conn.length ? esc(conn.join('; ')) : '—')}
    ${row('In our records', known)}
    ${row('Anonymous', g.anonymous ? 'Yes, list as anonymous' : 'No')}
    ${row('Mode', g.is_test ? 'TEST (nothing charged)' : 'Live')}
    ${row('Date', esc(when(g.created_at)))}
    ${row('Transaction ID', esc(g.transaction_id))}
  </table></div></div>`;
}

// ── Sending ──────────────────────────────────────────────────────────────────
async function send(opts, label) {
  if (!resend) { console.warn(`[GD email] ${label}: RESEND_API_KEY is not set, nothing sent.`); return false; }
  try {
    const { error } = await resend.emails.send({ from: FROM, replyTo: REPLY_TO, ...opts });
    if (error) { console.error(`[GD email] ${label} failed:`, error); return false; }
    console.log(`[GD email] ${label} sent to ${Array.isArray(opts.to) ? opts.to.join(', ') : opts.to}`);
    return true;
  } catch (err) { console.error(`[GD email] ${label} failed:`, err.message || err); return false; }
}

// Both emails for a saved gift. Never throws: the donor's payment is already captured.
async function sendGiftEmails(gift, donor, personal) {
  const test = !!gift.is_test, tag = test ? '[TEST] ' : '';
  const confirmation = gift.email || test
    ? await send({
        to: test ? testAddress() : gift.email,
        subject: tag + 'Thank you for your gift to the Trinity Fund',
        html: renderConfirmation(gift, personal),
      }, 'confirmation')
    : false;
  const staff = await send({
    to: test ? testAddress() : staffList(),
    subject: `[Giving Days${test ? ' TEST' : ''}] ${money(gift.amount)} — ${gift.first_name || ''} ${gift.last_name || ''}`.trim(),
    html: renderStaff(gift, donor),
  }, 'staff notification');
  return { confirmation, staff };
}

// The payment was captured but the gift could not be saved: confirm to the donor and tell staff to enter it by hand.
async function sendUnrecordedGiftAlert(gift) {
  const test = !!gift.is_test;
  if (test || gift.email) {
    await send({
      to: test ? testAddress() : gift.email,
      subject: (test ? '[TEST] ' : '') + 'Thank you for your gift to the Trinity Fund',
      html: renderConfirmation(gift),
    }, 'confirmation (unrecorded gift)');
  }
  return send({
    to: test ? testAddress() : staffList(),
    subject: `[Giving Days${test ? ' TEST' : ''}] ACTION NEEDED: gift captured but not saved — ${money(gift.amount)}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;max-width:560px;"><p><strong>A payment was captured but could not be saved to the database.</strong> Please add it by hand (Giving Days admin, or the BBMS transaction below).</p>
      <pre style="background:#f6f6f6;padding:12px;white-space:pre-wrap;">${esc(JSON.stringify({ transaction_id: gift.transaction_id, amount: gift.amount, first_name: gift.first_name, last_name: gift.last_name, email: gift.email, anonymous: gift.anonymous, declared_tags: gift.declared_tags, grades: gift.grades, class_year: gift.class_year }, null, 2))}</pre></div>`,
  }, 'unrecorded-gift alert');
}

module.exports = { sendGiftEmails, sendUnrecordedGiftAlert, buildPersonalization, renderConfirmation, renderStaff };
