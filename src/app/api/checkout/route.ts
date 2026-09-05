import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  PLANS,
  isValidPlanId,
  SAINTS_LOCK_PLANS,
  isValidSaintsLockPlanId,
  TICKET_UNLOCK_PRICE_USD,
} from '@/lib/plans';
import { isPawaPaySupportedCountry, getCorrespondentsForCountry, initiateDeposit } from '@/lib/pawapay';
import { submitOrder } from '@/lib/pesapal';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

// ---------------------------------------------------------------------------
// POST /api/checkout
// Body: {
//   product: 'subscription' | 'saints_lock' | 'ticket_unlock',
//   plan?: string,               // required for subscription/saints_lock, ignored for ticket_unlock
//   ticketId?: string,           // required for ticket_unlock — which ticket is being paid for
//   userId: string,
//   email: string,
//   countryCode: string (ISO 3166-1 alpha-2, e.g. 'KE'),
//   phoneNumber?: string,        // required only when preferMobileMoney is true
//   correspondent?: string,      // which network — required if the country has more than one PawaPay option
//   preferMobileMoney?: boolean  // explicit opt-in; defaults to false
// }
//
// PESAPAL IS THE PRIMARY/DEFAULT CHECKOUT PROVIDER (product decision —
// see CLAUDE.md). PawaPay's direct-to-phone mobile-money flow is opt-in
// ONLY: it is used solely when the client explicitly sets
// preferMobileMoney: true AND the country/network is actually supported.
// Everyone else — including anyone who doesn't opt in, and anyone whose
// country/network PawaPay doesn't cover — goes through Pesapal's hosted
// redirect page, which also handles card payments and East African
// mobile money through Pesapal's own rails.
//   - PawaPay path returns { provider: 'pawapay', depositId } — frontend
//     polls /api/checkout/status?provider=pawapay for the result.
//   - Pesapal path returns { provider: 'pesapal', url } — frontend
//     redirects the browser there.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let body: {
    product?: string;
    plan?: string;
    ticketId?: string;
    userId?: string;
    email?: string;
    countryCode?: string;
    phoneNumber?: string;
    correspondent?: string;
    preferMobileMoney?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const {
    product,
    plan,
    ticketId,
    userId,
    email,
    countryCode,
    phoneNumber,
    correspondent,
    preferMobileMoney,
  } = body;

  if (product !== 'subscription' && product !== 'saints_lock' && product !== 'ticket_unlock') {
    return NextResponse.json({ error: 'Invalid product' }, { status: 400 });
  }
  if (!userId || !email) {
    return NextResponse.json({ error: 'Must be signed in to purchase' }, { status: 401 });
  }
  if (!countryCode) {
    return NextResponse.json({ error: 'Country is required' }, { status: 400 });
  }

  const supabaseAdmin = getSupabaseAdmin();

  // -------------------------------------------------------------------
  // Resolve the amount/description/plan-label to charge — derived
  // server-side from validated config, NEVER trusted from the client.
  // -------------------------------------------------------------------
  let amountUsd: number;
  let description: string;
  let planForRecord: string;

  if (product === 'ticket_unlock') {
    if (!ticketId) {
      return NextResponse.json({ error: 'Missing ticketId' }, { status: 400 });
    }
    // Confirm the ticket actually exists before charging for it — never
    // trust a client-supplied ticket ID blindly.
    const { data: ticketRow, error: ticketLookupErr } = await supabaseAdmin
      .from('tickets')
      .select('id')
      .eq('id', ticketId)
      .maybeSingle();
    if (ticketLookupErr) {
      // eslint-disable-next-line no-console
      console.error('[checkout] Ticket lookup failed:', ticketLookupErr);
      return NextResponse.json({ error: 'Could not verify ticket. Please try again.' }, { status: 500 });
    }
    if (!ticketRow) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }
    amountUsd = TICKET_UNLOCK_PRICE_USD;
    description = 'Odd Saint — Ticket unlock';
    planForRecord = 'single';
  } else {
    if (!plan) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }
    const planConfig =
      product === 'subscription'
        ? isValidPlanId(plan)
          ? PLANS[plan]
          : null
        : isValidSaintsLockPlanId(plan)
        ? SAINTS_LOCK_PLANS[plan]
        : null;

    if (!planConfig) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }
    amountUsd = planConfig.amountUsd;
    description = `Odd Saint — ${planConfig.label} plan`;
    planForRecord = plan;
  }

  try {
    // Mobile money is opt-in only — see the file header note. Pesapal is
    // the fallback for everyone else, not the other way around.
    const wantsMobileMoney = !!preferMobileMoney && isPawaPaySupportedCountry(countryCode);

    if (wantsMobileMoney) {
      if (!phoneNumber) {
        return NextResponse.json({ error: 'Phone number is required for mobile money' }, { status: 400 });
      }

      const correspondents = getCorrespondentsForCountry(countryCode);
      const chosenCorrespondent = correspondent || correspondents[0]?.code;
      if (!chosenCorrespondent) {
        return NextResponse.json({ error: 'No mobile money network available for this country' }, { status: 400 });
      }

      const deposit = await initiateDeposit({
        amountUsd,
        correspondent: chosenCorrespondent,
        phoneNumber,
        statementDescription: 'Odd Saint',
      });

      if (deposit.status !== 'ACCEPTED') {
        return NextResponse.json(
          { error: deposit.rejectionReason || 'Payment request was not accepted' },
          { status: 400 }
        );
      }

      await recordPendingTransaction({
        id: deposit.depositId,
        provider: 'pawapay',
        userId,
        email,
        product,
        plan: planForRecord,
        ticketId: product === 'ticket_unlock' ? ticketId ?? null : null,
      });

      return NextResponse.json({ provider: 'pawapay', depositId: deposit.depositId });
    }

    // Pesapal — the primary/default path. Used whenever mobile money
    // wasn't explicitly requested, or isn't supported for this
    // country/network. Also handles card payments.
    const merchantReference = `oddsaint-${product}-${randomUUID()}`;
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://odd-saint.vercel.app';

    const order = await submitOrder({
      merchantReference,
      amountUsd,
      description,
      callbackUrl: `${siteUrl}?checkout=return`,
      email,
    });

    await recordPendingTransaction({
      id: order.orderTrackingId,
      provider: 'pesapal',
      userId,
      email,
      product,
      plan: planForRecord,
      ticketId: product === 'ticket_unlock' ? ticketId ?? null : null,
    });

    return NextResponse.json({ provider: 'pesapal', url: order.redirectUrl });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[checkout] Failed to start checkout:', err);
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 });
  }
}

async function recordPendingTransaction(params: {
  id: string;
  provider: 'pawapay' | 'pesapal';
  userId: string;
  email: string;
  product: string;
  plan: string;
  ticketId?: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('pending_transactions').insert({
    id: params.id,
    provider: params.provider,
    user_id: params.userId,
    email: params.email,
    product: params.product,
    plan: params.plan,
    ticket_id: params.ticketId ?? null,
  });
  if (error) throw error;
}
