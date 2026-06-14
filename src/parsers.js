/**
 * AI-powered email parser using Claude Haiku.
 * Strips noise from emails before sending to minimize token usage.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are a booking email parser for a tour company in Riga, Latvia.
Extract booking information and return ONLY a JSON object, no other text.

Language normalisation (always output English):
Español/Spagnolo → Spanish, Français/Francese → French, Deutsch/Tedesco → German, Italiano → Italian, Inglese → English

Return this exact JSON:
{"provider":"freetour|viator|civitatis|guruwalk|unknown","action":"confirmed|cancelled|rejected|amended|unknown","booking_number":null,"name":null,"email":null,"phone_number":null,"people":null,"date":"YYYY-MM-DD","time":"HH:MM","language":null,"tour_internal_code":null,"tour_title":null}

Rules:
- date: YYYY-MM-DD always
- time: HH:MM 24h always (11:00 AM → 11:00, 6:00 PM → 18:00)
- people: integer only
- action: "amended" if the email says "Booking Amended" or "amended" or "amendment"
- action unknown = not a booking email
- if the email is from meine-landausfluege.de or mentions "Meine Landausflüge" or "TripUp", set provider to "meine-landausfluege" and action to "manual_required" — these emails have no tour details in the body
- null for missing fields`;

// Lines containing these strings are pure noise — strip them
const NOISE_PATTERNS = [
  /unsubscribe/i,
  /privacy policy/i,
  /terms of service/i,
  /all rights reserved/i,
  /do not reply/i,
  /no.reply/i,
  /automated message/i,
  /instagram|facebook|twitter|linkedin|youtube|tiktok|pinterest/i,
  /baarerstrasse/i,
  /needham, ma/i,
  /guillem de castro/i,
  /©/,
  /^\s*$/, // blank lines (handled separately)
];

function stripNoise(text) {
  const lines = text.split('\n');
  const cleaned = lines.filter(line => !NOISE_PATTERNS.some(p => p.test(line)));

  // Collapse multiple blank lines into one
  const collapsed = cleaned.reduce((acc, line) => {
    if (line.trim() === '' && acc[acc.length - 1]?.trim() === '') return acc;
    acc.push(line);
    return acc;
  }, []);

  // Limit to 1500 chars — enough for all booking fields, saves ~50% tokens
  return collapsed.join('\n').slice(0, 1500);
}

export async function parseEmail(subject, text, fromEmail) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable not set');
  }

  const cleaned = stripNoise(text);
  const emailContent = `From: ${fromEmail}\nSubject: ${subject}\n\n${cleaned}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Parse this email:\n\n${emailContent}` }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error: ${response.status} ${err}`);
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text?.trim();
    if (!rawText) throw new Error('Empty response from Claude');

    const clean = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (parsed.action === "unknown") return null;
    if (parsed.action === "manual_required") return { ...parsed, manual_required: true };
    return parsed;

  } catch (err) {
    console.error(`[parse] Claude error for "${subject}":`, err.message);
    return null;
  }
}
