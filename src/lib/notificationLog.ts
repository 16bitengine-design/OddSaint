import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Odd Saint — notification idempotency ledger (Vercel/Next.js runtime)
// See scripts/lib/notificationLog.mjs for the full rationale — same
// insert-first pattern, TS/Vercel side.
// ---------------------------------------------------------------------------

export async function tryClaimNotification(
  supabase: SupabaseClient,
  params: { userId: string; email: string | null | undefined; eventType: string; referenceId: string }
): Promise<boolean> {
  const { error } = await supabase.from('notification_log').insert({
    user_id: params.userId,
    email: params.email,
    event_type: params.eventType,
    reference_id: params.referenceId,
  });

  if (error) {
    if ((error as { code?: string }).code === '23505') return false; // already sent
    throw error;
  }
  return true;
}
