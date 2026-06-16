/**
 * AI-powered email parser using Claude Haiku.
 * Pre-filters by sender domain before calling Claude to save tokens.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Only call Claude for emails from these known sender addresses/domains
// Viator uses multiple addresses including dynamic tripadvisor ones
const PROVIDER_PATTERNS = [
  { pattern: /freetour\.com$/i,                      provider: 'freetour' },
  { pattern: /viator\.com$/i,                        provider: 'viator' },
  { pattern: /tripadvisor\.com$/i,                   provider: 'viator' },
  { pattern: /expmessaging\.tripadvisor\.com$/i,     provider: 'viator' },
  { pattern: /t1\.viator\.com$/i,                    provider: 'viator' },
  { pattern: /civitatis\.com$/i,                     provider: 'civitatis' },
  { pattern: /guruwalk\.com$/i,                      provider: 'guruwalk' },
  { pattern: /meine-landausfluege\.de$/i,            provider: 'meine-landausfluege' },
  { pattern: /tripup\.com$/i,                        provider: 'meine-landausfluege' },
];

// Civitatis support/help emails — not booking notifications, skip these
const SKIP_SENDERS = [
  'ayuda@civitatis.com',
  'soporte@civitatis.com',
  'support@civitatis.com',
  'slara@civitatis.com',
  'invoicing@civitatis.com',
  'calidad@guruwalk.com',
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

- Freetour IMPORTANT: "Rechazar esta reserva", "Reject this booking", and "reject this booking in order to inform the customer" are ACTION BUTTONS/LINKS for the operator — they do NOT mean the booking is rejected. Only set action=rejected if the email explicitly states the booking WAS ALREADY rejected (e.g. "You have successfully rejected the booking"). Both "Reserva Garantizada Confirmada" (Spanish) and "Confirmed Guaranteed Booking" (English) mean action=confirmed.
- Freetour CANCELLATION: "Your customer: [Name] has cancelled his or her booking (#[number])" or "ha cancelado su reserva" means action=cancelled. This is a genuine customer-initiated cancellation, distinct from a rejection.
- Viator cancellation emails have subject "Booking Canceled" and contain "Booking Reference: #BR-..." with "Canceled" below it — set action=cancelled for these, even if they come from a "noreply" address. 
- Viator customer messages/conversations (subject starts with "Conversation with" or contains "wrote:") are NOT booking actions — set action=unknown and all other fields null. Do not quote or include any customer message text in your JSON response.
- Total people (ppl field) = sum of ALL traveler categories mentioned (adults + children + infants + seniors, etc.), not just the first category listed. Look for labels like "Adultos", "Niños", "Adults", "Children", "Kids", "Infants" and add them all together.

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
  /cancel|reject|amend|canceled|cancellation|booking canceled|canceled|cancell/i,
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

// Provider system emails that should never be saved as guest email
const PROVIDER_EMAILS = [
  /expmessaging\.tripadvisor\.com/i,
  /tripadvisor\.com/i,
  /viator\.com/i,
  /civitatis\.com/i,
  /guruwalk\.com/i,
  /freetour\.com/i,
  /privaterelay\.appleid\.com/i,
];

function isProviderEmail(email) {
  if (!email) return true;
  return PROVIDER_EMAILS.some(p => p.test(email));
}

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
  const provider = PROVIDER_PATTERNS.find(({ pattern }) => pattern.test(domain || ''))?.provider;

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
    let compact;
    try {
      compact = JSON.parse(clean);
    } catch (parseErr) {
      console.warn(`⚠️  Skipping unparseable response for "${subject}"`);
      return null;
    }
    const parsed = expandResponse(compact);

    if (parsed.action === 'unknown') return null;
    return parsed;

  } catch (err) {
    console.error(`❌ Parse error for "${subject}": ${err.message}`);
    return null;
  }
}
