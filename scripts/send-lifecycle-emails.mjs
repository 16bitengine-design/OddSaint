// ---------------------------------------------------------------------------
// Odd Saint — hourly lifecycle email sender
//
// Runs every hour via .github/workflows/send-lifecycle-emails.yml. Each
// user_profiles row carries the person's own IANA timezone (captured
// client-side — see src/lib/timezoneSync.ts). This script computes each
// user's CURRENT LOCAL HOUR and only sends when it matches their assigned
// nudge hour — true per-user timezone scheduling, not a single global
// blast time.
//
// Two independent daily nudges, deliberately spaced apart so nobody gets
// two Odd Saint emails back-to-back:
//   - Subscription nudge  -> local 09:00 (people check phones in the morning)
//   - Saint's Lock nudge  -> local 18:30 (early evening, ahead of that
//     day's kickoffs and the classic "after work" phone-checking window)
// Each only targets people who DON'T already have that product — an active
// subscriber never gets the subscription nudge, an active Saint's Lock
// holder never gets the Saint's Lock nudge.
//
// BREVO FREE-TIER CAP: 300 emails/day. This script stops sending once the
// day's total (across ALL notification types, via notification_log) comes
// within DAILY_EMAIL_RESERVE of that cap, leaving headroom for
// transactional sends (welcome emails, ticket-ready emails) that matter
// more than a scheduled nudge.
// ---------------------------------------------------------------------------
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { sendBrevoEmail } from './lib/brevo.mjs';
import { tryClaimNotification, countSentToday } from './lib/notificationLog.mjs';
import { dailySubscriptionNudgeEmail, dailySaintsLockNudgeEmail } from './lib/emailTemplates.mjs';

const SUBSCRIPTION_NUDGE_LOCAL_HOUR = 9;
const SAINTS_LOCK_NUDGE_LOCAL_HOUR = 18;

const BREVO_DAILY_CAP = 300;
const DAILY_EMAIL_RESERVE = 20; // leave headroom for welcome/ticket-ready sends
const MAX_SENDS_THIS_RUN = 100; // avoid one run trying to blast hundreds at once

function localHourAndDate(timezone) {
  try {
    const now = new Date();
    const hourStr = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, hour: 'numeric' }).format(now);
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now); // en-CA gives YYYY-MM-DD
    return { hour: parseInt(hourStr, 10) % 24, dateStr };
  } catch {
    // Invalid/unknown timezone string — fall back to UTC rather than crashing this user's row.
    const now = new Date();
    return { hour: now.getUTCHours(), dateStr: now.toISOString().slice(0, 10) };
  }
}

async function main() {
  const supabase = getSupabaseAdmin();

  const alreadySentToday = await countSentToday(supabase);
  let budgetRemaining = BREVO_DAILY_CAP - DAILY_EMAIL_RESERVE - alreadySentToday;
  if (budgetRemaining <= 0) {
    console.log(`Daily Brevo budget already used (${alreadySentToday} sent today) — skipping this run.`);
    return;
  }

  const { data: profiles, error: profilesErr } = await supabase
    .from('user_profiles')
    .select('user_id, email, timezone');
  if (profilesErr) throw profilesErr;
  if (!profiles || profiles.length === 0) {
    console.log('No user_profiles rows yet — nothing to do.');
    return;
  }

  const { data: activeSubs } = await supabase
    .from('subscribers')
    .select('user_id')
    .eq('active', true);
  const activeSubIds = new Set((activeSubs ?? []).map((r) => r.user_id));

  const { data: activeLocks } = await supabase
    .from('saints_lock_access')
    .select('user_id')
    .eq('active', true);
  const activeLockIds = new Set((activeLocks ?? []).map((r) => r.user_id));

  let sentThisRun = 0;

  for (const profile of profiles) {
    if (sentThisRun >= MAX_SENDS_THIS_RUN || budgetRemaining <= 0) break;
    if (!profile.email) continue;

    const { hour, dateStr } = localHourAndDate(profile.timezone || 'UTC');

    // --- Subscription nudge ---
    if (hour === SUBSCRIPTION_NUDGE_LOCAL_HOUR && !activeSubIds.has(profile.user_id)) {
      const claimed = await tryClaimNotification(supabase, {
        userId: profile.user_id,
        email: profile.email,
        eventType: 'daily_subscription_nudge',
        referenceId: dateStr,
      });
      if (claimed) {
        try {
          const tpl = dailySubscriptionNudgeEmail();
          await sendBrevoEmail({ to: profile.email, ...tpl, tags: ['daily_subscription_nudge'] });
          sentThisRun++;
          budgetRemaining--;
        } catch (err) {
          console.error(`Failed to send subscription nudge to ${profile.email}:`, err.message);
        }
      }
    }

    if (sentThisRun >= MAX_SENDS_THIS_RUN || budgetRemaining <= 0) break;

    // --- Saint's Lock nudge ---
    if (hour === SAINTS_LOCK_NUDGE_LOCAL_HOUR && !activeLockIds.has(profile.user_id)) {
      const claimed = await tryClaimNotification(supabase, {
        userId: profile.user_id,
        email: profile.email,
        eventType: 'daily_saints_lock_nudge',
        referenceId: dateStr,
      });
      if (claimed) {
        try {
          const tpl = dailySaintsLockNudgeEmail();
          await sendBrevoEmail({ to: profile.email, ...tpl, tags: ['daily_saints_lock_nudge'] });
          sentThisRun++;
          budgetRemaining--;
        } catch (err) {
          console.error(`Failed to send Saint's Lock nudge to ${profile.email}:`, err.message);
        }
      }
    }
  }

  console.log(`Lifecycle email run complete — sent ${sentThisRun} email(s) this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
