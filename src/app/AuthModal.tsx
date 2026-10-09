'use client';

// ---------------------------------------------------------------------------
// Odd Saint — account modal (email + password)
// Replaces LoginModal in src/app/page.tsx. Google/Facebook sign-in and the
// magic-link flow are intentionally gone for now — every user creates an
// Odd Saint account with: email, username, country, password.
//
// Username + country travel as Supabase signup metadata and are copied into
// user_profiles by the on_auth_user_created trigger (see
// the user_profiles section of supabase/schema.sql). If "Confirm email" is on in
// Supabase (Authentication -> Providers -> Email), the user is signed in only
// after clicking the confirmation link, and this modal says so.
// ---------------------------------------------------------------------------
import { useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';

const COLORS = {
  surface: '#ffffff',
  surfaceAlt: '#eef1ef',
  border: '#d7dedb',
  hairline: '#c3ccc7',
  emerald: '#0b8a4f',
  red: '#d3321f',
  textPrimary: '#12241c',
  textMuted: '#5c6b63',
};
const FONT = 'var(--font-body), system-ui, -apple-system, sans-serif';

const COUNTRIES: Array<[string, string]> = [
  ['DZ', 'Algeria'], ['AO', 'Angola'], ['BJ', 'Benin'], ['BW', 'Botswana'], ['BF', 'Burkina Faso'],
  ['BI', 'Burundi'], ['CM', 'Cameroon'], ['CV', 'Cape Verde'], ['CF', 'Central African Republic'],
  ['TD', 'Chad'], ['KM', 'Comoros'], ['CG', 'Congo'], ['CD', 'DR Congo'], ['CI', "Côte d'Ivoire"],
  ['DJ', 'Djibouti'], ['EG', 'Egypt'], ['GQ', 'Equatorial Guinea'], ['ER', 'Eritrea'], ['SZ', 'Eswatini'],
  ['ET', 'Ethiopia'], ['GA', 'Gabon'], ['GM', 'Gambia'], ['GH', 'Ghana'], ['GN', 'Guinea'],
  ['GW', 'Guinea-Bissau'], ['KE', 'Kenya'], ['LS', 'Lesotho'], ['LR', 'Liberia'], ['LY', 'Libya'],
  ['MG', 'Madagascar'], ['MW', 'Malawi'], ['ML', 'Mali'], ['MR', 'Mauritania'], ['MU', 'Mauritius'],
  ['MA', 'Morocco'], ['MZ', 'Mozambique'], ['NA', 'Namibia'], ['NE', 'Niger'], ['NG', 'Nigeria'],
  ['RW', 'Rwanda'], ['ST', 'São Tomé and Príncipe'], ['SN', 'Senegal'], ['SC', 'Seychelles'],
  ['SL', 'Sierra Leone'], ['SO', 'Somalia'], ['ZA', 'South Africa'], ['SS', 'South Sudan'],
  ['SD', 'Sudan'], ['TZ', 'Tanzania'], ['TG', 'Togo'], ['TN', 'Tunisia'], ['UG', 'Uganda'],
  ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'],
  ['AR', 'Argentina'], ['AU', 'Australia'], ['AT', 'Austria'], ['BE', 'Belgium'], ['BR', 'Brazil'],
  ['CA', 'Canada'], ['CL', 'Chile'], ['CN', 'China'], ['CO', 'Colombia'], ['DK', 'Denmark'],
  ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['GR', 'Greece'], ['IN', 'India'],
  ['IE', 'Ireland'], ['IT', 'Italy'], ['JP', 'Japan'], ['MX', 'Mexico'], ['NL', 'Netherlands'],
  ['NO', 'Norway'], ['PL', 'Poland'], ['PT', 'Portugal'], ['SA', 'Saudi Arabia'], ['ES', 'Spain'],
  ['SE', 'Sweden'], ['CH', 'Switzerland'], ['TR', 'Turkey'], ['AE', 'United Arab Emirates'],
  ['GB', 'United Kingdom'], ['US', 'United States'], ['XX', 'Other'],
];

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
// Phone accounts: international format, e.g. +256700000000. Spaces, dashes and
// brackets are stripped; a leading 00 is read as +.
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  return cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;
}

// Supabase's message for a banned account (see the suspension job in
// scripts/suspend-unverified-phone-accounts.mjs).
const SUSPENDED_MESSAGE =
  'This account has been suspended because it was not verified with an email. Please contact support.';

const MIN_PASSWORD_LENGTH = 8;

const inputStyle = {
  width: '100%',
  padding: '11px 12px',
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: COLORS.surfaceAlt,
  color: COLORS.textPrimary,
  fontFamily: FONT,
  fontSize: 13,
  marginBottom: 12,
  boxSizing: 'border-box' as const,
};

export function AuthModal({
  onClose,
  initialMode = 'signup',
}: {
  onClose: () => void;
  initialMode?: 'signup' | 'signin';
}) {
  const [mode, setMode] = useState<'signup' | 'signin'>(initialMode);
  const [method, setMethod] = useState<'email' | 'phone'>('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [country, setCountry] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  const isSignup = mode === 'signup';
  const isPhone = method === 'phone';
  const hasIdentifier = isPhone ? !!phone.trim() : !!email;
  const canSubmit = isSignup
    ? hasIdentifier && !!username && !!country && !!password && agreed && !busy
    : hasIdentifier && !!password && !busy;

  function switchMode(next: 'signup' | 'signin') {
    setMode(next);
    setError(null);
  }

  async function handleSignUp() {
    const cleanUsername = username.trim();
    if (!USERNAME_PATTERN.test(cleanUsername)) {
      setError('Username must be 3–20 characters: letters, numbers, or underscore.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (isPhone) {
      await handlePhoneSignUp(cleanUsername);
      return;
    }

    const { data: available, error: availErr } = await supabase.rpc('username_available', {
      p_username: cleanUsername,
    });
    if (availErr) {
      setError('Could not check that username. Please try again.');
      return;
    }
    if (available === false) {
      setError('That username is taken — please choose another.');
      return;
    }

    const { data, error: signUpErr } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { username: cleanUsername, country, marketing_opt_in: marketingOptIn },
      },
    });
    if (signUpErr) {
      setError(signUpErr.message);
      return;
    }

    // With email confirmation on, Supabase returns a user with no identities
    // (and no error) when the email is already registered.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      setError('That email already has an account — sign in instead.');
      return;
    }

    if (data.session) {
      onClose(); // confirmation off: already signed in; page.tsx's auth listener picks it up
    } else {
      setConfirmSent(true);
    }
  }

  // Phone accounts are created server-side (/api/auth/phone-signup) so the
  // number is stored as a confirmed phone identity without sending an SMS.
  // The number is NOT verified — see the route's header comment.
  async function handlePhoneSignUp(cleanUsername: string) {
    const cleanPhone = normalizePhone(phone);
    if (!PHONE_PATTERN.test(cleanPhone)) {
      setError('Enter your phone number with country code, e.g. +256700000000.');
      return;
    }
    const res = await fetch('/api/auth/phone-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: cleanPhone, password, username: cleanUsername, country }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(body.error ?? 'Could not create the account. Please try again.');
      return;
    }
    const { error: signInErr } = await supabase.auth.signInWithPassword({ phone: cleanPhone, password });
    if (signInErr) {
      setError('Account created, but automatic sign-in failed. Please sign in.');
      switchMode('signin');
      return;
    }
    onClose();
  }

  async function handleSignIn() {
    if (isPhone) {
      const cleanPhone = normalizePhone(phone);
      if (!PHONE_PATTERN.test(cleanPhone)) {
        setError('Enter your phone number with country code, e.g. +256700000000.');
        return;
      }
      const { error: phoneErr } = await supabase.auth.signInWithPassword({ phone: cleanPhone, password });
      if (phoneErr) {
        setError(
          phoneErr.message === 'Invalid login credentials'
            ? 'Wrong phone number or password.'
            : /banned/i.test(phoneErr.message)
            ? SUSPENDED_MESSAGE
            : phoneErr.message
        );
        return;
      }
      onClose();
      return;
    }
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (signInErr) {
      setError(
        signInErr.message === 'Invalid login credentials'
          ? 'Wrong email or password.'
          : signInErr.message
      );
      return;
    }
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      if (isSignup) await handleSignUp();
      else await handleSignIn();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 40,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        overflowY: 'auto',
      }}
    >
      <div style={{ width: '100%', maxWidth: 380, margin: 'auto 0' }}>
        <form
          onSubmit={handleSubmit}
          style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: 14,
            padding: 22,
            position: 'relative',
            boxShadow: '0 20px 60px -20px rgba(0,0,0,0.6)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              background: 'none',
              border: 'none',
              color: COLORS.textMuted,
              fontSize: 16,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>

          <h2 style={{ fontFamily: FONT, fontSize: 18, fontWeight: 800, color: COLORS.textPrimary, margin: '0 0 4px' }}>
            {isSignup ? 'Create your account' : 'Welcome back'}
          </h2>
          <p style={{ fontFamily: FONT, fontSize: 12, color: COLORS.textMuted, margin: '0 0 16px', lineHeight: 1.5 }}>
            {isSignup
              ? 'A free Odd Saint account keeps your access after the 7-day trial.'
              : isPhone
              ? 'Sign in with your phone number and password.'
              : 'Sign in with your email and password.'}
          </p>

          {confirmSent ? (
            <div style={{ fontFamily: FONT, fontSize: 13, color: COLORS.emerald, lineHeight: 1.6 }}>
              Account created. Check <strong>{email.trim()}</strong> for a confirmation link, then come back and sign in.
              <button
                type="button"
                onClick={() => {
                  setConfirmSent(false);
                  switchMode('signin');
                }}
                style={{
                  display: 'block',
                  marginTop: 14,
                  width: '100%',
                  padding: '11px 0',
                  borderRadius: 9,
                  border: 'none',
                  background: COLORS.emerald,
                  color: '#ffffff',
                  fontFamily: FONT,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Go to sign in
              </button>
            </div>
          ) : (
            <>
              {isPhone ? (
                <input
                  type="tel"
                  required
                  autoComplete="tel"
                  placeholder="Phone number, e.g. +256700000000"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 6 }}
                />
              ) : (
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 6 }}
                />
              )}
              <button
                type="button"
                onClick={() => {
                  setMethod(isPhone ? 'email' : 'phone');
                  setError(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  marginBottom: 12,
                  color: COLORS.emerald,
                  fontFamily: FONT,
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                {isPhone ? 'Use email instead' : 'No email? Use a phone number'}
              </button>

              {isSignup && (
                <>
                  <input
                    type="text"
                    required
                    autoComplete="username"
                    placeholder="Username (3–20 letters, numbers, _)"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    maxLength={20}
                    style={inputStyle}
                  />
                  <select
                    required
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    style={{ ...inputStyle, color: country ? COLORS.textPrimary : COLORS.textMuted }}
                  >
                    <option value="">Country</option>
                    {COUNTRIES.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <input
                type="password"
                required
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                placeholder={isSignup ? `Password (min ${MIN_PASSWORD_LENGTH} characters)` : 'Password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />

              {isSignup && (
                <>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      fontFamily: FONT,
                      fontSize: 11.5,
                      color: COLORS.textMuted,
                      marginBottom: 10,
                      cursor: 'pointer',
                      lineHeight: 1.45,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      I am 18 or older, and I accept the{' '}
                      <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: COLORS.emerald }}>
                        Terms
                      </a>
                      ,{' '}
                      <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: COLORS.emerald }}>
                        Privacy Policy
                      </a>{' '}
                      and the Hold-Harmless Indemnification Agreement: Odd Saint offers AI-assisted statistical
                      opinions, never a guarantee of any result, and I am responsible for my own decisions.
                    </span>
                  </label>
                  {!isPhone && (
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        fontFamily: FONT,
                        fontSize: 11.5,
                        color: COLORS.textMuted,
                        marginBottom: 14,
                        cursor: 'pointer',
                        lineHeight: 1.45,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={marketingOptIn}
                        onChange={(e) => setMarketingOptIn(e.target.checked)}
                        style={{ marginTop: 2 }}
                      />
                      Send me occasional emails about new ticket drops and offers (optional).
                    </label>
                  )}
                </>
              )}

              {error && (
                <div style={{ fontFamily: FONT, fontSize: 12, color: COLORS.red, marginBottom: 10 }}>{error}</div>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                style={{
                  width: '100%',
                  padding: '11px 0',
                  borderRadius: 9,
                  border: 'none',
                  fontFamily: FONT,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                  background: canSubmit ? COLORS.emerald : COLORS.border,
                  color: canSubmit ? '#ffffff' : COLORS.textMuted,
                }}
              >
                {busy ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
              </button>

              <div style={{ fontFamily: FONT, fontSize: 12, color: COLORS.textMuted, textAlign: 'center', marginTop: 14 }}>
                {isSignup ? 'Already have an account?' : 'New to Odd Saint?'}{' '}
                <button
                  type="button"
                  onClick={() => switchMode(isSignup ? 'signin' : 'signup')}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: COLORS.emerald,
                    fontFamily: FONT,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  {isSignup ? 'Sign in' : 'Create an account'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
