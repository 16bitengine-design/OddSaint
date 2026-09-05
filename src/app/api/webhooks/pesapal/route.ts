
import { NextRequest, NextResponse } from 'next/server';
import { getTransactionStatus } from '@/lib/pesapal';
import { grantAccessForPayment } from '@/lib/grantAccess';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

// ---------------------------------------------------------------------------
// GET /api/webhooks/pesapal
// Register this URL once via registerIpnUrl() (see src/lib/pesapal.ts) and
// store the resulting ID as PESAPAL_IPN_ID.
//
// Unlike the other webhook, Pesapal delivers this as a GET request with
// query parameters (OrderTrackingId, OrderMerchantReference,
// OrderNotificationType) rather than a POST body — and expects a specific
// JSON shape back to acknowledge receipt, not just any 200 response.
//
// This already verifies with Pesapal's own getTransactionStatus() rather
// than trusting the query params directly — the correct pattern the
// PawaPay webhook has now been updated to match as well.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const orderTrackingId = req.nextUrl.searchParams.get('OrderTrackingId');
  const orderMerchantReference = req.nextUrl.searchParams.get('OrderMerchantReference');
  const orderNotificationType = req.nextUrl.searchParams.get('OrderNotificationType') || 'IPNCHANGE';

  if (!orderTrackingId) {
    return NextResponse.json({ error: 'Missing OrderTrackingId' }, { status: 400 });
  }

  try {
    const status = await getTransactionStatus(orderTrackingId);
    // Pesapal's status_code: 1 = COMPLETED, 0 = INVALID, 2 = FAILED, 3 = REVERSED
    if (status?.status_code === 1) {
      const supabase = getSupabaseAdmin();
      const { data: pending } = await supabase
        .from('pending_transactions')
        .select('*')
        .eq('id', orderTrackingId)
        .maybeSingle();

      if (pending && pending.status === 'pending') {
        await grantAccessForPayment({
          product: pending.product,
          userId: pending.user_id,
          planId: pending.plan,
          email: pending.email,
          ticketId: pending.ticket_id,
        });
        await supabase.from('pending_transactions').update({ status: 'completed' }).eq('id', orderTrackingId);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pesapal webhook] Failed to process IPN:', err);
    // Still respond in the expected shape below — Pesapal retries on
    // malformed/missing responses, and we don't want it hammering an
    // endpoint that's going to fail the same way repeatedly. The
    // /api/checkout/status?provider=pesapal polling endpoint is now an
    // independent safety net for this case too — see that file.
  }

  // Pesapal requires this exact response shape to consider the IPN handled.
  return NextResponse.json({
    orderNotificationType,
    orderTrackingId,
    orderMerchantReference,
    status: 200,
  });
}
