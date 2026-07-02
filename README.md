# Tour Booking Email Parser

Polls a cPanel IMAP inbox for booking emails from Freetour, Viator, Civitatis, and GuruWalk, parses them, and syncs to Supabase.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your Supabase and cPanel credentials
```

## Running

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

## Supabase setup

Run this SQL in your Supabase SQL editor to add the `status` column and `checkins` table if not already present:

```sql
-- Add status to bookings if not exists
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status text DEFAULT 'confirmed';

-- Add status to tours if not exists
ALTER TABLE tours ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled';

-- Checkins table
CREATE TABLE IF NOT EXISTS checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
  checked_in_by uuid REFERENCES users(id),
  checked_in_at timestamptz DEFAULT now(),
  UNIQUE(booking_id)
);

-- Enable RLS
ALTER TABLE checkins ENABLE ROW LEVEL SECURITY;

-- Guides can insert checkins for their own tours
CREATE POLICY "guides can checkin" ON checkins
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN tours t ON t.id = b.tour_id
      WHERE b.id = checkins.booking_id
      AND t.guide_id = auth.uid()
    )
  );

-- Everyone authenticated can view checkins
CREATE POLICY "authenticated can view checkins" ON checkins
  FOR SELECT TO authenticated USING (true);
```

Run this SQL to split `bookings.people` into an adults/youth/kids breakdown
(infants are counted as kids). `people` stays as the total — it's kept in
sync by the parser and is still what the tour_app frontend reads for
capacity counts — the new columns are additive.

```sql
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adults int DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS youth int DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS kids int DEFAULT 0;

-- Backfill existing bookings: assume the full historical count was adults,
-- since there's no way to recover the real historical split.
UPDATE bookings SET adults = people WHERE adults = 0 AND youth = 0 AND kids = 0 AND people > 0;
```

Run this SQL to track when a booking was last amended and when it was
cancelled/rejected. `modified_at` only ever holds the latest amendment
(not a full history). Also adds the admin UPDATE policy the tour_app
booking-search page needs to amend dates / cancel bookings — previously
admins only had SELECT access.

```sql
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS modified_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

CREATE POLICY "admins manage bookings" ON bookings
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin = true))
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin = true));
```

## Deployment options

### Option A: cPanel cron job
Upload the project to cPanel, then set a cron job to run:
```
cd /home/youruser/tour-parser && node src/index.js >> /var/log/tour-parser.log 2>&1
```
Set `POLL_INTERVAL_MS=0` to run once and exit (cron handles the timing).

### Option B: Always-on process (Railway / Render free tier)
Deploy as a Node.js service. The built-in `setInterval` loop keeps it running.

### Option C: Local machine / VPS
```bash
npm install -g pm2
pm2 start src/index.js --name tour-parser
pm2 save
```

## Adding a new provider

1. Add a `parseProviderName(subject, text, fromEmail)` function in `src/parsers.js`
2. Add it to the dispatcher at the bottom of that file
3. The function should return `null` if the email isn't from that provider, or a `BookingData` object if it is

## Template matching

The parser matches incoming bookings to `tour_templates` rows using this priority:
1. `Internal code` field (Civitatis only — most reliable)
2. Time + language combination
3. Time only (fallback)

Make sure your `tour_templates` rows have `time` in `HH:MM` 24h format and `language` values that match what the providers send (e.g. `Spanish`, `Español`, `English`).

**Pitfall:** the time-only fallback (priority 3) means a new tour type sharing
a time slot with an existing template will silently get matched to the
*wrong* tour. E.g. adding a new "Riga Old Town 15:00" tour with no matching
template at 15:00 caused those bookings to land on whichever unrelated
15:00 tour matched the booking's language (KGB 15:00 English, Art Nouveau
15:00 Spanish) — nothing errors, so this can go unnoticed for a while.
Whenever a new time slot is introduced, add its `tour_templates` row(s)
*before* bookings for it start arriving.

Adding the Riga Old Town 15:00 template also created a *new* ambiguity: KGB
(15:00 English) and Art Nouveau (15:00 Spanish) now share their time+language
with Riga Old Town, so priority 2 alone can no longer tell them apart —
whichever row Postgres returns first wins. The system prompt now tells
Claude to always set `internal_code` for these three tours specifically
(any provider, not just Civitatis/website) so priority 1 resolves it
correctly. If you add another tour sharing an existing time+language pair,
you'll need the same treatment.

Riga Old Town 15:00 is seasonal (July–August only) — `sync.js` logs a
`SEASON CHECK` warning (not a hard block) if a booking lands on that
template outside those months, since that usually means it was mismatched
rather than a real off-season booking.

## API cost

The system prompt is sent as a cache breakpoint (`cache_control: ephemeral`)
since it's identical on every call — repeated calls within the cache window
(a few minutes; the parser polls every `POLL_INTERVAL_MS`, well inside it)
pay roughly 10% of the normal input price for it instead of full price.
When editing `SYSTEM_PROMPT`, prefer adding a rule once in a general
location over repeating it per-provider — duplicated wording costs tokens
on every single call, cached or not.
