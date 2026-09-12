import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { PLANS, isValidPlanId, SAINTS_LOCK_PLANS, isValidSaintsLockPlanId } from '@/lib/plans';
import { sendBrevoEmail } from '@/lib/brevo';
import { tryClaimNotification } from '@/lib/notificationLog';
import { welcomeSubscriptionEmail, welcomeSaintsLockEmail } from '@/lib/emailTemplates';

// ---------------------------------------------------------------------------
// Grants access after a verified successful payment. Used by both the
// PawaPay and Pesapal webhook handlers (plus the admin comp route) so the
// actual "what happens on a successful payment" logic only exists in one
// place.
//
// WELCOME EMAILS: fire from here rather than from each individual webhook,
// for the same reason access-granting itself lives here — one chokepoint
// means a welcome email can never be duplicated or missed depending on
// which payment provider or admin path triggered the grant.
// sendWelcomeEmailOnce uses notification_log's insert-first idempotency
// (see src/lib/notificationLog.ts) keyed on 'lifetime', so a renewal or a
// repeat purchase of the same product never re-sends the welcome email —
// only the very first successful grant for that product does.
// ---------------------------------------------------------------------------

export async function grantAccessForPayment(params: {
  product: string | undefined;
  userId: string | undefined;
  planId: string | undefined;
  email: string | undefined;
}): Promise<void> {
  const { product, userId, planId, email } = params;

  if (!userId || !planId) {
    // eslint-disable-next-line no-console
    console.warn('[grantAccess] Missing userId/planId, nothing granted:', params);
    return;
  }

  const supabase = getSupabaseAdmin();

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

    await sendWelcomeEmailOnce(supabase, userId, email, 'saints_lock');
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

  await sendWelcomeEmailOnce(supabase, userId, email, 'subscription');
}

/**
 * Sends the one-time welcome email for a product, guarded by
 * notification_log so it can never fire twice for the same user+product
 * even across retries, renewals, or a duplicate webhook delivery. Email
 * failures are caught and logged, never thrown — a Brevo outage must never
 * cause a successful payment/access-grant to report as failed, since the
 * access itself was already granted above by the time this runs.
 */
async function sendWelcomeEmailOnce(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  email: string | undefined,
  product: 'subscription' | 'saints_lock'
): Promise<void> {
  if (!email) return;
  const eventType = product === 'saints_lock' ? 'welcome_saints_lock' : 'welcome_subscription';
  try {
    const claimed = await tryClaimNotification(supabase, { userId, email, eventType, referenceId: 'lifetime' });
    if (!claimed) return; // already welcomed — never resend on renewal/repeat purchase
    const tpl = product === 'saints_lock' ? welcomeSaintsLockEmail() : welcomeSubscriptionEmail();
    await sendBrevoEmail({ to: email, ...tpl, tags: [eventType] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[grantAccess] Welcome email failed (access was still granted successfully):', err);
  }
}
