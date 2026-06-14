# Complete Setup Guide — Tour Booking System

Work through these phases in order. Each step tells you exactly where to go, what to click, and what to type.

---

## PHASE 1 — Supabase database

### Step 1.1 — Open the SQL editor

1. Go to https://supabase.com and log in
2. Click your project
3. In the left sidebar click **SQL Editor**
4. Click **New query**

### Step 1.2 — Drop old tables and create new ones

In the SQL Editor, paste this entire block and click **Run**. It drops your old tables first, then creates clean new ones.

```sql
-- Drop old tables (order matters — dependents first)
DROP TABLE IF EXISTS "Bookings" CASCADE;
DROP TABLE IF EXISTS "Tours" CASCADE;
DROP TABLE IF EXISTS "Tour_templates" CASCADE;
DROP TABLE IF EXISTS "Users" CASCADE;

-- Also drop lowercase versions if any exist
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS tours CASCADE;
DROP TABLE IF EXISTS tour_templates CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS checkins CASCADE;

-- USERS
-- Links to Supabase Auth — id must match the auth.users id
CREATE TABLE users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  email text,
  admin boolean DEFAULT false
);

-- TOUR TEMPLATES
-- One row per tour type (e.g. "English tour 11:00", "Spanish tour 18:00")
CREATE TABLE tour_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  time text NOT NULL,        -- HH:MM 24-hour format, e.g. '11:00'
  language text,
  internal_code text         -- used to match Civitatis bookings
);

-- TOURS
-- One row per actual tour occurrence (a specific date)
CREATE TABLE tours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid REFERENCES tour_templates(id),
  date date NOT NULL,
  guide_id uuid REFERENCES users(id),
  status text DEFAULT 'scheduled'
);

-- BOOKINGS
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id uuid REFERENCES tours(id),
  booking_number text NOT NULL,
  provider text NOT NULL,
  name text,
  email text,
  phone_number text,
  people integer DEFAULT 1,
  date date,
  status text DEFAULT 'confirmed',
  created_at timestamptz DEFAULT now(),
  UNIQUE(provider, booking_number)   -- prevents duplicate imports
);

-- CHECKINS
CREATE TABLE checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
  checked_in_by uuid REFERENCES users(id),
  checked_in_at timestamptz DEFAULT now(),
  UNIQUE(booking_id)
);
```

You should see "Success. No rows returned" at the bottom. If any DROP line errors saying the table doesn't exist, that's fine — just means it wasn't there.

### Step 1.3 — Enable Row Level Security on all tables

New query, paste and Run:

```sql
-- Turn on RLS for every table
ALTER TABLE bookings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tours           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins        ENABLE ROW LEVEL SECURITY;
```

### Step 1.4 — Create access policies

New query, paste and Run:

```sql
-- USERS table: everyone logged in can read their own row
CREATE POLICY "users can read own profile" ON users
  FOR SELECT TO authenticated
  USING (id = auth.uid());

-- Admins can read all users
CREATE POLICY "admins read all users" ON users
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin = true)
  );

-- Admins can update any user
CREATE POLICY "admins update users" ON users
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin = true)
  );

-- TOUR TEMPLATES: everyone logged in can read
CREATE POLICY "authenticated read templates" ON tour_templates
  FOR SELECT TO authenticated USING (true);

-- Admins can modify templates
CREATE POLICY "admins manage templates" ON tour_templates
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin = true)
  );

-- TOURS: everyone logged in can read
CREATE POLICY "authenticated read tours" ON tours
  FOR SELECT TO authenticated USING (true);

-- Admins can manage tours (create, update, delete)
CREATE POLICY "admins manage tours" ON tours
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin = true)
  );

-- BOOKINGS: admins see all, guides see only their assigned tours
CREATE POLICY "admins read all bookings" ON bookings
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND admin = true)
  );

CREATE POLICY "guides read their tour bookings" ON bookings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tours
      WHERE tours.id = bookings.tour_id
      AND tours.guide_id = auth.uid()
    )
  );

-- CHECKINS: guides can insert for their tours
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

-- Everyone logged in can read checkins
CREATE POLICY "authenticated read checkins" ON checkins
  FOR SELECT TO authenticated USING (true);
```

### Step 1.5 — Seed your tour templates

New query — fill in your real tour info and Run:

```sql
-- Add one row per tour type you run.
-- The 'time' column MUST be in HH:MM 24-hour format.
-- 'language' must match what providers send: 'Spanish', 'English', etc.
-- Add as many rows as you need.

INSERT INTO tour_templates (title, time, language) VALUES
  ('Riga Old Town Free Tour – English 11:00', '11:00', 'English'),
  ('Riga Old Town Free Tour – Spanish 11:00', '11:00', 'Spanish'),
  ('Riga Old Town Free Tour – English 18:00', '18:00', 'English'),
  ('Riga Old Town Free Tour – Spanish 18:00', '18:00', 'Spanish');
```

⚠️ The parser matches bookings to templates by time + language. If you have two tours at the same time in the same language, add an internal_code column:

```sql
-- Only needed if you have duplicate time+language combos:
ALTER TABLE tour_templates ADD COLUMN IF NOT EXISTS internal_code text;
UPDATE tour_templates SET internal_code = 'Riga Old Town Free Tour' WHERE title ILIKE '%Riga%';
```

### Step 1.6 — Get your Supabase credentials

1. Left sidebar → **Project Settings** → **API**
2. Note down:
   - **Project URL** — looks like `https://xyzxyz.supabase.co`
   - **service_role** key (under "Project API keys", click the eye icon) — starts with `eyJ...`
   - **anon / public** key — also needed for the frontend

Keep the service_role key secret — it bypasses all RLS and is only for the parser running on your server.

---

## PHASE 2 — Create user accounts for your guides

### Step 2.1 — Create a guide account in Supabase Auth

1. Left sidebar → **Authentication** → **Users**
2. Click **Add user** → **Create new user**
3. Enter the guide's email and a temporary password
4. Click **Create user**
5. Note the **User UID** shown in the list (you'll need it in step 2.2)

Repeat for each guide.

### Step 2.2 — Link the auth user to your users table

In SQL Editor, new query:

```sql
-- Replace the values with the real UID from step 2.1 and the guide's name/email
INSERT INTO users (id, name, email, admin) VALUES
  ('PASTE-UID-FROM-AUTH-HERE', 'Guide Name', 'guide@email.com', false);
```

For the owner/admin account:

```sql
INSERT INTO users (id, name, email, admin) VALUES
  ('PASTE-OWNER-UID-HERE', 'Your Name', 'you@email.com', true);
```

---

## PHASE 3 — Set up the email parser on Railway (free hosting)

Railway gives you a free always-on Node.js process — no server management needed.

### Step 3.1 — Create a Railway account

1. Go to https://railway.app
2. Sign up with GitHub (easiest)

### Step 3.2 — Push the parser code to GitHub

On your computer, open Terminal (Mac/Linux) or Command Prompt (Windows):

```bash
# Install Git if you don't have it: https://git-scm.com

# Unzip the downloaded tour-parser folder, then:
cd path/to/tour-parser

git config --global core.autocrlf true
git init
git add .
git commit -m "initial commit"
```

The `core.autocrlf true` line is a one-time setting that tells Git you're on Windows — it handles line ending conversion automatically and stops the warnings. You only need to run it once ever, not per project.

Then:
1. Go to https://github.com/new
2. Create a new **private** repository called `tour-parser`
3. Follow the instructions GitHub shows to push your existing code ("push an existing repository")

### Step 3.3 — Deploy to Railway

1. In Railway, click **New Project** → **Deploy from GitHub repo**
2. Select your `tour-parser` repo
3. Railway will detect it's a Node.js app and deploy automatically

### Step 3.4 — Set environment variables in Railway

1. Click your service in Railway
2. Click **Variables** tab
3. Click **New Variable** for each of these — fill in your real values:

| Variable name      | Value                                      |
|--------------------|--------------------------------------------|
| `SUPABASE_URL`     | Your Project URL from Step 1.6             |
| `SUPABASE_SERVICE_KEY` | Your service_role key from Step 1.6    |
| `IMAP_HOST`        | Your cPanel mail host, e.g. `mail.yourdomain.com` |
| `IMAP_PORT`        | `993`                                      |
| `IMAP_USER`        | The full email address, e.g. `bookings@yourdomain.com` |
| `IMAP_PASSWORD`    | The email account password                 |
| `IMAP_TLS`         | `true`                                     |
| `POLL_INTERVAL_MS` | `180000` (polls every 3 minutes)           |

4. Railway will automatically redeploy when you save

### Step 3.5 — Find your cPanel IMAP host

1. Log in to cPanel
2. Search for **Email Accounts** in the top search bar
3. Click **Connect Devices** next to the booking email account
4. Look for the **Incoming Server** settings — copy the hostname (usually `mail.yourdomain.com`)

### Step 3.6 — Verify the parser is running

1. In Railway, click your service → **Logs** tab
2. You should see:
   ```
   Tour booking parser started.
   Polling every 180s
   [poll] Checking inbox at 2026-...
   [poll] No new emails.
   ```
3. If you see errors, check your IMAP credentials or Supabase keys

---

## PHASE 4 — Build and deploy the React frontend

This comes after the parser is confirmed working. The frontend is a separate project (Vite + React) deployed to Vercel (free).

### Step 4.1 — Install tools on your computer

You only need to do this once:

1. Install Node.js: https://nodejs.org (download the LTS version, run the installer)
2. Open Terminal / Command Prompt and verify:
   ```bash
   node --version   # should show v18 or higher
   npm --version    # should show a number
   ```

### Step 4.2 — Create the React app

```bash
npm create vite@latest tour-app -- --template react
cd tour-app
npm install
npm install @supabase/supabase-js @supabase/auth-ui-react react-router-dom
```

### Step 4.3 — Set up Supabase in the frontend

Create a file at `tour-app/src/supabase.js`:

```js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  'PASTE_YOUR_PROJECT_URL_HERE',     // from Step 1.6
  'PASTE_YOUR_ANON_KEY_HERE'         // the anon/public key from Step 1.6
)
```

⚠️ Use the **anon key** here, not the service_role key.

---

## What to build next (in order)

Once the above is done, tell me and I'll build each screen for you:

1. **Login page** — email + password form using Supabase Auth
2. **Owner calendar** — monthly view, click a day to see bookings + assign a guide
3. **Guide view** — list of assigned tours, expand to see guest list, check-in button per guest
4. **Tour management** — create/edit tour templates and individual tour dates

---

## Quick reference — where everything lives

| Thing | Where |
|---|---|
| Database tables & SQL | Supabase → SQL Editor |
| User accounts | Supabase → Authentication → Users |
| API keys | Supabase → Project Settings → API |
| Parser code | Railway (deployed from GitHub) |
| Parser logs | Railway → your service → Logs |
| Parser environment variables | Railway → your service → Variables |
| cPanel email settings | cPanel → Email Accounts → Connect Devices |
| Frontend code | Your computer → `tour-app/` folder |
| Frontend hosting | Vercel (free, connects to GitHub) |
