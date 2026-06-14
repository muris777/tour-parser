import 'dotenv/config';
import { fetchUnseenEmails } from './imap.js';
import { parseEmail } from './parsers.js';
import { syncBooking } from './sync.js';

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '180000');
const BATCH_SIZE = 5; // process 5 emails in parallel

async function processEmail(email) {
  try {
    const parsed = await parseEmail(email.subject, email.text, email.fromEmail);
    if (!parsed) return; // not a booking email, silently skip

    const result = await syncBooking(parsed);

    if (result.action === 'created') {
      console.log(`✅ ADDED   [${parsed.provider}] #${parsed.booking_number} — ${parsed.date} ${parsed.time} ${parsed.language}`);
    } else if (result.action === 'cancelled' || result.action === 'rejected') {
      console.log(`🚫 ${result.action.toUpperCase()} [${parsed.provider}] #${parsed.booking_number}`);
    } else if (result.skipped && result.reason === 'no matching template') {
      console.warn(`⚠️  NO TEMPLATE [${parsed.provider}] #${parsed.booking_number} — time:${result.time} lang:${result.language}`);
    }
    // silently skip already_exists and other non-actionable results

  } catch (err) {
    console.error(`❌ ERROR processing "${email.subject}": ${err.message}`);
  }
}

async function runOnce() {
  let emails;
  try {
    emails = await fetchUnseenEmails();
  } catch (err) {
    console.error(`❌ IMAP ERROR: ${err.message}`);
    return;
  }

  if (!emails.length) return;

  console.log(`📬 ${emails.length} new email(s) — processing...`);

  // Process in batches of BATCH_SIZE in parallel
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(processEmail));
  }
}

async function main() {
  console.log(`🚀 Tour booking parser started — polling every ${POLL_INTERVAL / 1000}s`);
  await runOnce();
  setInterval(runOnce, POLL_INTERVAL);
}

main().catch(err => {
  console.error('❌ FATAL:', err);
  process.exit(1);
});
