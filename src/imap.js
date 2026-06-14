import Imap from 'imap';
import { simpleParser } from 'mailparser';

/**
 * Connects to the IMAP inbox and fetches all UNSEEN messages.
 * Returns an array of { subject, text, fromEmail } objects.
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
      imap.openBox('INBOX', false, (err, box) => {
        if (err) return reject(err);

        imap.search(['UNSEEN'], (err, uids) => {
          if (err) return reject(err);
          if (!uids?.length) {
            imap.end();
            return resolve([]);
          }

          const fetch = imap.fetch(uids, { bodies: '', markSeen: true });

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
          fetch.once('end', () => {
            imap.end();
            resolve(emails);
          });
        });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}
