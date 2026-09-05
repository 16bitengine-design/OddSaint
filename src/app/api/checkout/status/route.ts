import { NextRequest, NextResponse } from 'next/server';
import { checkDepositStatus } from '@/lib/pawapay';
import { getTransactionStatus } from '@/lib/pesapal';
import { grantAccessForPayment } from '@/lib/grantAccess';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

// ---------------------------------------------------------------------------
// GET /api/checkout/status?provider=pawapay&depositId=...
// GET /api/checkout/status?provider=pesapal&orderTrackingId=...
//
// Client-side polling safety net for BOTH providers.
//
// PawaPay has no redirect to bounce back to — approval happens via a PIN
// prompt on the customer's own phone, entirely out of band — so polling
// was always required there.
//
// Pesapal normally confirms via its IPN webhook, but that's a single
// point of failure (a misregistered PESAPAL_IPN_ID, a dropped callback,
// etc.). Since Pesapal is the PRIMARY checkout provider, it now gets the
// same polling safety net PawaPay already had, rather than relying on the
// webhook alone.
//
// `provider` defaults to 'pawapay' for backward compatibility with
// existing callers that only ever passed `depositId`.
//
// Either branch grants access directly if the payment is confirmed
// complete, alongside whichever webhook may also fire independently —
// grantAccessForPayment's upsert makes doing it twice harmless.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get('provider') || 'pawapay';
  const depositId = req.nextUrl.searchParams.get('depositId');
  const orderTrackingId = req.nextUrl.searchParams.get('orderTrackingId');

  const transactionId = provider === 'pesapal' ? orderTrackingId : depositId;
  if (!transactionId) {
    return NextResponse.json(
      { error: provider === 'pesapal' ? 'Missing orderTrackingId' : 'Missing depositId' },
      { status: 400 }
    );
  }

  try {
    let normalizedStatus: string | undefined;

    if (provider === 'pesapal') {
      const result = await getTransactionStatus(transactionId);
      // Pesapal's status_code: 1 = COMPLETED, 0 = INVALID, 2 = FAILED, 3 = REVERSED
      normalizedStatus =
        result?.status_code === 1
          ? 'COMPLETED'
          : result?.status_code === 2
          ? 'FAILED'
          : result?.status_code === 3
          ? 'REVERSED'
          : result?.status_code === 0
          ? 'INVALID'
          : 'UNKNOWN';
    } else {
      const result = await checkDepositStatus(transactionId);
      normalizedStatus = Array.isArray(result) ? result[0]?.status : result?.status;
    }

    if (normalizedStatus === 'COMPLETED') {
      const pending = await getPendingTransaction(transactionId);
      if (pending && pending.status === 'pending') {
        await grantAccessForPayment({
          product: pending.product,
          userId: pending.user_id,
          planId: pending.plan,
          email: pending.email,
          ticketId: pending.ticket_id,
        });
        await markTransactionComplete(transactionId);
      }
    }

    return NextResponse.json({ status: normalizedStatus ?? 'UNKNOWN' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[checkout status] Failed to check ${provider} status:`, err);
    return NextResponse.json({ error: 'Could not check payment status' }, { status: 500 });
  }
}

async function getPendingTransaction(id: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from('pending_transactions').select('*').eq('id', id).maybeSingle();
  return data;
}

async function markTransactionComplete(id: string) {
  const supabase = getSupabaseAdmin();
  await supabase.from('pending_transactions').update({ status: 'completed' }).eq('id', id);
}
