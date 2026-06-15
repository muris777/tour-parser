/**
 * AI-powered email parser using Claude Haiku.
 * Pre-filters by sender domain before calling Claude to save tokens.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Only call Claude for emails from these domains
const KNOWN_PROVIDERS = {
  'freetour.com':              'freetour',
  'viator.com':                'viator',
  'civitatis.com':             'civitatis',
  'guruwalk.com':              'guruwalk',
  'meine-landausfluege.de':   'meine-landausfluege',
  'tripup.com':                'meine-landausfluege',
};

// Civitatis support/help emails — not booking notifications, skip these
const SKIP_SENDERS = [
  'ayuda@civitatis.com',
  'soporte@civitatis.com',
  'support@civitatis.com',
  'slara@civitatis.com',
  'invoicing@civitatis.com',
];

// Compact system prompt — shorter = fewer input tokens per call
const SYSTEM_PROMPT = `Parse booking emails for a Riga tour company. Return ONLY JSON, no text.

Language: always English (Español→Spanish, Français→French, Deutsch→German, Italiano→Italian, Inglese→English)
Viator: get time from "Tour Grade" (e.g. "English Tour 10:30"→10:30) or "Tour Grade Code" (e.g. "TG1~10:30"→10:30); language from "Tour Grade Description" or "Tour Language"
Date: YYYY-MM-DD, assume 2026 if no year
Time: HH:MM 24h
Action: confirmed|cancelled|rejected|amended|manual_required|unknown
Provider: freetour|viator|civitatis|guruwalk|meine-landausfluege|unknown
meine-landausfluege/TripUp emails → action=manual_required

JSON: {"p":"provider","a":"action","bn":"booking_number","n":"name","e":"email","ph":"phone","ppl":0,"d":"date","t":"time","l":"language","ic":"internal_code"}
IMPORTANT: use null for any missing/unknown field values, never use the string "unknown"`;

// Extract only booking-relevant lines from email body
const KEEP_PATTERNS = [
  /booking|reservation|reserva/i,
  /tour|activity|actividad/i,
  /date|travel|salida|fecha/i,
  /time|hour|hora/i,
  /language|idioma|langue|sprache/i,
  /traveler|adult|people|adulto|walker|attendee/i,
  /name|nombre|nom/i,
  /email/i,
  /phone|tel/i,
  /grade|code/i,
  /internal/i,
  /cancel|reject|amend/i,
  /reference|ref|número/i,
  /confirmed|confirmation/i,
  /customer|client/i,
];

const NOISE_PATTERNS = [
  /unsubscribe|privacy|rights reserved|do not reply|automated/i,
  /instagram|facebook|twitter|linkedin|youtube|tiktok/i,
  /baarerstrasse|needham|guillem de castro/i,
  /help center|management center/i,
  /send the customer|acknowledge this|download the/i,
  /©|copyright/i,
];

function extractRelevantLines(text) {
  return text.split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t || t.length > 120) return false;
      if (NOISE_PATTERNS.some(p => p.test(t))) return false;
      if (KEEP_PATTERNS.some(p => p.test(t))) return true;
      if (t.length < 50) return true; // short lines are often values
      return false;
    })
    .join('\n')
    .slice(0, 1500);
}

// Expand compact JSON field names back to full names
function expandResponse(compact) {
  return {
    provider:          compact.p  ?? 'unknown',
    action:            compact.a  ?? 'unknown',
    booking_number:    compact.bn ?? null,
    name:              compact.n  ?? null,
    email:             compact.e  ?? null,
    phone_number:      compact.ph ?? null,
    people:            compact.ppl ?? null,
    date:              compact.d  ?? null,
    time:              compact.t  ?? null,
    language:          compact.l  ?? null,
    tour_internal_code: compact.ic ?? null,
  };
}

export async function parseEmail(subject, text, fromEmail) {
  // Pre-filter: only process emails from known booking providers
  const domain = fromEmail?.split('@')[1]?.toLowerCase();
  const provider = Object.entries(KNOWN_PROVIDERS).find(([d]) => domain?.includes(d))?.[1];

  if (!provider) return null; // silently skip unknown senders

  // Skip known non-booking addresses even from valid domains
  if (SKIP_SENDERS.includes(fromEmail?.toLowerCase())) return null;

  // Meine Landausflüge — no need to call Claude, we know what it is
  if (provider === 'meine-landausfluege') {
    const bnMatch = subject?.match(/#(\d+)/);
    console.warn(`📋 MANUAL REQUIRED [meine-landausfluege] #${bnMatch?.[1] ?? '?'} — check provider portal`);
    return null; // don't add to DB
  }

  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const body = extractRelevantLines(text);
  const emailContent = `From: ${fromEmail}\nSubject: ${subject}\n\n${body}`;

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
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: emailContent }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text?.trim();
    if (!rawText) throw new Error('Empty response from Claude');

    const clean = rawText.replace(/```json|```/g, '').trim();
    const compact = JSON.parse(clean);
    const parsed = expandResponse(compact);

    if (parsed.action === 'unknown') return null;
    return parsed;

  } catch (err) {
    console.error(`❌ Parse error for "${subject}": ${err.message}`);
    return null;
  }
}
