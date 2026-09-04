import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { grantAccessForPayment } from '@/lib/grantAccess';
import { isValidPlanId, isValidSaintsLockPlanId } from '@/lib/plans';

// ---------------------------------------------------------------------------
// POST /api/admin/grant-access
// Body:   { targetEmail: string, product: 'subscription' | 'saints_lock', plan: string }
// Header: Authorization: Bearer <the calling admin's own Supabase access token>
//
// Lets an admin comp subscription or Saint's Lock access for another user —
// "help someone subscribe through my admin account" — with no real payment
// involved. This is the ONLY place that's allowed to happen: the actual
// grant still runs through grantAccessForPayment() (src/lib/grantAccess.ts),
// the exact same function real PawaPay/Pesapal payments call — so there is
// one single code path for "what happens when access is granted," whether
// triggered by a payment webhook or an admin. This route's entire job is
// verifying the CALLER is genuinely an admin before reaching that shared
// function, resolving the target user, and logging the grant for
// accountability (see admin_grants in supabase/migrations/003_admin_grants.sql).
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
  }

  let body: { targetEmail?: string; product?: string; plan?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { targetEmail, product, plan } = body;
  if (!targetEmail || !product || !plan) {
    return NextResponse.json({ error: 'targetEmail, product, and plan are required' }, { status: 400 });
  }
  if (product !== 'subscription' && product !== 'saints_lock') {
    return NextResponse.json({ error: 'Invalid product' }, { status: 400 });
  }
  const validPlan = product === 'subscription' ? isValidPlanId(plan) : isValidSaintsLockPlanId(plan);
  if (!validPlan) {
    return NextResponse.json({ error: 'Invalid plan for that product' }, { status: 400 });
  }

  // Verify the token belongs to a real, currently-valid session. Using the
  // public anon client (NOT the service role) to validate a user's own
  // access token is the standard, correct pattern — it confirms identity
  // without granting any elevated access on its own.
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonUrl || !anonKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const anonClient = createClient(anonUrl, anonKey);
  const { data: callerData, error: callerErr } = await anonClient.auth.getUser(token);
  if (callerErr || !callerData?.user) {
    return NextResponse.json({ error: 'Invalid or expired session — please sign in again.' }, { status: 401 });
  }
  const callerId = callerData.user.id;

  const supabaseAdmin = getSupabaseAdmin();

  // The REAL security boundary: confirm the caller is listed in `admins`,
  // checked here with the service-role client (bypasses RLS) so it can't
  // be spoofed by anything client-side. Nothing before this point trusts
  // the caller's own claim of being an admin.
  const { data: adminRow, error: adminErr } = await supabaseAdmin
    .from('admins')
    .select('user_id')
    .eq('user_id', callerId)
    .maybeSingle();
  if (adminErr) {
    return NextResponse.json({ error: 'Could not verify admin status' }, { status: 500 });
  }
  if (!adminRow) {
    return NextResponse.json({ error: 'Not authorized — admin access required.' }, { status: 403 });
  }

  const normalizedEmail = targetEmail.trim().toLowerCase();

  // Resolve the target user's id from their email — see
  // lookup_user_id_by_email() in supabase/migrations/003_admin_grants.sql.
  // This RPC is only callable with the service-role key, never from a
  // client-side session, even an admin's own.
  const { data: targetUserId, error: lookupErr } = await supabaseAdmin.rpc('lookup_user_id_by_email', {
    p_email: normalizedEmail,
  });
  if (lookupErr) {
    // eslint-disable-next-line no-console
    console.error('[admin grant-access] Email lookup failed:', lookupErr);
    return NextResponse.json({ error: 'Could not look up that email.' }, { status: 500 });
  }
  if (!targetUserId) {
    return NextResponse.json(
      {
        error:
          'No account found for that email — they need to sign in with the magic link once first, then you can grant access.',
      },
      { status: 404 }
    );
  }

  try {
    await grantAccessForPayment({
      product,
      userId: targetUserId as string,
      planId: plan,
      email: normalizedEmail,
    });

    const { error: auditErr } = await supabaseAdmin.from('admin_grants').insert({
      admin_user_id: callerId,
      admin_email: callerData.user.email,
      target_user_id: targetUserId,
      target_email: normalizedEmail,
      product,
      plan,
    });
    if (auditErr) {
      // Don't fail the whole request over the audit log — the actual grant
      // already succeeded and the user already has access. Just make sure
      // it's visible in the server logs that the audit row didn't write.
      // eslint-disable-next-line no-console
      console.error('[admin grant-access] Grant succeeded but audit log insert failed:', auditErr);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin grant-access] Failed to grant access:', err);
    return NextResponse.json({ error: 'Could not grant access. Please try again.' }, { status: 500 });
  }
}
