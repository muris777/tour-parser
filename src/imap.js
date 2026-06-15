import Imap from 'imap';
import { simpleParser } from 'mailparser';

function htmlToText(html) {
  if (!html) return '';
  return html
    // Remove preheader tracking spam first (Viator uses &zwnj;&nbsp; extensively)
    .replace(/(&zwnj;|&nbsp;|\u200C|\u00A0){3,}/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Remove style and script blocks
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Convert block elements to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&zwnj;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&copy;/g, '©')
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
                  // Prefer plain text, fall back to HTML converted to text
                  const text = parsed.text
                    ? parsed.text
                    : htmlToText(parsed.html || '');

                  emails.push({
                    subject: parsed.subject || '',
                    text,
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
