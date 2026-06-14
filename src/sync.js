import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function findTemplate(booking) {

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

  if (!booking.booking_number || !booking.date) {
    return { skipped: true, reason: 'missing booking_number or date' };
  }

  if (booking.action === 'cancelled' || booking.action === 'rejected') {
    const { data: existing } = await supabase
      .from('bookings')
      .select('id')
      .eq('booking_number', booking.booking_number)
      .eq('provider', booking.provider)
      .limit(1);

    if (!existing?.length) {
      return { skipped: true, reason: 'cancellation for unknown booking' };
    }

    await supabase
      .from('bookings')
      .update({ status: booking.action })
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
    if (existing[0].status !== 'confirmed') {
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
    date: booking.date,
    status: 'confirmed',
  });

  if (error) throw new Error(`Failed to insert booking: ${error.message}`);
  return { action: 'created', booking_number: booking.booking_number, tour_id: tour.id };
}
