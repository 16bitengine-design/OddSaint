import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { PLANS, isValidPlanId, SAINTS_LOCK_PLANS, isValidSaintsLockPlanId } from '@/lib/plans';

// ---------------------------------------------------------------------------
// Grants access after a verified successful payment. Used by every payment
// entry point (PawaPay webhook, PawaPay status poll, Pesapal webhook,
// Pesapal status poll, and the admin comp-access route) so the actual
// "what happens on a successful payment" logic only ever exists in one
// place, regardless of which product was purchased or which provider
// processed it.
// ---------------------------------------------------------------------------

export async function grantAccessForPayment(params: {
  product: string | undefined;
  userId: string | undefined;
  planId: string | undefined;
  email: string | undefined;
  /** Required for product === 'ticket_unlock'; ignored otherwise. */
  ticketId?: string | null;
}): Promise<void> {
  const { product, userId, planId, email, ticketId } = params;

  if (!userId) {
    // eslint-disable-next-line no-console
    console.warn('[grantAccess] Missing userId, nothing granted:', params);
    return;
  }

  const supabase = getSupabaseAdmin();

  // ---------------------------------------------------------------------
  // Pay-per-ticket unlock — grants access to exactly one ticket, not a
  // dated plan, so it's handled separately from the planId-based branches
  // below. See supabase/migrations/004_ticket_unlocks.sql.
  // ---------------------------------------------------------------------
  if (product === 'ticket_unlock') {
    if (!ticketId) {
      // eslint-disable-next-line no-console
      console.warn('[grantAccess] ticket_unlock payment missing ticketId, nothing granted:', params);
      return;
    }
    const { error } = await supabase
      .from('ticket_unlocks')
      .upsert({ user_id: userId, ticket_id: ticketId, email });
    if (error) throw error;
    return;
  }

  if (!planId) {
    // eslint-disable-next-line no-console
    console.warn('[grantAccess] Missing planId, nothing granted:', params);
    return;
  }

  if (product === 'saints_lock') {
    if (!isValidSaintsLockPlanId(planId)) {
      // eslint-disable-next-line no-console
      console.warn('[grantAccess] Unrecognized Saint\'s Lock plan id:', planId);
      return;
    }
    const plan = SAINTS_LOCK_PLANS[planId];
    const expiresAt = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase
      .from('saints_lock_access')
      .upsert({ user_id: userId, email, active: true, expires_at: expiresAt });
    if (error) throw error;
    return;
  }

  // Default / 'subscription' product.
  if (!isValidPlanId(planId)) {
    // eslint-disable-next-line no-console
    console.warn('[grantAccess] Unrecognized subscription plan id:', planId);
    return;
  }
  const plan = PLANS[planId];
  const expiresAt = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('subscribers')
    .upsert({ user_id: userId, email, active: true, expires_at: expiresAt });
  if (error) throw error;
}
