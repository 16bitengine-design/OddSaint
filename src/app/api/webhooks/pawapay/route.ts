import { NextRequest, NextResponse } from 'next/server';
import { checkDepositStatus } from '@/lib/pawapay';
import { grantAccessForPayment } from '@/lib/grantAccess';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

// ---------------------------------------------------------------------------
// POST /api/webhooks/pawapay
// Configure this as the callback URL in your PawaPay dashboard.
//
// SECURITY: payload.status is NOT trusted directly. The client already
// knows its own depositId (it's returned from /api/checkout so the
// frontend can poll with it), so accepting {depositId, status:
// 'COMPLETED'} from the request body at face value would let anyone
// grant themselves access without ever paying. This handler only uses
// the payload to learn WHICH depositId to check, then re-fetches the
// real status directly from PawaPay's own API before granting anything —
// the same verify-with-the-provider pattern the Pesapal webhook already
// uses (it calls getTransactionStatus() rather than trusting its own
// query params).
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let event: any;
  try {
    event = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const payload = Array.isArray(event) ? event[0] : event;
  const depositId: string | undefined = payload?.depositId;

  if (!depositId) {
    return NextResponse.json({ error: 'Missing depositId' }, { status: 400 });
  }

  try {
    // payload.status is deliberately ignored — verify directly with PawaPay.
    const verified = await checkDepositStatus(depositId);
    const verifiedStatus: string | undefined = Array.isArray(verified) ? verified[0]?.status : verified?.status;

    if (verifiedStatus === 'COMPLETED') {
      const supabase = getSupabaseAdmin();
      const { data: pending } = await supabase
        .from('pending_transactions')
        .select('*')
        .eq('id', depositId)
        .maybeSingle();

      if (pending && pending.status === 'pending') {
        await grantAccessForPayment({
          product: pending.product,
          userId: pending.user_id,
          planId: pending.plan,
          email: pending.email,
          ticketId: pending.ticket_id,
        });
        await supabase.from('pending_transactions').update({ status: 'completed' }).eq('id', depositId);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pawapay webhook] Failed to verify/grant access:', err);
    // Still acknowledge receipt below — the /api/checkout/status polling
    // endpoint acts as an independent safety net, so a transient failure
    // here doesn't need to trigger PawaPay's own webhook retry storm.
  }

  return NextResponse.json({ received: true });
}
