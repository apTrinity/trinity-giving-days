// Email staff when a nightly job needs a look (sync blocked or failed, Mailchimp blocked, stale tags removed).
// Uses the same Resend account as the rest of the app. Never throws: an alert must not break the job it reports on.
// Goes to GD_ALERT_EMAIL (comma separated), else GD_TEST_EMAIL, else the default below.

const DEFAULT_TO = 'andrew.peterson@trinityschoolnyc.org';
const esc = v => String(v).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

async function alertStaff(subject, lines) {
  try {
    if (!process.env.RESEND_API_KEY) { console.warn('[GD alert] not sent, RESEND_API_KEY missing:', subject); return false; }
    const { Resend } = require('resend');
    const to = (process.env.GD_ALERT_EMAIL || process.env.GD_TEST_EMAIL || DEFAULT_TO).split(',').map(s => s.trim()).filter(Boolean);
    const list = (lines || []).map(String);
    await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: 'Trinity Fund <trinityfund@trinityschoolnyc.org>', to, subject,
      html: `<p>${list.slice(0, 60).map(esc).join('<br>')}</p>${list.length > 60 ? `<p>…and ${list.length - 60} more. See the Integration settings tab of the admin page.</p>` : ''}`,
    });
    return true;
  } catch (e) { console.warn('[GD alert] email failed:', e.message); return false; }
}

module.exports = { alertStaff };
