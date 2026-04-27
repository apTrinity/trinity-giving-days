// ─────────────────────────────────────────────────────────────────────────────
// Trinity Giving Days — Server
// ─────────────────────────────────────────────────────────────────────────────
// Route map:
//   GET  /                        → serves the giving day HTML page
//   POST /api/lookup              → searches RE NXT for a constituent by email
//   POST /api/gift                → resolves constituent in RE, writes gift + affiliations to Supabase
//   GET  /auth/blackbaud          → starts the SKY API OAuth flow (one-time browser visit)
//   GET  /auth/blackbaud/callback → receives the OAuth code and exchanges it for tokens
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function gradeLabel(grade) {
  if (!grade) return '—';
  if (grade === 'K') return 'Kindergarten';
  const n = parseInt(grade);
  const sfx = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${sfx} Grade`;
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
  const { transaction_id, amount, first_name, last_name, email, affiliations } = req.body;

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
        confirmation_sent: false,
      })
      .select()
      .single();

    if (giftError) throw new Error('Supabase gift insert failed: ' + giftError.message);
    console.log(`Gift saved to Supabase: ${gift.id}`);

    // Save affiliation credits — counts_toward_total set by background job once constituent is known
    if (affiliations && affiliations.length > 0) {
      const credits = affiliations.map(aff => ({
        gift_id:             gift.id,
        affiliation_type:    aff.type,
        class_year:          aff.class_year || null,
        grade:               aff.grade || null,
        counts_toward_total: false,
      }));

      const { error: creditsError } = await supabase
        .from('affiliation_credits')
        .insert(credits);

      if (creditsError) throw new Error('Supabase affiliation insert failed: ' + creditsError.message);
      console.log(`${credits.length} affiliation credit(s) saved for gift ${gift.id}`);
    }

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
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('gifts')
        .select('amount'),
    ]);

    const credits    = creditsResult.data  || [];
    const recentRows = giftsResult.data    || [];
    const allGifts   = sumResult.data      || [];

    const totalRaised  = allGifts.reduce((s, g) => s + (parseFloat(g.amount) || 0), 0);
    const totalDonors  = credits.filter(c => c.counts_toward_total).length;

    // Group alumni credits by class_year (de-dupe by gift_id)
    const alumniMap = {};
    credits.forEach(c => {
      if (c.affiliation_type === 'alumni' && c.class_year) {
        if (!alumniMap[c.class_year]) alumniMap[c.class_year] = new Set();
        alumniMap[c.class_year].add(c.gift_id);
      }
    });
    const alumni = Object.entries(alumniMap)
      .map(([year, set]) => ({ class_year: parseInt(year), donors: set.size }))
      .sort((a, b) => b.donors - a.donors);

    // Group current parents — by grade if present, otherwise by class_year
    const parentsMap = {};
    credits.forEach(c => {
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

    res.json({ alumni, parents, total_donors: totalDonors, total_raised: totalRaised, recent_gifts });
  } catch (err) {
    console.error('Leaderboard error:', err.message);
    res.status(500).json({ error: 'Leaderboard query failed.' });
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nTrinity Giving Days server running at http://localhost:${PORT}`);
  console.log(`\nIf SKY API tokens are not yet in .env, authorize here:`);
  console.log(`  http://localhost:${PORT}/auth/blackbaud\n`);
});
