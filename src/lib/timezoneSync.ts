import { supabase } from './supabaseClient';

// ---------------------------------------------------------------------------
// Captures the signed-in user's browser timezone (Intl, zero extra
// permissions/geo-IP needed) into user_profiles, so the lifecycle-email
// sender can schedule nudges at the RIGHT LOCAL HOUR for that specific
// person — not a single global blast time or a guess from payment
// country. Called on every sign-in (both magic-link and OAuth), so OAuth
// users are covered too, unlike the Hold-Harmless-agreement gap.
// ---------------------------------------------------------------------------
export async function syncUserTimezone(userId: string, email: string | null): Promise<void> {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    await supabase.from('user_profiles').upsert({
      user_id: userId,
      email,
      timezone,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Failed to sync user timezone:', err);
  }
}
