/**
 * Email parsers for each booking provider.
 * Each parser returns a normalised BookingData object or null if unrecognised.
 *
 * BookingData shape:
 * {
 *   provider: string,
 *   action: 'confirmed' | 'cancelled' | 'rejected',
 *   booking_number: string,
 *   name: string,
 *   email: string | null,
 *   phone_number: string | null,
 *   number_of_people: number,
 *   date: string,        // YYYY-MM-DD
 *   time: string,        // HH:MM (24h)
 *   language: string | null,
 *   tour_internal_code: string | null,
 *   tour_title: string | null,
 * }
 */

// ─── Helpers ───────────────────────────────────────────────────────────────

const MONTH_MAP_EN = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const MONTH_MAP_ES = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05',
  junio: '06', julio: '07', agosto: '08', septiembre: '09', sep: '09',
  octubre: '10', noviembre: '11', diciembre: '12',
};

function toISO(day, monthStr, year) {
  const m = MONTH_MAP_EN[monthStr?.toLowerCase()?.slice(0, 3)]
    || MONTH_MAP_ES[monthStr?.toLowerCase()]
    || monthStr?.padStart(2, '0');
  return `${year}-${m}-${String(day).padStart(2, '0')}`;
}

function convertTime(raw) {
  if (!raw) return null;
  // Already 24h
  if (/^\d{1,2}:\d{2}$/.test(raw.trim())) {
    const [h, m] = raw.trim().split(':');
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  // 12h with AM/PM
  const match = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const pm = match[3].toUpperCase() === 'PM';
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${match[2]}`;
}

function extractPeople(str) {
  if (!str) return 1;
  const n = parseInt(str.match(/\d+/)?.[0]);
  return isNaN(n) ? 1 : n;
}


// ─── Freetour.com ──────────────────────────────────────────────────────────

export function parseFreetour(subject, text, fromEmail) {
  if (!fromEmail?.includes('freetour.com')) return null;

  // Cancellation: "has cancelled his or her booking (#REF) for TOUR at TIME on DATE"
  const cancelMatch = text.match(
    /has cancelled.*?booking \(#([^)]+)\).*?for (.+?) at (\d{1,2}:\d{2} (?:AM|PM)) on (\d{4}-\d{2}-\d{2})/i
  );
  if (cancelMatch) {
    return {
      provider: 'freetour',
      action: 'cancelled',
      booking_number: cancelMatch[1].trim(),
      name: extractFreetourCancelName(text),
      email: null,
      phone_number: null,
      number_of_people: 1,
      date: cancelMatch[4],
      time: convertTime(cancelMatch[3]),
      language: null,
      tour_internal_code: null,
      tour_title: cancelMatch[2].trim(),
    };
  }

  // Rejection: "You have successfully rejected the booking REF for TOUR at TIME on DATE"
  const rejectMatch = text.match(
    /You have successfully rejected the booking\s+(\S+)\s+for (.+?) at (\d{1,2}:\d{2} (?:AM|PM)) on (\d{4}-\d{2}-\d{2})/i
  );
  if (rejectMatch) {
    return {
      provider: 'freetour',
      action: 'rejected',
      booking_number: rejectMatch[1].trim(),
      name: null,
      email: null,
      phone_number: null,
      number_of_people: 1,
      date: rejectMatch[4],
      time: convertTime(rejectMatch[3]),
      language: null,
      tour_internal_code: null,
      tour_title: rejectMatch[2].trim(),
    };
  }

  // Booking (Spanish): "Salida: TIME, Month DD, YYYY"
  const bookingDateMatch = text.match(
    /Salida:\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?),\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/i
  );
  const bookingRefMatch = text.match(/Referencia de Reserva:\s*(\S+)/i);
  const bookingNameMatch = text.match(/Reserva a nombre:\s*(.+)/i);
  const bookingEmailMatch = text.match(/Email de reserva:\s*(\S+)/i);
  const bookingPhoneMatch = text.match(/Teléfono de reserva:\s*(\S+)/i);
  const bookingLangMatch = text.match(/Idioma:\s*(.+)/i);
  const bookingPeopleMatch = text.match(/Adultos:\s*(\d+)/i);

  if (bookingDateMatch && bookingRefMatch) {
    const [, rawTime, month, day, year] = bookingDateMatch;
    return {
      provider: 'freetour',
      action: 'confirmed',
      booking_number: bookingRefMatch[1].trim(),
      name: bookingNameMatch?.[1]?.trim() || null,
      email: bookingEmailMatch?.[1]?.trim() || null,
      phone_number: bookingPhoneMatch?.[1]?.trim() || null,
      number_of_people: extractPeople(bookingPeopleMatch?.[1]),
      date: toISO(day, month, year),
      time: convertTime(rawTime.trim()),
      language: bookingLangMatch?.[1]?.trim() || null,
      tour_internal_code: null,
      tour_title: null,
    };
  }

  return null;
}

function extractFreetourCancelName(text) {
  const m = text.match(/Your customer:\s*(.+?)\s+has cancelled/i);
  return m?.[1]?.trim() || null;
}


// ─── Viator ────────────────────────────────────────────────────────────────

export function parseViator(subject, text, fromEmail) {
  if (!fromEmail?.includes('viator.com') && !subject?.toLowerCase().includes('viator')) return null;

  // Viator only sends confirmations (cancellations go to a separate system)
  const refMatch = text.match(/Booking Reference:\s*(\S+)/i);
  if (!refMatch) return null;

  const tourNameMatch = text.match(/Tour Name:\s*(.+)/i);
  const travelDateMatch = text.match(/Travel Date:\s*(.+)/i);
  const travelerNameMatch = text.match(/Lead Traveler Name:\s*(.+)/i);
  const travelersMatch = text.match(/Travelers:\s*(\d+)/i);
  const tourGradeMatch = text.match(/Tour Grade:\s*(.+)/i);
  const tourGradeDescMatch = text.match(/Tour Grade Description:\s*(.+)/i);

  // Parse "Sun, Aug 30, 2026"
  const dateStr = travelDateMatch?.[1]?.trim();
  const dateMatch = dateStr?.match(/\w+,\s*(\w+)\s+(\d+),\s*(\d{4})/);
  const isoDate = dateMatch ? toISO(dateMatch[2], dateMatch[1], dateMatch[3]) : null;

  // Time is embedded in Tour Grade: "Spanish Tour 11:00" or grade code "TG2~11:00"
  const timeFromGrade = tourGradeMatch?.[1]?.match(/(\d{1,2}:\d{2})/)?.[1];
  const timeFromCode = text.match(/Tour Grade Code:\s*\S+~(\d{1,2}:\d{2})/i)?.[1];
  const rawTime = timeFromGrade || timeFromCode;

  // Language from Tour Grade Description
  const lang = tourGradeDescMatch?.[1]?.trim() || null;

  return {
    provider: 'viator',
    action: 'confirmed',
    booking_number: refMatch[1].trim(),
    name: travelerNameMatch?.[1]?.trim() || null,
    email: null,
    phone_number: null,
    number_of_people: extractPeople(travelersMatch?.[1]),
    date: isoDate,
    time: rawTime ? convertTime(rawTime) : null,
    language: lang,
    tour_internal_code: null,
    tour_title: tourNameMatch?.[1]?.trim() || null,
  };
}


// ─── Civitatis ─────────────────────────────────────────────────────────────

export function parseCivitatis(subject, text, fromEmail) {
  if (!fromEmail?.includes('civitatis.com') && !subject?.toLowerCase().includes('civitatis')) return null;

  const refMatch = text.match(/Reservation number:\s*(\S+)/i);
  if (!refMatch) return null;

  const internalCodeMatch = text.match(/Internal code:\s*(.+)/i);
  const langMatch = text.match(/Language:\s*(.+)/i);
  const dateMatch = text.match(/Date:\s*\w+,\s*(\w+)\s+(\d+),\s*(\d{4})/i);
  const hourMatch = text.match(/Hour:\s*(\d{1,2}:\d{2})/i);
  const nameMatch = text.match(/Name:\s*(.+)/i);
  const surnameMatch = text.match(/Surname:\s*(.+)/i);
  const peopleMatch = text.match(/(\d+)\s+Adulto/i);
  const activityMatch = text.match(/Activity:\s*(.+?)(?:\s+-\s+Tour|$)/im);

  const name = [nameMatch?.[1]?.trim(), surnameMatch?.[1]?.trim()]
    .filter(Boolean).join(' ') || null;

  const isoDate = dateMatch
    ? toISO(dateMatch[2], dateMatch[1], dateMatch[3])
    : null;

  // Civitatis only sends booking confirmations, not cancellations via email
  return {
    provider: 'civitatis',
    action: 'confirmed',
    booking_number: refMatch[1].trim(),
    name,
    email: null,
    phone_number: null,
    number_of_people: extractPeople(peopleMatch?.[1]),
    date: isoDate,
    time: hourMatch ? convertTime(hourMatch[1]) : null,
    language: langMatch?.[1]?.trim() || null,
    tour_internal_code: internalCodeMatch?.[1]?.trim() || null,
    tour_title: activityMatch?.[1]?.trim() || null,
  };
}


// ─── GuruWalk ──────────────────────────────────────────────────────────────

export function parseGuruwalk(subject, text, fromEmail) {
  if (!fromEmail?.includes('guruwalk.com') && !subject?.toLowerCase().includes('guruwalk')) return null;

  const codeMatch = text.match(/Booking code:\s*(\S+)/i);
  if (!codeMatch) return null;

  const walkerMatch = text.match(/Walker:\s*(.+)/i);
  const phoneMatch = text.match(/Phone\s*[\r\n]+(.+)/i);
  const attendeesMatch = text.match(/Attendees:\s*(\d+)/i);
  const langMatch = text.match(/Language:\s*(.+)/i);
  const dateMatch = text.match(/Date:\s*\w+,\s*(\w+)\s+(\d+),\s*(\d{4})/i);
  const timeMatch = text.match(/Time:\s*(\d{1,2}:\d{2})/i);
  const tourMatch = text.match(/GuruWalk:\s*(.+)/i);

  const isoDate = dateMatch
    ? toISO(dateMatch[2], dateMatch[1], dateMatch[3])
    : null;

  // Guruwalk only sends booking confirmations
  return {
    provider: 'guruwalk',
    action: 'confirmed',
    booking_number: codeMatch[1].trim(),
    name: walkerMatch?.[1]?.trim() || null,
    email: null,
    phone_number: phoneMatch?.[1]?.trim() || null,
    number_of_people: extractPeople(attendeesMatch?.[1]),
    date: isoDate,
    time: timeMatch ? convertTime(timeMatch[1]) : null,
    language: langMatch?.[1]?.trim() || null,
    tour_internal_code: null,
    tour_title: tourMatch?.[1]?.trim() || null,
  };
}


// ─── Main dispatcher ───────────────────────────────────────────────────────

export function parseEmail(subject, text, fromEmail) {
  return (
    parseFreetour(subject, text, fromEmail) ||
    parseViator(subject, text, fromEmail) ||
    parseCivitatis(subject, text, fromEmail) ||
    parseGuruwalk(subject, text, fromEmail) ||
    null
  );
}
