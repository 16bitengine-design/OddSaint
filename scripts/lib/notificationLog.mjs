// ---------------------------------------------------------------------------
// Odd Saint — notification idempotency ledger (GitHub Actions runtime)
//
// tryClaimNotification INSERTS FIRST, then the caller only sends the email
// if the insert succeeded. A unique-constraint violation (Postgres error
// code 23505) means another run already claimed this exact
// user+event+reference combination — treat that as "already sent", not an
// error. This is deliberately insert-then-send rather than
// check-then-send, which would have a race window if two workflow runs
// ever overlapped.
// ---------------------------------------------------------------------------

export async function tryClaimNotification(supabase, { userId, email, eventType, referenceId }) {
  const { error } = await supabase.from('notification_log').insert({
    user_id: userId,
    email,
    event_type: eventType,
    reference_id: referenceId,
  });

  if (error) {
    if (error.code === '23505') return false; // already sent — not an error
    throw error;
  }
  return true;
}

/** Today's UTC send count across every event type — used to respect Brevo's free-tier daily cap. */
export async function countSentToday(supabase) {
  const startOfDayUTC = new Date();
  startOfDayUTC.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('notification_log')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', startOfDayUTC.toISOString());

  if (error) throw error;
  return count ?? 0;
}
