import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

// ---------------------------------------------------------------------------
// POST /api/auth/phone-signup
// Body: { phone: string (E.164, e.g. +256700000000), password: string,
//         username: string, country: string (ISO 3166-1 alpha-2) }
//
// Creates an Odd Saint account for someone with no email, identified by a
// phone number + password. The user is created through the Supabase admin API
// with phone_confirm: true, so NO SMS is sent and no SMS provider is needed.
// The browser then signs in with supabase.auth.signInWithPassword({ phone,
// password }).
//
// KNOWN LIMITS (deliberate, chosen by the product owner):
//   - The phone number is NOT verified. Anyone can register a number they
//     don't own (and block the real owner from registering it).
//   - There is no password reset for these accounts (that would need SMS).
//   - Nothing stops scripted mass sign-ups except Supabase's own limits —
//     add a Vercel Firewall / rate-limit rule on this path if abused.
//
// Server-only: uses the service-role client. username/country reach
// user_profiles through the on_auth_user_created trigger (schema.sql).
// ---------------------------------------------------------------------------

const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const MIN_PASSWORD_LENGTH = 8;

export async function POST(req: NextRequest) {
  let body: { phone?: unknown; password?: unknown; username?: unknown; country?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';

  if (!PHONE_PATTERN.test(phone)) {
    return NextResponse.json({ error: 'Enter your phone number with country code, e.g. +256700000000.' }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }
  if (!USERNAME_PATTERN.test(username)) {
    return NextResponse.json({ error: 'Username must be 3–20 characters: letters, numbers, or underscore.' }, { status: 400 });
  }
  if (!COUNTRY_PATTERN.test(country)) {
    return NextResponse.json({ error: 'Please choose your country.' }, { status: 400 });
  }

  const supabaseAdmin = getSupabaseAdmin();

  // Case-insensitive username check. The username pattern allows '_', which
  // is a single-character wildcard in ILIKE, so escape it.
  const { data: taken, error: takenErr } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id')
    .ilike('username', username.replace(/_/g, '\\_'))
    .limit(1);
  if (takenErr) {
    // eslint-disable-next-line no-console
    console.error('[phone-signup] username check failed:', takenErr.message);
    return NextResponse.json({ error: 'Could not create the account. Please try again.' }, { status: 500 });
  }
  if (taken && taken.length > 0) {
    return NextResponse.json({ error: 'That username is taken — please choose another.' }, { status: 409 });
  }

  const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
    user_metadata: { username, country, signup_method: 'phone' },
  });

  if (createErr) {
    if (/already|registered|exists/i.test(createErr.message)) {
      return NextResponse.json({ error: 'That phone number already has an account — sign in instead.' }, { status: 409 });
    }
    // eslint-disable-next-line no-console
    console.error('[phone-signup] createUser failed:', createErr.message);
    return NextResponse.json({ error: 'Could not create the account. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
