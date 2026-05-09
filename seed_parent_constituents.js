// seed_parent_constituents.js
// Reads parents-constituents-export.CSV and upserts into parent_constituents.
// Run from the giving-day-platform directory:
//   node seed_parent_constituents.js
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const CSV_PATH = path.join(__dirname, '../parents-constituents-export.CSV');

const supabase = createClient(
  process.env.SUPABASE_URL_PARENTS,
  process.env.SUPABASE_KEY_PARENTS
);

async function run() {
  // ── Parse CSV ──────────────────────────────────────────────────────────────
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Parsed ${rows.length} rows from CSV.`);

  // ── Build insert records ───────────────────────────────────────────────────
  const records = [];
  const warnings = [];

  for (const row of rows) {
    const systemId          = row['System Record ID']?.trim();
    const lookupId          = row['Lookup ID']?.trim();
    const firstName         = row['First Name']?.trim()   || null;
    const lastName          = row['Last Name']?.trim()    || null;
    const email             = row['Parent 1 Email']?.trim() || null;
    const spouseFirst       = row['Spouse First Name']?.trim() || null;
    const spouseLast        = row['Spouse Last Name']?.trim()  || null;
    const spouseEmail       = row['Spouse Email']?.trim()      || null;

    if (!systemId || !lookupId) {
      warnings.push(`Skipping row — missing System Record ID or Lookup ID: ${JSON.stringify(row)}`);
      continue;
    }

    // Primary constituent
    if (!email) warnings.push(`No email for primary: ${firstName} ${lastName} (fid: ${systemId})`);
    records.push({
      fid:                  systemId,
      household_import_id:  lookupId,
      first_name:           firstName,
      last_name:            lastName,
      email:                email || null,
      is_spouse:            false,
    });

    // Spouse — only if at least a first or last name is present
    if (spouseFirst || spouseLast) {
      if (!spouseEmail) warnings.push(`No email for spouse: ${spouseFirst} ${spouseLast} (fid: ${systemId}S)`);
      records.push({
        fid:                  systemId + 'S',
        household_import_id:  lookupId,
        first_name:           spouseFirst || null,
        last_name:            spouseLast  || null,
        email:                spouseEmail || null,
        is_spouse:            true,
      });
    }
  }

  console.log(`Built ${records.length} records (primaries + spouses).`);
  if (warnings.length) {
    console.warn('\nWarnings:');
    warnings.forEach(w => console.warn(' ⚠ ', w));
  }

  // ── Verify household_import_ids exist in parent_households ─────────────────
  const uniqueHHIds = [...new Set(records.map(r => r.household_import_id))];
  const { data: existingHH, error: hhError } = await supabase
    .from('parent_households')
    .select('household_import_id')
    .in('household_import_id', uniqueHHIds);

  if (hhError) {
    console.error('Failed to verify household IDs:', hhError.message);
    process.exit(1);
  }

  const knownHHIds = new Set(existingHH.map(h => h.household_import_id));
  const orphaned = records.filter(r => !knownHHIds.has(r.household_import_id));
  if (orphaned.length) {
    console.warn(`\n⚠  ${orphaned.length} record(s) have a Lookup ID not found in parent_households:`);
    orphaned.forEach(r => console.warn(`   fid: ${r.fid}  →  household_import_id: ${r.household_import_id}  (${r.first_name} ${r.last_name})`));
    console.warn('These will be skipped to avoid a foreign key violation.\n');
  }

  const toInsert = records.filter(r => knownHHIds.has(r.household_import_id));
  console.log(`Inserting ${toInsert.length} records into parent_constituents…`);

  // ── Upsert in batches of 100 ───────────────────────────────────────────────
  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase
      .from('parent_constituents')
      .upsert(batch, { onConflict: 'fid' });
    if (error) {
      console.error(`Batch ${Math.floor(i / BATCH) + 1} failed:`, error.message);
      process.exit(1);
    }
    inserted += batch.length;
    console.log(`  ✓ ${inserted} / ${toInsert.length}`);
  }

  console.log('\n✅  Done.');
  if (orphaned.length) console.warn(`⚠  ${orphaned.length} record(s) skipped — Lookup ID not in parent_households.`);
}

run().catch(err => { console.error(err); process.exit(1); });
