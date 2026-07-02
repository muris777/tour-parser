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
