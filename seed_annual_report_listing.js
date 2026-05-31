// seed_annual_report_listing.js
// Reads Import_ID_Lookup (3).csv and populates annual_report_listing
// on parent_households, matched by Constituent Import ID = household_import_id.
//
// Run from the giving-day-platform/giving-day-platform directory:
//   node seed_annual_report_listing.js
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const CSV_PATH = path.join(__dirname, 'Import_ID_Lookup (3).csv');

const supabase = createClient(
  process.env.SUPABASE_URL_PARENTS,
  process.env.SUPABASE_KEY_PARENTS
);

async function run() {
  const raw  = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Parsed ${rows.length} rows from CSV.`);

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for (const row of rows) {
    const householdImportId   = row['Constituent Import ID'];
    const annualReportListing = row['Annual Report Listing Salutation Text'];

    if (!householdImportId || !annualReportListing) { skipped++; continue; }

    const { error } = await supabase
      .from('parent_households')
      .update({ annual_report_listing: annualReportListing })
      .eq('household_import_id', householdImportId);

    if (error) {
      console.warn(`  ✗ ${householdImportId}: ${error.message}`);
      errors++;
    } else {
      console.log(`  ✓ ${householdImportId}: ${annualReportListing}`);
      updated++;
    }
  }

  console.log(`\nDone — ${updated} updated, ${skipped} skipped, ${errors} errors.`);
}

run().catch(err => { console.error(err); process.exit(1); });
