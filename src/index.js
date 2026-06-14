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

  for (const email of emails) {
    const parsed = parseEmail(email.subject, email.text, email.fromEmail);

    if (!parsed) {
      console.log(`[parse] Unrecognised email from ${email.fromEmail}: "${email.subject}"`);
      continue;
    }

    console.log(`[parse] ${parsed.provider} / ${parsed.action} / booking ${parsed.booking_number}`);

    try {
      const result = await syncBooking(parsed);
      console.log('[sync]', result);
    } catch (err) {
      console.error(`[sync] Error for booking ${parsed.booking_number}:`, err.message);
    }
  }
}

async function main() {
  console.log('Tour booking parser started.');
  console.log(`Polling every ${POLL_INTERVAL / 1000}s`);

  // Run immediately on start, then on interval
  await runOnce();
  setInterval(runOnce, POLL_INTERVAL);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
