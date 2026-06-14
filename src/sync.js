import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Find the best matching tour_template for a parsed booking.
 * Matches on internal_code first, then falls back to time + language fuzzy match.
 */
async function findTemplate(booking) {
  // Best: direct internal code match (Civitatis provides this)
  if (booking.tour_internal_code) {
    const { data } = await supabase
      .from('tour_templates')
      .select('*')
      .ilike('title', `%${booking.tour_internal_code}%`)
      .limit(1);
    if (data?.length) return data[0];
  }

  // Fallback: match on time + language
  if (booking.time && booking.language) {
    const { data } = await supabase
      .from('tour_templates')
      .select('*')
      .eq('time', booking.time)
      .ilike('language', `%${booking.language}%`)
      .limit(1);
    if (data?.length) return data[0];
  }

  // Fallback: match on time only
  if (booking.time) {
    const { data } = await supabase
      .from('tour_templates')
      .select('*')
      .eq('time', booking.time)
      .limit(1);
    if (data?.length) return data[0];
  }

  return null;
}

/**
 * Find or create a Tours row for a given template + date.
 */
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

/**
 * Process a parsed booking object and sync it to Supabase.
 */
export async function syncBooking(booking) {
  if (!booking) return { skipped: true, reason: 'null booking' };

  // Validate we have enough data
  if (!booking.booking_number || !booking.date) {
    return { skipped: true, reason: 'missing booking_number or date' };
  }

  // Handle cancellations and rejections
  if (booking.action === 'cancelled' || booking.action === 'rejected') {
    const { data: existing } = await supabase
      .from('bookings')
      .select('id')
      .eq('booking_number', booking.booking_number)
      .eq('provider', booking.provider)
      .limit(1);

    if (!existing?.length) {
      return { skipped: true, reason: 'cancellation for unknown booking_number' };
    }

    const { error } = await supabase
      .from('bookings')
      .update({ status: booking.action })
      .eq('id', existing[0].id);

    if (error) throw new Error(`Failed to update booking status: ${error.message}`);
    return { action: booking.action, booking_number: booking.booking_number };
  }

  // Confirmed booking — find or create the tour
  const template = await findTemplate(booking);
  if (!template) {
    console.warn(`[sync] No template found for booking ${booking.booking_number} — skipping`);
    return { skipped: true, reason: 'no matching template', booking_number: booking.booking_number };
  }

  const tour = await findOrCreateTour(template.id, booking.date);

  // Check if booking already exists (idempotent)
  const { data: existing } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('booking_number', booking.booking_number)
    .eq('provider', booking.provider)
    .limit(1);

  if (existing?.length) {
    // Already in DB — only update if status changed
    if (existing[0].status !== 'confirmed') {
      await supabase
        .from('bookings')
        .update({ status: 'confirmed' })
        .eq('id', existing[0].id);
    }
    return { action: 'already_exists', booking_number: booking.booking_number };
  }

  // Insert new booking
  const { error } = await supabase.from('bookings').insert({
    tour_id: tour.id,
    booking_number: booking.booking_number,
    provider: booking.provider,
    name: booking.name,
    email: booking.email,
    phone_number: booking.phone_number,
    people: booking.number_of_people,
    date: booking.date,
    status: 'confirmed',
  });

  if (error) throw new Error(`Failed to insert booking: ${error.message}`);
  return { action: 'created', booking_number: booking.booking_number, tour_id: tour.id };
}
