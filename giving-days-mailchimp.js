// Giving Days -> Mailchimp: keeps the Mailchimp audience in step with the donor table.
//
// PREVIEW reads Mailchimp and the donor table and changes nothing in either.
// APPLY (only after a preview has been run on this server, and only when the preview has no blocking problems):
//   - adds people who are not in Mailchimp yet (first and last name are set ONLY for these new contacts)
//   - adds the tags "Gave 26-27" (household has given this year) and "Appeal: <code>" (RE appeal code),
//     and removes them again when they stop being true. No other tag on a contact is ever touched.
//   - saves each person's RE ID in the RE_ID merge field, so a changed email can be recognised later
//   - saves each person's personal-link CODE (6 characters, e.g. k7m2xp) in the PURL merge field; in an email the link is
//     https://giving.trinityschoolnyc.org/*|PURL|* . It is the same person whose RE ID is saved
//   - archives an old address only when the same RE ID now has a different email AND nobody else here uses the old one
//   - sets an existing contact's FIRST name to the RE preferred (nickname) name, else RE first name (never when it contains a broken
//     accent, and not when the last names differ: that may be a different person on the address). Last names are only filled when blank.
//     A name with broken accents from an old import ("Pi\ufffdero") is repaired from RE when everything else about it matches.
// It never re-subscribes anyone (unsubscribed, cleaned and other non-subscribed contacts are left alone),
// never deletes anyone, and never changes an existing contact's LAST name (blank ones are filled).
//
// Needs on Render: MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX (e.g. us12), MAILCHIMP_AUDIENCE_ID.
// Optional: MAILCHIMP_NEW_STATUS (default "subscribed"), MAILCHIMP_MAX_ADDS (default 500), MAILCHIMP_MAX_ARCHIVES (default 100),
//           GD_MAILCHIMP_SCHEDULE=on (nightly apply at 4 a.m. Eastern, after one manual apply).
// The key is used only here on the server and is never sent to the browser.

const axios = require('axios');
const crypto = require('crypto');
const { fetchAll } = require('./giving-days-progress');
const { alertStaff } = require('./giving-days-alert');

const GAVE_TAG = 'Gave 26-27';
const APPEAL_PREFIX = 'Appeal: ';
const appealTag = code => APPEAL_PREFIX + code;
const lc = v => String(v || '').trim().toLowerCase();
const purlOf = d => (d && d.token ? String(d.token).toLowerCase() : '');   // just the 6-character code; the email builds the link: giving.trinityschoolnyc.org/*|PURL|*
const hashOf = email => crypto.createHash('md5').update(lc(email)).digest('hex');

function config() {
  const key = process.env.MAILCHIMP_API_KEY, dc = process.env.MAILCHIMP_SERVER_PREFIX, list = process.env.MAILCHIMP_AUDIENCE_ID;
  const missing = [!key && 'MAILCHIMP_API_KEY', !dc && 'MAILCHIMP_SERVER_PREFIX', !list && 'MAILCHIMP_AUDIENCE_ID'].filter(Boolean);
  const newStatus = ['subscribed', 'pending'].includes(lc(process.env.MAILCHIMP_NEW_STATUS)) ? lc(process.env.MAILCHIMP_NEW_STATUS) : 'subscribed';
  const maxAdds = parseInt(process.env.MAILCHIMP_MAX_ADDS || '500', 10), maxArchives = parseInt(process.env.MAILCHIMP_MAX_ARCHIVES || '100', 10);
  const maxStale = parseInt(process.env.MAILCHIMP_MAX_STALE || '200', 10), maxUntag = parseInt(process.env.MAILCHIMP_MAX_UNTAG || '200', 10);
  const maxNames = parseInt(process.env.MAILCHIMP_MAX_NAME_UPDATES || '600', 10);
  const maxSyncAgeH = parseFloat(process.env.MAILCHIMP_MAX_SYNC_AGE_H || '6');
  const overwritePurl = lc(process.env.MAILCHIMP_OVERWRITE_PURL) !== 'off';   // the PURL field belongs to this sync: older values are replaced (set to 'off' to leave them)
  return { overwritePurl, maxNames, key, dc, list, missing, newStatus, maxAdds, maxArchives, maxStale, maxUntag, maxSyncAgeH };
}

const base = c => `https://${c.dc}.api.mailchimp.com/3.0/lists/${c.list}`;
const authOf = c => ({ username: 'giving-days', password: c.key });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mailchimp's gateway sometimes answers 504/502/503 or 429 on big requests: wait and try again (up to 6 tries).
async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const st = e.response && e.response.status;
      const transient = !e.response || st === 429 || (st >= 500 && st <= 599) || e.code === 'ECONNABORTED' || e.code === 'ECONNRESET';
      if (!transient || attempt >= 6) throw e;
      const wait = Math.min(30000, 2000 * attempt * attempt);
      console.warn(`[GD mailchimp] ${label || 'request'} failed (${st || e.code}), retry ${attempt} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function fetchMembers(c) {
  const PAGE = 500;   // smaller pages: 1,000 at once was timing out at Mailchimp's gateway
  const out = [];
  let total = null;
  for (let offset = 0; ; offset += PAGE) {
    const r = await withRetry(() => axios.get(`${base(c)}/members`, {
      auth: authOf(c), timeout: 90000,
      params: { count: PAGE, offset, fields: 'total_items,members.email_address,members.status,members.merge_fields,members.tags' },
    }), `read members at ${offset}`);
    total = r.data.total_items;
    out.push(...(r.data.members || []));
    if (!r.data.members || r.data.members.length < PAGE || out.length >= total) break;
  }
  return out;
}

// ---- Why does a Mailchimp name differ from the donor table? (informational only: names are never overwritten) ----
const NICK = [['laurence','lawrence','larry','laurie'],['leopold','leo'],['alexander','alec','alex','xander'],['harold','harry','hal'],['frederick','rick','ricky','fred'],['stephenson','steve','tony'],['morton','mort','buddy'],['diana','diane','di','darcy'],['william','bill','billy','will','willy','liam'],['robert','bob','bobby','rob','robbie','bert'],['richard','rick','ricky','rich','dick'],['james','jim','jimmy','jamie'],
  ['john','jack','johnny','jon'],['michael','mike','mikey','mick'],['thomas','tom','tommy'],['charles','chuck','charlie','chaz'],['joseph','joe','joey'],['daniel','dan','danny'],
  ['matthew','matt'],['anthony','tony'],['christopher','chris','kit'],['nicholas','nick','nicky'],['edward','ed','eddie','ted','ned'],['benjamin','ben','benny'],['samuel','sam','sammy'],
  ['alexander','alex','sandy','xander'],['andrew','andy','drew'],['jonathan','jon','jonny'],['stephen','steven','steve'],['timothy','tim','timmy'],['patrick','pat','paddy'],['peter','pete'],
  ['gregory','greg'],['kenneth','ken','kenny'],['lawrence','larry'],['theodore','ted','theo'],['frederick','fred','freddie'],['david','dave','davey'],['douglas','doug'],['donald','don'],
  ['elizabeth','liz','lizzie','beth','betsy','eliza','betty','libby'],['katherine','catherine','kathryn','kate','katie','kathy','cathy','kitty','cat'],['margaret','meg','maggie','peggy','marge','greta'],
  ['jennifer','jen','jenny'],['jessica','jess','jessie'],['susan','sue','susie'],['deborah','debbie','deb'],['patricia','pat','patty','trish'],['barbara','barb','barbie'],['rebecca','becky','becca'],
  ['victoria','vicky','vicki','tori'],['christine','christina','chris','chrissy','tina'],['stephanie','steph'],['alexandra','alex','sandra','sasha','lexi'],['samantha','sam','sammy'],['abigail','abby'],
  ['amanda','mandy'],['kimberly','kim'],['pamela','pam'],['cynthia','cindy'],['judith','judy'],['carolyn','carol','carrie'],['suzanne','susan','suzy','sue'],['joanne','joan','jo'],['nancy','nan'],
  ['gabrielle','gaby','gabby'],['caroline','carrie','caro'],['eleanor','ellie','nell','nora'],['rachel','rach'],['lauren','laurie'],['jacqueline','jackie','jacqui'],['alexis','lexi','alex'],['isabel','isabella','izzy','bella']];
const NICK_OF = new Map();
for (const g of NICK) for (const a of g) { if (!NICK_OF.has(a)) NICK_OF.set(a, new Set()); g.forEach(b => b !== a && NICK_OF.get(a).add(b)); }
const letters = v => lc(v).replace(/[^a-z\u00c0-\u024f]/g, '');
// A Mailchimp name with broken accents ("Pi\ufffdero") that matches the clean RE name ("Pi\u00f1ero") everywhere else is the same name, damaged by an old import.
const brokenMatch = (mc, ours) => {
  const a = String(mc || '').trim(), b = String(ours || '').trim();
  return a.includes('\ufffd') && !!b && !b.includes('\ufffd') && new RegExp('^' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\ufffd/g, '.') + '$', 'i').test(b);
};
function nameKind(mf, w) {
  const a1 = String(mf.FNAME || '').trim(), a2 = String(mf.LNAME || '').trim(), b1 = w.first, b2 = w.last;
  if (!a1 || !a2) return 'blank_in_mailchimp';
  const okF = letters(a1) === letters(b1) || brokenMatch(a1, b1), okL = letters(a2) === letters(b2) || brokenMatch(a2, b2);
  if (okF && okL && (brokenMatch(a1, b1) || brokenMatch(a2, b2))) return 'broken_accent_in_mailchimp';
  if (letters(a1) === letters(b1) && letters(a2) === letters(b2)) return 'case_or_punctuation';
  if (/\s(&|and)\s/i.test(a1 + ' ' + b1) || (a1.includes('&') !== b1.includes('&'))) return 'couple_or_combined';
  const sameLast = letters(a2) === letters(b2), sameFirst = letters(a1) === letters(b1);
  if (sameFirst) return 'last_name_differs';
  if (!sameLast) return 'both_differ';
  const toks = v => lc(v).split(/[\s.]+/).map(t => t.replace(/[^a-z\u00c0-\u024f]/g, '')).filter(Boolean);
  const ta = toks(a1), tb = toks(b1);
  if ((tb.length && tb.every(t => ta.includes(t))) || (ta.length && ta.every(t => tb.includes(t)))) return 'middle_name_or_initial';   // "W. Nelson" vs "Nelson", "Mara Anne" vs "Mara"
  const x = letters(a1), y = letters(b1);
  if (x.length === 1 || y.length === 1) return 'middle_name_or_initial';
  const near = (NICK_OF.get(x) && NICK_OF.get(x).has(y)) || (x.length >= 2 && y.length >= 2 && (x.startsWith(y) || y.startsWith(x)));
  return near ? 'nickname_or_short_form' : 'first_name_differs';
}
const NAME_KIND_LABEL = { broken_accent_in_mailchimp: 'Broken accent in Mailchimp (repaired from RE)', middle_name_or_initial: 'Extra middle name or initial in one of them (same name otherwise)', case_or_punctuation: 'Capitalization or punctuation only', nickname_or_short_form: 'Nickname or short form of the first name', first_name_differs: 'Different first name (not an obvious nickname)',
  last_name_differs: 'Last name differs (same first name)', both_differ: 'First and last name both differ', couple_or_combined: 'Couple or combined names ("A & B")', blank_in_mailchimp: 'First or last name blank in Mailchimp' };

// Pure planning step (easy to test): donors + gift info + current Mailchimp members -> { report, actions }.
// donors: active gd_donors rows. gaveHouseholds: Set of household ids who have given this year.
function plan(donors, gaveHouseholds, members, limits = {}) {
  const hh = d => d.household_re_id || d.re_id;
  donors = [...donors].sort((x, y) => String(x.re_id).localeCompare(String(y.re_id), 'en', { numeric: true }));   // fixed order: a couple sharing an email gets the same RE ID and code every night
  const byEmail = new Map();
  let noEmail = 0;
  for (const d of donors) {
    if (!lc(d.email)) { noEmail++; continue; }
    const e = lc(d.email);
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(d);
  }
  const want = new Map();   // email -> { first, last, appeal, gave, reid }
  for (const [e, a] of byEmail) {
    const lasts = [...new Set(a.map(x => x.last_name || '').filter(Boolean))];
    want.set(e, {
      email: e,
      first: a.length === 1 ? (a[0].first_name || '') : a.map(x => x.first_name || '').filter(Boolean).join(' & '),
      last: a.length === 1 ? (a[0].last_name || '') : lasts.join(' / '),
      appeal: (a.find(x => x.appeal_code) || {}).appeal_code || null,
      gave: a.some(x => gaveHouseholds.has(hh(x))),
      reid: String(a[0].re_id),
      purl: purlOf(a[0]),   // a couple sharing one email shares one link: the first person's, the same one whose RE ID is saved
    });
  }
  const have = new Map(members.map(m => [lc(m.email_address), m]));
  const donorByReId = new Map(donors.map(d => [String(d.re_id), d]));
  const r = { donors_with_email: want.size, donors_without_email: noEmail, mailchimp_members: members.length,
    already_in_mailchimp: 0, would_add: 0, skipped_not_subscribed: 0, name_differs: 0,
    gave_total: 0, would_tag_gave: 0, would_untag_gave: 0, would_tag_appeal: 0, would_untag_appeal: 0, would_set_reid: 0, would_set_purl: 0, would_set_fname: 0, would_repair_lname: 0, fname_left: 0, purl_other_left: 0, would_archive: 0, would_untag_stale: 0, mailchimp_only: 0,
    status_counts: {}, name_kinds: {}, blocking: [],
    examples: { name_by_kind: {}, purl_other: [], would_add: [], name_differs: [], mailchimp_only: [], skipped_not_subscribed: [], would_archive: [], stale_tags: [] } };
  const actions = { adds: [], updates: [], removals: [], archives: [] };
  const names = [];   // every name that differs, for the download
  const push = (k, v) => { if (r.examples[k].length < 15) r.examples[k].push(v); };
  for (const m of members) r.status_counts[m.status] = (r.status_counts[m.status] || 0) + 1;

  for (const w of want.values()) {
    if (w.gave) r.gave_total++;
    const tagsWanted = [];
    if (w.gave) tagsWanted.push(GAVE_TAG);
    if (w.appeal) tagsWanted.push(appealTag(w.appeal));
    const m = have.get(w.email);
    if (!m) {
      r.would_add++; push('would_add', `${w.first} ${w.last} <${w.email}>`.trim());
      actions.adds.push({ email: w.email, first: w.first, last: w.last, reid: w.reid, purl: w.purl, tags: tagsWanted });
      if (w.gave) r.would_tag_gave++;
      if (w.appeal) r.would_tag_appeal++;
      continue;
    }
    r.already_in_mailchimp++;
    if (m.status !== 'subscribed') {   // unsubscribed, cleaned, pending, transactional: never touched
      r.skipped_not_subscribed++; push('skipped_not_subscribed', `${w.email} (${m.status})`); continue;
    }
    const mf = m.merge_fields || {}, tags = (m.tags || []).map(t => t.name);
    let fixFirst = null, fixLast = null;   // Mailchimp's FIRST name follows RE: the preferred (nickname) name if there is one, else the first name
    if (lc(mf.FNAME) !== lc(w.first) || lc(mf.LNAME) !== lc(w.last) || String(mf.FNAME || '').trim() !== w.first) {
      const kind = nameKind(mf, w);
      const clean = !!w.first && !/\ufffd/.test(w.first + w.last);   // never write a name with a broken accent into Mailchimp
      const sameWho = kind !== 'last_name_differs';   // same first name, different last name: left alone. First AND last differing is a spouse with their own surname: RE's person on the address wins   // a different last name may be a different person on that address: leave those
      const caseOnlyJunk = lc(mf.FNAME) === lc(w.first) && (w.first === w.first.toLowerCase() || w.first === w.first.toUpperCase());   // RE has "bill" or "BILL": keep Mailchimp's capitalization
      if (kind === 'broken_accent_in_mailchimp') {   // repair only the broken field(s); the other side already matches
        if (clean && brokenMatch(mf.FNAME, w.first)) { fixFirst = w.first; r.would_set_fname++; }
        if (clean && brokenMatch(mf.LNAME, w.last)) { fixLast = w.last; r.would_repair_lname++; }
      }
      else if (clean && sameWho && !caseOnlyJunk && String(mf.FNAME || '').trim() !== w.first) {
        fixFirst = w.first; r.would_set_fname++;
        if (kind === 'both_differ' && w.last) fixLast = w.last;   // the whole name changes to the spouse RE lists on this address, so no "Fiona Guan"
      }
      else if (kind !== 'broken_accent_in_mailchimp' && !caseOnlyJunk && String(mf.FNAME || '').trim() !== w.first) r.fname_left++;
      if (clean && kind === 'blank_in_mailchimp' && !String(mf.LNAME || '').trim() && w.last) fixLast = w.last;
      r.name_kinds[kind] = (r.name_kinds[kind] || 0) + 1;
      const ex = r.examples.name_by_kind[kind] || (r.examples.name_by_kind[kind] = []);
      if (ex.length < 15) ex.push(`${mf.FNAME || ''} ${mf.LNAME || ''} -> ${w.first} ${w.last}`.replace(/\s+/g, ' ').trim());
      names.push({ email: w.email, kind: NAME_KIND_LABEL[kind], fix: fixFirst || fixLast ? 'yes' : 'no', mc_first: mf.FNAME || '', mc_last: mf.LNAME || '', here_first: w.first, here_last: w.last });
      r.name_differs++; push('name_differs', `${w.email}: Mailchimp "${(mf.FNAME || '') + ' ' + (mf.LNAME || '')}" -> "${w.first} ${w.last}"`); }
    const addTags = tagsWanted.filter(t => !tags.includes(t));
    const remove = tags.filter(t => (t === GAVE_TAG && !w.gave) || (t.startsWith(APPEAL_PREFIX) && t !== (w.appeal ? appealTag(w.appeal) : null)));
    if (w.gave && !tags.includes(GAVE_TAG)) r.would_tag_gave++;
    if (!w.gave && tags.includes(GAVE_TAG)) r.would_untag_gave++;
    if (w.appeal && !tags.includes(appealTag(w.appeal))) r.would_tag_appeal++;
    r.would_untag_appeal += remove.filter(t => t.startsWith(APPEAL_PREFIX)).length;
    const setReid = String(mf.RE_ID || '') !== w.reid;
    if (setReid) r.would_set_reid++;
    // PURL holds just the code. Anything else in it (older links) is replaced, unless MAILCHIMP_OVERWRITE_PURL=off.
    const curPurl = String(mf.PURL || '').trim();
    const foreignPurl = !!curPurl && !/^[a-hj-km-np-z2-9]{6}$/i.test(curPurl);
    if (w.purl && foreignPurl && !limits.overwritePurl) { r.purl_other_left++; push('purl_other', `${w.email}: ${curPurl.slice(0, 90)}`); }
    const setPurl = !!w.purl && curPurl !== w.purl && (!foreignPurl || !!limits.overwritePurl);
    if (setPurl) r.would_set_purl++;
    if (addTags.length || setReid || setPurl || fixFirst || fixLast) actions.updates.push({ email: w.email, reid: setReid ? w.reid : null, purl: setPurl ? w.purl : null, fname: fixFirst, lname: fixLast, tags: addTags });
    if (remove.length) actions.removals.push({ email: w.email, remove });
  }

  // Changed email: a subscribed contact whose RE ID now has a different email, and no one else here uses the old address.
  for (const m of members) {
    const e = lc(m.email_address);
    if (want.has(e)) continue;   // someone here still uses this address
    r.mailchimp_only++; push('mailchimp_only', `${m.email_address} (${m.status})`);
    const rid = m.merge_fields && m.merge_fields.RE_ID ? String(m.merge_fields.RE_ID) : '';
    if (m.status !== 'subscribed') continue;
    const d = rid ? donorByReId.get(rid) : null;
    if (d && lc(d.email) && lc(d.email) !== e) {
      r.would_archive++; push('would_archive', `${m.email_address} -> ${d.email}`);
      actions.archives.push({ email: m.email_address, replacedBy: d.email });
      continue;
    }
    // Left the list (no appeal code / filtered out in RE): drop their old Appeal tags. Gave 26-27 is never removed here,
    // because someone who gave and then left the query still gave.
    const stale = (m.tags || []).map(t => t.name).filter(t => t.startsWith(APPEAL_PREFIX));
    if (stale.length) {
      r.would_untag_stale++; push('stale_tags', `${m.email_address}: ${stale.join(', ')}`);
      actions.removals.push({ email: m.email_address, remove: stale, stale: true });
    }
  }
  if (limits.maxAdds != null && actions.adds.length > limits.maxAdds) r.blocking.push(`${actions.adds.length} new contacts is more than the safety limit of ${limits.maxAdds} (MAILCHIMP_MAX_ADDS). Check the list, then raise the limit on Render.`);
  if (limits.maxUntag != null && r.would_untag_gave > limits.maxUntag) r.blocking.push(`${r.would_untag_gave} people would lose the Gave 26-27 tag, more than the safety limit of ${limits.maxUntag} (MAILCHIMP_MAX_UNTAG). A drop like that usually means the giving column went missing from the RE query: check the sync first.`);
  if (limits.maxUntag != null && r.would_untag_appeal > limits.maxUntag) r.blocking.push(`${r.would_untag_appeal} Appeal tags would be removed from people still on the list, more than the safety limit of ${limits.maxUntag} (MAILCHIMP_MAX_UNTAG). Check that the Appeal Code column is still in the RE query.`);
  if (limits.maxStale != null && r.would_untag_stale > limits.maxStale) r.blocking.push(`${r.would_untag_stale} people who left the list would lose their Appeal tag, more than the safety limit of ${limits.maxStale} (MAILCHIMP_MAX_STALE). That many at once usually means the RE query came back short: check the sync first.`);
  if (limits.maxNames != null && r.would_set_fname > limits.maxNames) r.blocking.push(`${r.would_set_fname} first names would change in Mailchimp, more than the safety limit of ${limits.maxNames} (MAILCHIMP_MAX_NAME_UPDATES). Check the "Names that differ" list, then raise the limit on Render.`);
  if (limits.maxArchives != null && actions.archives.length > limits.maxArchives) r.blocking.push(`${actions.archives.length} archives is more than the safety limit of ${limits.maxArchives} (MAILCHIMP_MAX_ARCHIVES).`);
  return { report: r, actions, names };
}

// ---- Apply helpers (talk to Mailchimp) ----
// Creates the RE_ID and PURL merge fields if they are not there yet. Returns the tags it created.
async function ensureMergeFields(c) {
  const r = await withRetry(() => axios.get(`${base(c)}/merge-fields`, { auth: authOf(c), params: { count: 100, fields: 'merge_fields.tag' }, timeout: 60000 }), 'read merge fields');
  const have = new Set((r.data.merge_fields || []).map(f => f.tag));
  const made = [];
  for (const f of [{ tag: 'RE_ID', name: 'RE ID' }, { tag: 'PURL', name: 'Personal link' }]) {
    if (have.has(f.tag)) continue;
    await withRetry(() => axios.post(`${base(c)}/merge-fields`, { tag: f.tag, name: f.name, type: 'text', required: false, public: false }, { auth: authOf(c), timeout: 60000 }), `create ${f.tag} field`);
    made.push(f.tag);
  }
  return made;
}

async function batchUpsert(c, items, summary) {
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const r = await withRetry(() => axios.post(base(c), { members: chunk, update_existing: true }, { auth: authOf(c), timeout: 180000 }), `batch ${i}`);
    summary.created += r.data.total_created || 0;
    summary.updated += r.data.total_updated || 0;
    for (const e of (r.data.errors || [])) { summary.errors++; if (summary.error_examples.length < 10) summary.error_examples.push(`${e.email_address}: ${e.error}`); }
    await sleep(500);
  }
}

async function pool(items, size, fn) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) { const it = items[idx++]; await fn(it); }
  }));
}

const STARTED = new Date().toISOString();
module.exports = function mountGivingDaysMailchimp(app, { supabase, requireAdmin }) {
  let run = { state: 'idle' };
  let previewed = false, appliedOnce = false;
  let lastBlocking = [];
  let lastNames = [];   // every name that differs in the latest preview/apply (for the CSV download)
  let lastNightly = null;   // { at, outcome: 'applied' | 'blocked' | 'error', note }
  const scheduleOn = () => String(process.env.GD_MAILCHIMP_SCHEDULE || '').toLowerCase() === 'on';

  async function loadLocal() {
    const [donors, gifts] = await Promise.all([
      fetchAll(() => supabase.from('gd_donors').select('id, token, re_id, household_re_id, first_name, last_name, email, appeal_code, giving_ytd').eq('active', true).order('id')),
      fetchAll(() => supabase.from('gd_gifts').select('donor_id, email, is_test, excluded').order('id')),
    ]);
    const byId = new Map(donors.map(d => [d.id, d]));
    const byEmailD = new Map();
    for (const d of donors) if (lc(d.email) && !byEmailD.has(lc(d.email))) byEmailD.set(lc(d.email), d);
    const gave = new Set();
    for (const d of donors) if (Number(d.giving_ytd) > 0) gave.add(d.household_re_id || d.re_id);
    for (const g of gifts) {
      if (g.is_test || g.excluded) continue;
      const d = byId.get(g.donor_id) || (g.email && byEmailD.get(lc(g.email)));
      if (d) gave.add(d.household_re_id || d.re_id);
    }
    return { donors, gave };
  }
  async function load(cfg) {
    const [members, local] = await Promise.all([fetchMembers(cfg), loadLocal()]);
    return { members, ...local };
  }

  async function execute(apply, by) {
    const t0 = Date.now();
    run = { state: 'running', mode: apply ? 'apply' : 'preview', started: new Date().toISOString(), by };
    const cfg = config();
    const scrub = s => (cfg.key ? String(s).split(cfg.key).join('***') : String(s));
    try {
      if (cfg.missing.length) throw new Error('Not set on the server: ' + cfg.missing.join(', '));
      if (by === 'nightly') {   // never push tags from donor data that the RE sync did not refresh tonight
        const { data: last } = await supabase.from('gd_donors').select('synced_at').not('synced_at', 'is', null).order('synced_at', { ascending: false }).limit(1);
        const at = last && last[0] ? new Date(last[0].synced_at).getTime() : 0;
        if (!at || Date.now() - at > cfg.maxSyncAgeH * 3600000) {
          const why = `The RE sync has not run in the last ${cfg.maxSyncAgeH} hours (last: ${at ? new Date(at).toISOString() : 'never'}), so tonight's Mailchimp run was skipped.`;
          lastNightly = { at: new Date().toISOString(), outcome: 'blocked', note: why };
          run = { state: 'error', mode: 'apply', started: run.started, finished: new Date().toISOString(), error: why };
          await alertStaff('Mailchimp nightly sync skipped: RE sync is not recent', [why]);
          return;
        }
      }
      const { members, donors, gave } = await load(cfg);
      const { report, actions, names } = plan(donors, gave, members, { maxAdds: cfg.maxAdds, maxArchives: cfg.maxArchives, maxStale: cfg.maxStale, maxUntag: cfg.maxUntag, overwritePurl: cfg.overwritePurl, maxNames: cfg.maxNames });
      lastBlocking = report.blocking; lastNames = names;
      if (by === 'nightly' && report.blocking.length) { lastNightly = { at: new Date().toISOString(), outcome: 'blocked', note: report.blocking.join(' ') }; await alertStaff('Mailchimp nightly sync NOT applied', report.blocking); }
      if (!apply) {
        previewed = true;
        run = { state: 'done', mode: 'preview', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result: report };
        return;
      }
      if (report.blocking.length) {
        if (by === 'nightly') { run = { state: 'error', mode: 'apply', started: run.started, finished: new Date().toISOString(), error: 'Not applied: ' + report.blocking.join(' ') }; return; }   // already recorded and emailed above
        throw new Error('Not applied: ' + report.blocking.join(' '));
      }
      const summary = { created: 0, updated: 0, errors: 0, error_examples: [], tags_removed: 0, archived: 0, merge_fields_created: [] };
      summary.merge_fields_created = await ensureMergeFields(cfg);
      const upserts = [
        ...actions.adds.map(a => ({ email_address: a.email, status: cfg.newStatus, merge_fields: { FNAME: a.first, LNAME: a.last, RE_ID: a.reid, PURL: a.purl }, tags: a.tags })),
        ...actions.updates.map(u => { const o = { email_address: u.email, status: 'subscribed' }; const mf = {}; if (u.reid) mf.RE_ID = u.reid; if (u.purl) mf.PURL = u.purl; if (u.fname) mf.FNAME = u.fname; if (u.lname) mf.LNAME = u.lname; if (Object.keys(mf).length) o.merge_fields = mf; if (u.tags.length) o.tags = u.tags; return o; }),
      ];
      await batchUpsert(cfg, upserts, summary);
      await pool(actions.removals, 8, async x => {
        try {
          await withRetry(() => axios.post(`${base(cfg)}/members/${hashOf(x.email)}/tags`, { tags: x.remove.map(name => ({ name, status: 'inactive' })) }, { auth: authOf(cfg), timeout: 60000 }), 'remove tags');
          summary.tags_removed += x.remove.length;
        } catch (e) { summary.errors++; if (summary.error_examples.length < 10) summary.error_examples.push(`${x.email}: ${scrub(e.message)}`); }
      });
      await pool(actions.archives, 8, async x => {
        try { await withRetry(() => axios.delete(`${base(cfg)}/members/${hashOf(x.email)}`, { auth: authOf(cfg), timeout: 60000 }), 'archive'); summary.archived++; }
        catch (e) { summary.errors++; if (summary.error_examples.length < 10) summary.error_examples.push(`${x.email}: ${scrub(e.message)}`); }
      });
      appliedOnce = true;
      if (by === 'nightly') {
        lastNightly = { at: new Date().toISOString(), outcome: 'applied', note: `${summary.created} added, ${summary.updated} updated, ${summary.tags_removed} tags removed, ${summary.archived} archived, ${summary.errors} errors` };
        const stale = actions.removals.filter(x => x.stale).map(x => `${x.email}: lost ${x.remove.join(', ')}`);
        if (stale.length) await alertStaff(`Mailchimp nightly sync: ${stale.length} stale appeal tag${stale.length === 1 ? '' : 's'} removed`, ['These people left the giving list in Raiser\'s Edge, so their old Appeal tag was removed in Mailchimp:', ...stale]);
        // Contacts Mailchimp will never accept (permanently deleted, invalid address) fail the same way every night: not worth an email.
        const real = summary.error_examples.filter(e => !/permanently deleted|looks fake or invalid/i.test(e));
        if (real.length) await alertStaff(`Mailchimp nightly sync: ${real.length} new error${real.length === 1 ? '' : 's'}`, real);
      }
      console.log(`[GD mailchimp] applied by ${by}: +${summary.created} new, ${summary.updated} updated, ${summary.tags_removed} tags removed, ${summary.archived} archived, ${summary.errors} errors`);
      run = { state: 'done', mode: 'apply', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), result: report, applied: summary };
    } catch (err) {
      if (by === 'nightly') lastNightly = { at: new Date().toISOString(), outcome: 'error', note: scrub(err.message || String(err)).slice(0, 200) };
      if (by === 'nightly') alertStaff('Mailchimp nightly sync failed', [scrub(err.message || String(err))]);
      const detail = scrub(err.response ? `${err.response.status} ${JSON.stringify(err.response.data || '').slice(0, 300)}` : (err.message || String(err)));
      console.error('[GD mailchimp] failed:', detail);
      run = { state: 'error', mode: apply ? 'apply' : 'preview', started: run.started, finished: new Date().toISOString(), error: detail };
    }
  }

  // Quick refresh: tag new givers only. Reads just the (small) Gave 26-27 tag segment from Mailchimp, not the whole audience.
  async function quick(by) {
    const t0 = Date.now();
    run = { state: 'running', mode: 'quick', started: new Date().toISOString(), by };
    const cfg = config();
    const scrub = s => (cfg.key ? String(s).split(cfg.key).join('***') : String(s));
    try {
      if (cfg.missing.length) throw new Error('Not set on the server: ' + cfg.missing.join(', '));
      const { donors, gave } = await loadLocal();
      const wantGave = new Map();   // email -> name
      for (const d of donors) if (lc(d.email) && gave.has(d.household_re_id || d.re_id) && !wantGave.has(lc(d.email))) wantGave.set(lc(d.email), `${d.first_name || ''} ${d.last_name || ''}`.trim());
      const tg = await withRetry(() => axios.get(`${base(cfg)}/tag-search`, { auth: authOf(cfg), params: { name: GAVE_TAG }, timeout: 60000 }), 'find Gave tag');
      const tagRow = (tg.data.tags || []).find(t => t.name === GAVE_TAG);
      const have = new Set();
      if (tagRow) for (let offset = 0; ; offset += 1000) {
        const r = await withRetry(() => axios.get(`${base(cfg)}/segments/${tagRow.id}/members`, { auth: authOf(cfg), params: { count: 1000, offset, fields: 'total_items,members.email_address' }, timeout: 90000 }), 'read Gave segment');
        for (const m of (r.data.members || [])) have.add(lc(m.email_address));
        if (!r.data.members || r.data.members.length < 1000) break;
      }
      const missing = [...wantGave.keys()].filter(e => !have.has(e));
      const out = { gave_here: wantGave.size, already_tagged: wantGave.size - missing.length, tagged: [], not_in_mailchimp: [], not_subscribed: [], errors: [] };
      if (missing.length > 300) throw new Error(`${missing.length} people to tag is unusually many for a quick refresh. Run the full Preview and Apply instead.`);
      await pool(missing, 6, async e => {
        try {
          let st;
          try { st = (await withRetry(() => axios.get(`${base(cfg)}/members/${hashOf(e)}`, { auth: authOf(cfg), params: { fields: 'status' }, timeout: 60000 }), 'check member')).data.status; }
          catch (er) { if (er.response && er.response.status === 404) { out.not_in_mailchimp.push(`${wantGave.get(e)} <${e}>`); return; } throw er; }
          if (st !== 'subscribed') { out.not_subscribed.push(`${e} (${st})`); return; }
          await withRetry(() => axios.post(`${base(cfg)}/members/${hashOf(e)}/tags`, { tags: [{ name: GAVE_TAG, status: 'active' }] }, { auth: authOf(cfg), timeout: 60000 }), 'add Gave tag');
          out.tagged.push(`${wantGave.get(e)} <${e}>`);
        } catch (er) { out.errors.push(`${e}: ${scrub(er.message)}`); }
      });
      console.log(`[GD mailchimp] quick refresh by ${by}: ${out.tagged.length} tagged, ${out.not_in_mailchimp.length} not in Mailchimp`);
      run = { state: 'done', mode: 'quick', started: run.started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), quick: out };
    } catch (err) {
      const detail = scrub(err.response ? `${err.response.status} ${JSON.stringify(err.response.data || '').slice(0, 300)}` : (err.message || String(err)));
      console.error('[GD mailchimp] quick failed:', detail);
      run = { state: 'error', mode: 'quick', started: run.started, finished: new Date().toISOString(), error: detail };
    }
  }
  app.post('/api/admin/gd/mailchimp/quick', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A Mailchimp run is already in progress.' });
    quick('admin');
    res.status(202).json({ started: true });
  });

  app.get('/api/admin/gd/mailchimp/names.csv', requireAdmin, (req, res) => {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Email', 'Why it differs', 'First name will change', 'Mailchimp first', 'Mailchimp last', 'Donor table first', 'Donor table last'];
    const rows = [...lastNames].sort((a, b) => a.kind.localeCompare(b.kind) || a.email.localeCompare(b.email));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mailchimp-names-that-differ.csv"', 'Cache-Control': 'no-store' });
    res.send([head, ...rows.map(n => [n.email, n.kind, n.fix, n.mc_first, n.mc_last, n.here_first, n.here_last])].map(r => r.map(q).join(',')).join('\n') + '\n');
  });

  app.post('/api/admin/gd/mailchimp/preview', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A Mailchimp run is already in progress.' });
    execute(false, 'admin');
    res.status(202).json({ started: true });
  });
  app.post('/api/admin/gd/mailchimp/apply', requireAdmin, (req, res) => {
    if (run.state === 'running') return res.status(409).json({ error: 'A Mailchimp run is already in progress.' });
    if (!previewed) return res.status(400).json({ error: 'Run a preview first.' });
    execute(true, 'admin');
    res.status(202).json({ started: true });
  });
  app.get('/api/admin/gd/mailchimp/status', requireAdmin, (req, res) => {
    const cfg = config();
    res.json({ ...run, configured: !cfg.missing.length, missing: cfg.missing, new_status: cfg.newStatus,
      schedule: scheduleOn(), last_nightly: lastNightly, server_started: STARTED });
  });

  // Opt-in nightly apply at 4 a.m. Eastern (after the 3 a.m. RE sync). No hand-apply needed first: the safety limits
  // (adds, archives, stale tags) block anything unusual, and staff are emailed when that happens.
  if (require('./sky-instance').backgroundAllowed() && scheduleOn()) {
    let lastDay = '';
    setInterval(() => {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day = et.getFullYear() + '-' + et.getMonth() + '-' + et.getDate();
      if (et.getHours() === 4 && lastDay !== day && run.state !== 'running') { lastDay = day; previewed = true; execute(true, 'nightly'); }
    }, 10 * 60 * 1000).unref();
  }
};

module.exports._test = { plan, nameKind };
