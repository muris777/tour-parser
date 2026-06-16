import 'dotenv/config';
import { fetchUnseenEmails } from './imap.js';
import { parseEmail } from './parsers.js';
import { syncBooking } from './sync.js';

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '180000');
const BATCH_SIZE = 5;
let isRunning = false;

async function processEmail(email) {
  try {
  
    const parsed = await parseEmail(email.subject, email.text, email.fromEmail);
    if (!parsed) return;
    if (parsed.manual_required) {
      console.warn(`📋 MANUAL REQUIRED [${parsed.provider}] #${parsed.booking_number} — check provider portal`);
      return;
    }

    const result = await syncBooking(parsed);

    if (result.action === 'created') {
      console.log(`✅ ADDED   [${parsed.provider}] #${parsed.booking_number} — ${parsed.date} ${parsed.time} ${parsed.language}`);
    } else if (result.action === 'amended') {
      console.log(`✏️  AMENDED  [${parsed.provider}] #${parsed.booking_number} — new date: ${parsed.date}`);
    } else if (result.action === 'cancelled' || result.action === 'rejected') {
      console.log(`🚫 ${result.action.toUpperCase()} [${parsed.provider}] #${parsed.booking_number}`);
    } else if (result.skipped && result.reason === 'no matching template') {
      console.warn(`⚠️  NO TEMPLATE [${parsed.provider}] #${parsed.booking_number} — time:${result.time} lang:${result.language}`);
    }
  } catch (err) {
    console.error(`❌ ERROR processing "${email.subject}": ${err.message}`);
  }
}

async function runOnce() {
  if (isRunning) {
    console.log('⏳ Previous run still in progress, skipping this poll.');
    return;
  }

  isRunning = true;

  let emails;
  try {
    emails = await fetchUnseenEmails();
  } catch (err) {
    console.error(`❌ IMAP ERROR: ${err.message}`);
    isRunning = false;
    return;
  }

  if (!emails.length) {
    isRunning = false;
    return;
  }

  console.log(`📬 ${emails.length} new email(s) — processing...`);

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(processEmail));

    // Progress update every 100 emails
    if ((i + BATCH_SIZE) % 100 === 0) {
      console.log(`⏱  Processed ${Math.min(i + BATCH_SIZE, emails.length)} / ${emails.length}`);
    }
  }

  console.log(`✅ Done processing ${emails.length} emails.`);
  isRunning = false;
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
