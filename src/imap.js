import Imap from 'imap';
import { simpleParser } from 'mailparser';

/**
 * Connects to the IMAP inbox and fetches all UNSEEN messages in batches.
 * Marks fetched messages as SEEN so they aren't re-processed.
 */
export function fetchUnseenEmails() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASSWORD,
      host: process.env.IMAP_HOST,
      port: parseInt(process.env.IMAP_PORT || '993'),
      tls: process.env.IMAP_TLS !== 'false',
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    });

    const emails = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) return reject(err);

        imap.search(['UNSEEN'], (err, uids) => {
          if (err) return reject(err);
          if (!uids?.length) {
            imap.end();
            return resolve([]);
          }

          // Fetch in batches of 10 to avoid "Too long argument" error
          const BATCH_SIZE = 10;
          const batches = [];
          for (let i = 0; i < uids.length; i += BATCH_SIZE) {
            batches.push(uids.slice(i, i + BATCH_SIZE));
          }

          let batchIndex = 0;

          function fetchNextBatch() {
            if (batchIndex >= batches.length) {
              imap.end();
              return resolve(emails);
            }

            const batch = batches[batchIndex++];
            const fetch = imap.fetch(batch, { bodies: '', markSeen: true });

            fetch.on('message', (msg) => {
              let rawEmail = '';
              msg.on('body', (stream) => {
                stream.on('data', (chunk) => rawEmail += chunk.toString());
              });
              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(rawEmail);
                  emails.push({
                    subject: parsed.subject || '',
                    text: parsed.text || parsed.html || '',
                    fromEmail: parsed.from?.value?.[0]?.address || '',
                  });
                } catch (e) {
                  console.error('[imap] Failed to parse message:', e.message);
                }
              });
            });

            fetch.once('error', reject);
            fetch.once('end', fetchNextBatch);
          }

          fetchNextBatch();
        });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}
