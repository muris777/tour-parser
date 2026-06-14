import 'dotenv/config';
import { fetchUnseenEmails } from './imap.js';
import { parseEmail } from './parsers.js';
import { syncBooking } from './sync.js';

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '180000');

async function runOnce() {
  console.log(`[poll] Checking inbox at ${new Date().toISOString()}`);

  let emails;
  try {
    emails = await fetchUnseenEmails();
  } catch (err) {
    console.error('[imap] Connection failed:', err.message);
    return;
  }

  if (!emails.length) {
    console.log('[poll] No new emails.');
    return;
  }

  console.log(`[poll] Found ${emails.length} new email(s)`);

  // Process one at a time to avoid rate limits and ensure proper awaiting
  for (const email of emails) {
    try {
      const parsed = await parseEmail(email.subject, email.text, email.fromEmail);

      if (!parsed) {
        console.log(`[parse] Unrecognised email from ${email.fromEmail}: "${email.subject}"`);
        continue;
      }

      console.log(`[parse] ${parsed.provider} / ${parsed.action} / booking ${parsed.booking_number}`);

      const result = await syncBooking(parsed);
      console.log('[sync]', JSON.stringify(result));

    } catch (err) {
      console.error(`[error] Failed to process "${email.subject}":`, err.message);
    }
  }
}

async function main() {
  console.log('Tour booking parser started.');
  console.log(`Polling every ${POLL_INTERVAL / 1000}s`);

  await runOnce();
  setInterval(runOnce, POLL_INTERVAL);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
