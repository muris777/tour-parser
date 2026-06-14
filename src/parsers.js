/**
 * AI-powered email parser using Claude.
 * Replaces all regex parsers with a single Claude API call.
 * Claude extracts structured booking data from any provider format.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are a booking email parser for a tour company in Riga, Latvia.
Extract booking information from emails and return ONLY a JSON object with no other text.

Rules:
- action: "confirmed", "cancelled", or "rejected"
- date: YYYY-MM-DD format always
- time: HH:MM 24-hour format always (convert from 12h if needed, e.g. "11:00 AM" → "11:00", "6:00 PM" → "18:00")
- language: always in English word (convert "Español" → "Spanish", "Français" → "French", "Deutsch" → "German", "Italiano" → "Italian", "Inglese" → "English", "Tedesco" → "German", "Francese" → "French", "Spagnolo" → "Spanish", "Italiano" → "Italian")
- people: integer number of people
- If a field is not found, use null
- If the email is not a booking confirmation, cancellation, or rejection, set action to "unknown"

Return this exact JSON structure:
{
  "provider": "freetour|viator|civitatis|guruwalk|unknown",
  "action": "confirmed|cancelled|rejected|unknown",
  "booking_number": "string or null",
  "name": "string or null",
  "email": "string or null",
  "phone_number": "string or null",
  "people": number or null,
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "language": "English word or null",
  "tour_internal_code": "string or null",
  "tour_title": "string or null"
}`;

export async function parseEmail(subject, text, fromEmail) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable not set');
  }

  const emailContent = `From: ${fromEmail}
Subject: ${subject}

${text.slice(0, 3000)}`; // Limit to 3000 chars to save tokens

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
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Parse this email and return only JSON:\n\n${emailContent}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error: ${response.status} ${err}`);
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text?.trim();

    if (!rawText) throw new Error('Empty response from Claude');

    // Strip any accidental markdown code fences
    const clean = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Skip non-booking emails
    if (parsed.action === 'unknown') {
      return null;
    }

    return parsed;

  } catch (err) {
    console.error(`[parse] Claude error for "${subject}":`, err.message);
    return null;
  }
}
