// ---------------------------------------------------------------------------
// Odd Saint — lifecycle email module (GitHub Actions runtime)
//
// Everything the ticket-generation and hourly nudge scripts need for
// sending lifecycle emails, in one file:
//   1. sendBrevoEmail          — thin wrapper over Brevo's REST API
//   2. tryClaimNotification    — idempotent send-ledger (insert-first)
//   3. countSentToday          — Brevo free-tier daily-cap tracking
//   4. Email templates         — welcome / daily nudges / ticket-ready copy
//   5. notifySaintsLockReady / notifyWeeklyTicketReady — event-triggered
//      senders, called directly from scripts/generate-tickets.mjs
//
// Kept separate from src/lib/lifecycleEmail.ts (the Vercel/Next.js
// counterpart) because scripts/ isn't part of the Next.js build and src/
// isn't part of the GitHub Actions job — same reason
// scripts/lib/supabaseAdmin.mjs and src/lib/supabaseAdmin.ts are two
// files instead of one.
// ---------------------------------------------------------------------------

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_DAILY_CAP = 300; // Brevo free-tier limit
const MAX_NOTIFY_PER_EVENT = 150; // half the daily cap per single ticket-ready event

// ---------------------------------------------------------------------------
// 1. Brevo client
// ---------------------------------------------------------------------------
export async function sendBrevoEmail({ to, toName, subject, htmlContent, textContent, tags }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('Missing BREVO_API_KEY environment variable.');

  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Odd Saint';
  if (!senderEmail) throw new Error('Missing BREVO_SENDER_EMAIL environment variable.');

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to, name: toName || undefined }],
      subject,
      htmlContent,
      textContent,
      tags: tags ?? [],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo send failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// 2 & 3. Notification idempotency ledger
//
// tryClaimNotification INSERTS FIRST, then the caller only sends the email
// if the insert succeeded. A unique-constraint violation (Postgres error
// code 23505) means another run already claimed this exact
// user+event+reference combination — treat that as "already sent," not an
// error. Insert-then-send rather than check-then-send, which would have a
// race window if two workflow runs ever overlapped.
// ---------------------------------------------------------------------------
export async function tryClaimNotification(supabase, { userId, email, eventType, referenceId }) {
  const { error } = await supabase.from('notification_log').insert({
    user_id: userId,
    email,
    event_type: eventType,
    reference_id: referenceId,
  });

  if (error) {
    if (error.code === '23505') return false; // already sent — not an error
    throw error;
  }
  return true;
}

/** Today's UTC send count across every event type — used to respect Brevo's free-tier daily cap. */
export async function countSentToday(supabase) {
  const startOfDayUTC = new Date();
  startOfDayUTC.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('notification_log')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', startOfDayUTC.toISOString());

  if (error) throw error;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// 4. Email templates
//
// LEGAL/PRODUCT POSITIONING (project instructions §25): every template
// avoids "guaranteed", "risk-free", "certain outcome" language and keeps
// the AI-assisted/statistical framing intact. Do not loosen this wording
// without a deliberate product/legal review.
// ---------------------------------------------------------------------------
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://odd-saint.vercel.app';
const BRAND_GREEN = '#0b8a4f';

function wrapEmail(bodyHtml, ctaLabel, ctaUrl) {
  return `
  <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #12241c;">
    <div style="background:${BRAND_GREEN}; padding: 18px; text-align:center;">
      <span style="color:#fff; font-weight:800; font-size:18px;">Odd Saint</span>
    </div>
    <div style="padding: 24px 20px;">
      ${bodyHtml}
      ${
        ctaLabel && ctaUrl
          ? `<div style="text-align:center; margin: 26px 0;">
              <a href="${ctaUrl}" style="background:${BRAND_GREEN}; color:#fff; text-decoration:none; padding:12px 26px; border-radius:8px; font-weight:700; display:inline-block;">${ctaLabel}</a>
            </div>`
          : ''
      }
      <p style="font-size:11px; color:#5c6b63; line-height:1.6; margin-top: 30px; border-top:1px solid #d7dedb; padding-top: 14px;">
        Odd Saint provides AI-assisted statistical football analysis — never a guarantee of any result.
        Not a betting operator, not financial advice. Sports outcomes are volatile and unpredictable.
      </p>
    </div>
  </div>`;
}

export function welcomeSubscriptionEmail() {
  return {
    subject: "You're in — welcome to Odd Saint",
    htmlContent: wrapEmail(
      `<h2 style="margin:0 0 10px;">Thanks for subscribing 🎉</h2>
       <p>Your subscription is active — every tier, every day, no more watching ads or paying per ticket.</p>
       <p>New batches drop twice daily. We'll keep you posted, but you can always check in anytime.</p>`,
      "View today's tickets",
      SITE_URL
    ),
    textContent:
      "Thanks for subscribing to Odd Saint! Your subscription is active — every tier, every day. " +
      `View today's tickets: ${SITE_URL}`,
  };
}

export function welcomeSaintsLockEmail() {
  return {
    subject: "Saint's Lock is unlocked — welcome",
    htmlContent: wrapEmail(
      `<h2 style="margin:0 0 10px;">Your Saint's Lock pass is active 🔒</h2>
       <p>One ultra-high-confidence pick a day, now unlocked. We'll let you know the moment each day's pick is ready.</p>`,
      "See today's Saint's Lock",
      SITE_URL
    ),
    textContent: "Your Saint's Lock pass is active — one ultra-high-confidence pick a day, now unlocked. " + SITE_URL,
  };
}

export function dailySubscriptionNudgeEmail() {
  return {
    subject: "Today's tickets are live",
    htmlContent: wrapEmail(
      `<h2 style="margin:0 0 10px;">Today's slate is ready</h2>
       <p>Bronze, Silver, Gold and more — curated and graded in the open. Subscribe to unlock every tier without ads or per-ticket fees.</p>`,
      'See plans',
      `${SITE_URL}?utm_source=email&utm_campaign=daily_nudge`
    ),
    textContent: `Today's tickets are live on Odd Saint. See plans: ${SITE_URL}`,
  };
}

export function dailySaintsLockNudgeEmail() {
  return {
    subject: "Today's Saint's Lock — one pick, one shot",
    htmlContent: wrapEmail(
      `<h2 style="margin:0 0 10px;">One pick a day. Our most confident.</h2>
       <p>Saint's Lock is a single-match, ultra-high-confidence category — subscribe from $1.50/day.</p>`,
      "Get Saint's Lock",
      `${SITE_URL}?utm_source=email&utm_campaign=saints_lock_nudge`
    ),
    textContent: `Saint's Lock — one pick a day. Get it: ${SITE_URL}`,
  };
}

export function saintsLockReadyEmail() {
  return {
    subject: "Today's Saint's Lock is ready",
    htmlContent: wrapEmail(
      `<h2 style="margin:0 0 10px;">Today's pick just dropped 🔒</h2>
       <p>Our single most confident selection of the day is up now. Subscribe to reveal it before kickoff.</p>`,
      "Reveal today's pick",
      `${SITE_URL}?utm_source=email&utm_campaign=saints_lock_ready`
    ),
    textContent: `Today's Saint's Lock is ready. Reveal it: ${SITE_URL}`,
  };
}

export function weeklyTicketReadyEmail(tierLabel) {
  return {
    subject: `${tierLabel} is ready for this week`,
    htmlContent: wrapEmail(
      `<h2 style="margin:0 0 10px;">${tierLabel} just dropped</h2>
       <p>This week's curated accumulator is live now and stays up all week.</p>`,
      'View it now',
      `${SITE_URL}?utm_source=email&utm_campaign=weekly_ready`
    ),
    textContent: `${tierLabel} is ready for this week. View it: ${SITE_URL}`,
  };
}

// ---------------------------------------------------------------------------
// 5. Event-triggered "ticket ready" notifications
//
// Called directly from generate-tickets.mjs right after a Saint's Lock or
// weekly-cadence ticket is actually written this run — event-triggered,
// not scheduled. Saint's Lock targets only people who do NOT yet have that
// product (a subscribe-ask); weekly-tier tickets notify everyone with a
// known email (a value notification, since Weekly Titan is free-forever
// once signed in and Weekly Lite/weekend are subscription perks either way).
//
// PHASE 2 NOTE: WhatsApp delivery for this same event is deliberately not
// implemented yet — it requires Meta Business verification and pre-approved
// message templates, an account-level process outside this codebase. These
// functions are written so a WhatsApp branch can be added alongside the
// email branch later without restructuring the caller.
// ---------------------------------------------------------------------------
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
