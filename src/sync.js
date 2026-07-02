import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function findTemplate(booking) {
  // Treat "unknown" string as null — Claude sometimes returns this instead of null
  if (booking.time === 'unknown') booking.time = null;
  if (booking.language === 'unknown') booking.language = null;
  if (booking.tour_internal_code === 'unknown') booking.tour_internal_code = null;
  if (booking.booking_number === 'unknown') booking.booking_number = null;


  // 1. time + language + internal_code
  if (booking.time && booking.language && booking.tour_internal_code) {
    const { data, error } = await supabase
      .from('tour_templates')
      .select('*')
      .eq('time', booking.time)
      .eq('language', booking.language)
      .eq('internal_code', booking.tour_internal_code);
    if (data?.length) return data[0];
  }

  // 2. time + language
  if (booking.time && booking.language) {
    const { data, error } = await supabase
      .from('tour_templates')
      .select('*')
      .eq('time', booking.time)
      .eq('language', booking.language);
    if (data?.length) return data[0];
  }

  // 3. time only
  if (booking.time) {
    const { data, error } = await supabase
      .from('tour_templates')
      .select('*')
      .eq('time', booking.time);
    if (data?.length) return data[0];
  }

  // 4. No time available (e.g. website bookings that omit it) — fall back to
  // matching by internal_code (+ language if known), but ONLY if that narrows
  // it down to exactly one template. If there are multiple time slots for the
  // same tour/language, we can't safely guess which one, so we skip.
  if (!booking.time && booking.tour_internal_code) {
    let query = supabase
      .from('tour_templates')
      .select('*')
      .eq('internal_code', booking.tour_internal_code);
    if (booking.language) query = query.eq('language', booking.language);

    const { data } = await query;
    if (data?.length === 1) return data[0];
  }

  return null;
}

async function findOrCreateTour(templateId, date) {
  const { data: existing } = await supabase
    .from('tours')
    .select('*')
    .eq('template_id', templateId)
    .eq('date', date)
    .limit(1);

  if (existing?.length) return existing[0];

  const { data: created, error } = await supabase
    .from('tours')
    .insert({ template_id: templateId, date, status: 'scheduled' })
    .select()
    .single();

  if (error) throw new Error(`Failed to create tour: ${error.message}`);
  return created;
}

export async function syncBooking(booking) {
  if (!booking) return { skipped: true, reason: 'null booking' };

  // Civitatis prefixes amended booking numbers with 'A' — strip it and treat as amendment
  if (booking.provider === 'civitatis' && booking.booking_number?.startsWith('A')) {
    booking.booking_number = booking.booking_number.slice(1);
    booking.action = 'amended';
  }

  if (!booking.booking_number || !booking.date) {
    return { skipped: true, reason: 'missing booking_number or date' };
  }

  // Handle amendments — update date AND reassign to correct tour
  if (booking.action === 'amended') {
    const { data: existing } = await supabase
      .from('bookings')
      .select('id, tour_id')
      .eq('booking_number', booking.booking_number)
      .eq('provider', booking.provider)
      .limit(1);

    if (!existing?.length) {
      return { skipped: true, reason: 'amendment for unknown booking' };
    }

    // Get the template from the current tour so we can find/create the new tour
    const { data: currentTour } = await supabase
      .from('tours')
      .select('template_id')
      .eq('id', existing[0].tour_id)
      .single();

    if (!currentTour) {
      return { skipped: true, reason: 'amendment — current tour not found' };
    }

    // Find or create a tour on the new date with the same template
    const newTour = await findOrCreateTour(currentTour.template_id, booking.date);

    // Update booking with new date and new tour_id
    await supabase
      .from('bookings')
      .update({ date: booking.date, tour_id: newTour.id, modified_at: new Date().toISOString() })
      .eq('id', existing[0].id);

    return { action: 'amended', booking_number: booking.booking_number, new_tour_id: newTour.id };
  }

  if (booking.action === 'cancelled' || booking.action === 'rejected') {
    const { data: existing } = await supabase
      .from('bookings')
      .select('id, status')
      .eq('booking_number', booking.booking_number)
      .eq('provider', booking.provider)
      .limit(1);

    if (!existing?.length) {
      return { skipped: true, reason: 'cancellation for unknown booking' };
    }

    // Don't re-process if already in this exact state
    if (existing[0].status === booking.action) {
      return { action: 'already_exists', booking_number: booking.booking_number };
    }

    await supabase
      .from('bookings')
      .update({ status: booking.action, cancelled_at: new Date().toISOString() })
      .eq('id', existing[0].id);

    return { action: booking.action, booking_number: booking.booking_number };
  }

  const template = await findTemplate(booking);
  if (!template) {
    console.warn(
      `[sync] No template found for booking ${booking.booking_number} — ` +
      `time: ${booking.time}, lang: ${booking.language}, code: ${booking.tour_internal_code}`
    );
    return {
      skipped: true,
      reason: 'no matching template',
      booking_number: booking.booking_number,
      time: booking.time,
      language: booking.language,
    };
  }

  const tour = await findOrCreateTour(template.id, booking.date);

  const { data: existing } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('booking_number', booking.booking_number)
    .eq('provider', booking.provider)
    .limit(1);

  if (existing?.length) {
    // Never overwrite rejected or cancelled status with confirmed
    if (existing[0].status !== 'confirmed' && existing[0].status !== 'rejected' && existing[0].status !== 'cancelled') {
      await supabase
        .from('bookings')
        .update({ status: 'confirmed' })
        .eq('id', existing[0].id);
    }
    return { action: 'already_exists', booking_number: booking.booking_number };
  }

  const { error } = await supabase.from('bookings').insert({
    tour_id: tour.id,
    booking_number: booking.booking_number,
    provider: booking.provider,
    name: booking.name,
    email: booking.email,
    phone_number: booking.phone_number,
    people: booking.people,
    adults: booking.adults,
    youth: booking.youth,
    kids: booking.kids,
    date: booking.date,
    status: 'confirmed',
  });

  if (error) throw new Error(`Failed to insert booking: ${error.message}`);
  return { action: 'created', booking_number: booking.booking_number, tour_id: tour.id };
}
