// ---------------------------------------------------------------------------
// Odd Saint — "ticket ready" notifications
// Called directly from generate-tickets.mjs right after a Saint's Lock or
// weekly-cadence ticket is actually written this run — event-triggered,
// not scheduled. Targets people who do NOT yet have that product, asking
// them to subscribe (per product spec) rather than notifying existing
// holders, who already have standing access.
//
// PHASE 2 NOTE: WhatsApp delivery for this same event is deliberately not
// implemented yet — it requires Meta Business verification and pre-approved
// message templates, which is an account-level process outside this
// codebase. This function is written so a WhatsApp branch can be added
// alongside the email branch later without restructuring the caller.
// ---------------------------------------------------------------------------
import { sendBrevoEmail } from './brevo.mjs';
import { tryClaimNotification, countSentToday } from './notificationLog.mjs';
import { saintsLockReadyEmail, weeklyTicketReadyEmail } from './emailTemplates.mjs';

const BREVO_DAILY_CAP = 300;
const MAX_NOTIFY_PER_EVENT = 150; // half the daily cap per single event, leaves room for the other lifecycle sends

export async function notifySaintsLockReady(supabase, ticketId) {
  const remaining = BREVO_DAILY_CAP - (await countSentToday(supabase));
  if (remaining <= 0) {
    console.log("Saint's Lock ready notification: daily Brevo budget already used — skipping.");
    return;
  }

  const { data: profiles, error } = await supabase.from('user_profiles').select('user_id, email');
  if (error) throw error;

  const { data: activeLocks } = await supabase.from('saints_lock_access').select('user_id').eq('active', true);
  const activeLockIds = new Set((activeLocks ?? []).map((r) => r.user_id));

  const targets = (profiles ?? [])
    .filter((p) => p.email && !activeLockIds.has(p.user_id))
    .slice(0, Math.min(remaining, MAX_NOTIFY_PER_EVENT));

  let sent = 0;
  for (const p of targets) {
    const claimed = await tryClaimNotification(supabase, {
      userId: p.user_id,
      email: p.email,
      eventType: 'saints_lock_ready',
      referenceId: ticketId,
    });
    if (!claimed) continue;
    try {
      const tpl = saintsLockReadyEmail();
      await sendBrevoEmail({ to: p.email, ...tpl, tags: ['saints_lock_ready'] });
      sent++;
    } catch (err) {
      console.error(`Failed to send Saint's Lock ready email to ${p.email}:`, err.message);
    }
  }
  console.log(`Saint's Lock ready notification: sent ${sent} email(s).`);
}

export async function notifyWeeklyTicketReady(supabase, ticketId, tierLabel) {
  const remaining = BREVO_DAILY_CAP - (await countSentToday(supabase));
  if (remaining <= 0) {
    console.log(`${tierLabel} ready notification: daily Brevo budget already used — skipping.`);
    return;
  }

  // Weekly Lite/Titan/Weekend are part of the standard subscription
  // (Weekly Titan is even free-forever once signed in) — notify everyone
  // with a known email, not just non-subscribers, since this is a
  // "your thing is ready" value notification rather than a subscribe-ask.
  const { data: profiles, error } = await supabase.from('user_profiles').select('user_id, email');
  if (error) throw error;

  const targets = (profiles ?? []).filter((p) => p.email).slice(0, Math.min(remaining, MAX_NOTIFY_PER_EVENT));

  let sent = 0;
  for (const p of targets) {
    const claimed = await tryClaimNotification(supabase, {
      userId: p.user_id,
      email: p.email,
      eventType: 'weekly_ticket_ready',
      referenceId: ticketId,
    });
    if (!claimed) continue;
    try {
      const tpl = weeklyTicketReadyEmail(tierLabel);
      await sendBrevoEmail({ to: p.email, ...tpl, tags: ['weekly_ticket_ready'] });
      sent++;
    } catch (err) {
      console.error(`Failed to send ${tierLabel} ready email to ${p.email}:`, err.message);
    }
  }
  console.log(`${tierLabel} ready notification: sent ${sent} email(s).`);
}
