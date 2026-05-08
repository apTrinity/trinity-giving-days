# Parents Campaign — Technical Reference

End-of-year parent participation push for the Trinity Fund 2025–2026.
Parents receive personalized links that land on `/parents`. Any gift from any
household member counts that household toward the 100% participation goal.

---

## Architecture Overview

```
parents.html  ──►  /api/parents/lookup    (identity resolution)
              ──►  /api/parents/gift      (gift submission)
              ◄──  /api/parents/leaderboard (polling every 10s)

Supabase (xkrvkswtljwswlnkzqhc)
  parent_households    ← seeded from RE export
  parent_constituents  ← seeded from RE export
  gifts                ← written on each successful payment
```

---

## Supabase Schema

### `parent_households`
| Column | Type | Notes |
|---|---|---|
| `household_import_id` | TEXT PK | e.g. `19960809_MA_009115` |
| `household_name` | TEXT | Display name |
| `grades` | TEXT[] | e.g. `{1,4}` or `{K,3}` |
| `is_hh2` | BOOLEAN | Divorced/separated household |
| `created_at` | TIMESTAMPTZ | |

### `parent_constituents`
| Column | Type | Notes |
|---|---|---|
| `fid` | TEXT PK | RE constituent ID, or ID + `"S"` for spouses |
| `household_import_id` | TEXT FK | → `parent_households` |
| `first_name` | TEXT | |
| `last_name` | TEXT | |
| `email` | TEXT | |
| `is_spouse` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |

> **Spouse convention:** spouses don't have their own RE constituent records.
> They are stored with `fid = constituent_id + "S"` (e.g. `9115S`).

### `gifts` (additions for parents campaign)
| Column | Type | Notes |
|---|---|---|
| `household_import_id` | TEXT FK | Enables household-level deduplication |

---

## Grade Encoding

Grades are stored as strings: `'K'`, `'1'` through `'12'`.

Conversion from RE class year (2-digit stored as string):
```
grade = 38 - int(class_year)
if grade == 0: grade = 'K'
```
Class of `'38` = Kindergarten in 2025–2026.

---

## Participation Baseline

A baseline of **429 families** was hardcoded at launch (gifts already recorded in RE before the
web page went live). Per-grade baselines are also hardcoded in `server.js`. New web gifts are
added on top — no RE sync is required during the campaign.

---

## API Endpoints

### `GET /api/parents/lookup`

Resolves a visitor's identity. Supports two query params (one required):

| Param | Description |
|---|---|
| `?fid=` | Looks up by RE constituent ID (or spouse ID with "S" suffix) |
| `?email=` | Looks up by email address (case-insensitive) |

**Response:**
```json
{
  "found": true,
  "fid": "9115",
  "first_name": "Andrew",
  "last_name": "Mordkoff",
  "email": "andrew.mordkoff@example.com",
  "household_import_id": "19960809_MA_009115",
  "grades": ["1", "4"],
  "already_gave": false
}
```

### `POST /api/parents/gift`

Records a completed gift after BBMS payment succeeds.

**Body:**
```json
{
  "transaction_id": "bbms-txn-id",
  "amount": 250,
  "first_name": "Andrew",
  "last_name": "Mordkoff",
  "email": "andrew.mordkoff@example.com",
  "affiliations": [{ "type": "current_parent", "grade": "1" }],
  "household_import_id": "19960809_MA_009115",
  "anonymous": false,
  "fund": "Annual Fund"
}
```

- Deduplicates by `household_import_id` first, then falls back to email
- If `household_import_id` is present, grades are looked up from `parent_households` automatically
- Affiliation credits are auto-built from household grades

### `GET /api/parents/leaderboard`

Returns participation counts by grade, used to drive the dot grid and grade table.

**Response:**
```json
{
  "total_donors": 441,
  "parents": [
    { "grade": "5", "donors": 38, "total": 62, "pct": 61 },
    ...
  ],
  "recent_gifts": [
    { "name": "The Mordkoff Family", "affiliation": "1st Grade Parent" },
    ...
  ]
}
```

---

## Form Flow

### Case 1 — Personalized link (`?fid=9115`)
1. Page loads → silent `GET /api/parents/lookup?fid=9115`
2. Identity pre-filled; grade chips shown (e.g. ✓ 1st Grade, ✓ 4th Grade)
3. Modal opens directly at Step 2 (gift form); step bar shows 2/3 filled
4. "Hi, Andrew — thanks for being here." greeting shown

### Case 2 — Manual arrival, email found
1. Modal opens at Step 1 (name + email entry); step bar shows 1/3 filled
2. User clicks Next → silent `GET /api/parents/lookup?email=`
3. Match found → Step 2 with greeting + grade chips; bar advances to 2/3

### Case 3 — Manual arrival, email not found
1. Same as Case 2 through Step 1
2. No match → user never told; grade dropdown appears instead of chips
3. User selects grade(s) manually; "+ Add another child" available

### Step 3 — After payment (all cases)
- BBMS modal closes → Thank You state; step bar fills all three segments

---

## Step Bar

The three-segment yellow progress indicator at the base of the modal header.

```
[■■■■■■■■■]  [□□□□□□□□□]  [□□□□□□□□□]   ← Step 1
[■■■■■■■■■]  [■■■■■■■■■]  [□□□□□□□□□]   ← Step 2
[■■■■■■■■■]  [■■■■■■■■■]  [■■■■■■■■■]   ← Step 3
```

- Full modal width, 4px tall, 10px navy gaps between segments
- JS function: `setStepBar(n)` where n = 1 | 2 | 3

---

## Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL_PARENTS` | `https://xkrvkswtljwswlnkzqhc.supabase.co` |
| `SUPABASE_KEY_PARENTS` | Supabase service role key for parents project |
| `PAYMENT_CONFIG_ID_TEST` | `e9126f05-0cc7-4a36-ba68-ac6bffd9f969` |
| `PAYMENT_CONFIG_ID_LIVE` | `8d2a50a3-deb8-41d0-8f0a-01b5955d69d6` |

The `PAYMENT_CONFIG_ID` in `public/parents.html` must be swapped to the live value before launch.

---

## Go-Live Checklist

- [ ] Seed `parent_constituents` with full RE export (one row per constituent + one `S` row per spouse)
- [ ] Swap `PAYMENT_CONFIG_ID` in `parents.html` to `8d2a50a3-deb8-41d0-8f0a-01b5955d69d6`
- [ ] Confirm `giving.trinityschoolnyc.org` DNS points to Render
- [ ] Upgrade Render plan if needed
- [ ] Verify BBMS merchant account is in live mode
- [ ] Send personalized `?fid=` links to non-donor parents

---

## Household Participation Logic

- **772 HH1 households** — standard families (the primary participation count)
- **36 HH2 households** — divorced/separated; each parent tracked separately
- Twins in the same grade each carry 0.5 weight so they count as 1 family
- One gift from any household member credits the entire household across all their children's grades
- The leaderboard counts distinct `household_import_id` values (or email as fallback)
