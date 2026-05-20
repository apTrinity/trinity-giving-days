// export-re-gifts.js
// Exports unsynced online gifts from parentsSupabase as a TSV file
// ready to import into RE NXT.
//
// Run with: node export-re-gifts.js
//
// Output: re-gift-import-YYYY-MM-DD.tsv in the project root
// After importing in RE, run: node export-re-gifts.js --mark-synced
// to stamp all exported gifts with re_synced_at in Supabase.

require('dotenv').config();
const axios         = require('axios');
const fs            = require('fs');
const { createClient } = require('@supabase/supabase-js');

const MARK_SYNCED = process.argv.includes('--mark-synced');

const parentsSupabase = createClient(
  process.env.SUPABASE_URL_PARENTS,
  process.env.SUPABASE_KEY_PARENTS
);

const mainSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(isoString) {
  const d = new Date(isoString);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const yr = String(d.getFullYear()).slice(2);
  return `${m}/${day}/${yr}`;
}

async function getBBMSToken() {
  const { data } = await mainSupabase
    .from('sky_tokens')
    .select('access_token')
    .eq('id', 1)
    .single();
  return data.access_token;
}

async function lookupTransaction(transactionId, accessToken) {
  try {
    const res = await axios.get(
      `https://api.sky.blackbaud.com/payments/v1/transactions/${transactionId}`,
      {
        headers: {
          'Authorization':           `Bearer ${accessToken}`,
          'Bb-Api-Subscription-Key': process.env.BBMS_API_KEY,
        },
      }
    );
    return res.data;
  } catch (err) {
    console.warn(`  ⚠ BBMS lookup failed for ${transactionId}: ${err.response?.status || err.message}`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== RE Gift Export ===\n');

  // Fetch unsynced online gifts
  const { data: gifts, error } = await parentsSupabase
    .from('gifts')
    .select('*')
    .eq('source', 'online')
    .is('re_synced_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('ERROR fetching gifts:', error.message);
    process.exit(1);
  }

  if (!gifts || gifts.length === 0) {
    console.log('No unsynced gifts found — nothing to export.');
    process.exit(0);
  }

  console.log(`Found ${gifts.length} unsynced gift(s).\n`);

  if (MARK_SYNCED) {
    // --mark-synced mode: stamp all previously exported gifts
    console.log('Marking all unsynced gifts as synced...');
    const ids = gifts.map(g => g.id);
    const { error: updateError } = await parentsSupabase
      .from('gifts')
      .update({ re_synced_at: new Date().toISOString() })
      .in('id', ids);
    if (updateError) {
      console.error('ERROR marking synced:', updateError.message);
      process.exit(1);
    }
    console.log(`✓ ${ids.length} gift(s) marked as synced.`);
    return;
  }

  // Get BBMS access token for transaction lookups
  const accessToken = await getBBMSToken();

  // TSV columns — matching RE NXT gift import format
  const columns = [
    'ImportID', 'GiftID', 'donor_name', 'GFType',
    'GFDate', 'GFTAmt', 'GFAnon', 'note_content',
    'CampID', 'FundID', 'GFAppeal', 'GFPayMeth',
    'GFCCType', 'GFCardholderName',
    'GFAckStatus', 'GFAckLetter',
    'GFAttrImpID', 'GFAttrCat', 'checkout_id', 'GFAttrDate',
  ];

  const toCSV = arr => arr.map(v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');

  const rows = [toCSV(columns)];
  const exportedIds = [];

  for (const gift of gifts) {
    // Look up card details from BBMS
    const txn = await lookupTransaction(gift.transaction_id, accessToken);
    const cardType        = txn?.credit_card?.card_type    || '';
    const cardholderName  = txn?.credit_card?.name         || `${gift.first_name} ${gift.last_name}`;

    const acknowledgementLetter = parseFloat(gift.amount) >= 1709 ? '1709 Society' : 'Trinity Fund';

    const row = [
      gift.constituent_id || '',             // ImportID — RE system record ID
      gift.transaction_id,                   // GiftID
      `${gift.first_name} ${gift.last_name}`, // donor_name
      'Cash',                                // GFType
      formatDate(gift.created_at),           // GFDate
      parseFloat(gift.amount).toFixed(2),    // GFTAmt
      gift.anonymous ? 'Y' : '',             // GFAnon
      '',                                    // note_content
      'Unrest. Oper.',                       // CampID
      '2025-2026 Annual',                    // FundID
      '',                                    // GFAppeal (blank for now)
      'Credit Card',                         // GFPayMeth
      cardType,                              // GFCCType
      cardholderName,                        // GFCardholderName
      'NeedsAcknowledgement',               // GFAckStatus
      acknowledgementLetter,                // GFAckLetter
      '',                                    // GFAttrImpID
      'BBMS Transaction ID',                 // GFAttrCat
      gift.transaction_id,                   // checkout_id
      formatDate(gift.created_at),           // GFAttrDate
    ];

    rows.push(toCSV(row));
    exportedIds.push(gift.id);

    console.log(`  ✓ ${gift.first_name} ${gift.last_name} — $${gift.amount} — ${formatDate(gift.created_at)} — ${cardType || 'card type unknown'}`);
  }

  // Write TSV file
  const today = new Date().toISOString().slice(0, 10);
  const filename = `re-gift-import-${today}.csv`;
  fs.writeFileSync(filename, rows.join('\n'), 'utf8');

  console.log(`\n✓ Exported ${exportedIds.length} gift(s) to ${filename}`);
  console.log('\nNext steps:');
  console.log('  1. Import the CSV file into RE NXT');
  console.log('  2. Review and commit the import in RE');
  console.log(`  3. Run: node export-re-gifts.js --mark-synced`);
  console.log('     to mark these gifts as synced in Supabase\n');
}

run().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
