// seed_ask_amounts.js
// Reads parents-constituents-export.CSV and populates ask_a, ask_b, ask_ly
// on parent_households, matched by Lookup ID = household_import_id.
//
// Run from the giving-day-platform directory:
//   node seed_ask_amounts.js
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

// Strip "$" and "," and parse to a number. Returns null if blank or unparseable.
function parseAsk(str) {
  if (!str || !str.trim()) return null;
  const n = parseFloat(str.replace(/[$,]/g, '').trim());
  return isNaN(n) ? null : n;
}

async function run() {
  const raw  = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Parsed ${rows.length} rows from CSV.`);

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for (const row of rows) {
    const householdImportId = row['Lookup ID'];
    const askA  = parseAsk(row['Ask A']);
    const askB  = parseAsk(row['Ask B']);
    const askLy = parseAsk(row['LY Ask']);

    if (!householdImportId) { skipped++; continue; }
    if (askA === null && askB === null && askLy === null) { skipped++; continue; }

    const { error } = await supabase
      .from('parent_households')
      .update({ ask_a: askA, ask_b: askB, ask_ly: askLy })
      .eq('household_import_id', householdImportId);

    if (error) {
      console.warn(`  ✗ ${householdImportId}: ${error.message}`);
      errors++;
    } else {
      console.log(`  ✓ ${householdImportId}: A=$${askA} B=$${askB} LY=$${askLy}`);
      updated++;
    }
  }

  console.log(`\nDone — ${updated} updated, ${skipped} skipped, ${errors} errors.`);
}

run().catch(err => { console.error(err); process.exit(1); });
