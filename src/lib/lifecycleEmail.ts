import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';

// ---------------------------------------------------------------------------
// Odd Saint — lifecycle email module (Vercel/Next.js runtime)
//
// Everything src/lib/grantAccess.ts and src/app/page.tsx need for the
// browser-triggered half of the lifecycle-email system, in one file:
//   1. sendBrevoEmail       — thin wrapper over Brevo's REST API
//   2. tryClaimNotification — idempotent send-ledger (insert-first)
//   3. Welcome email templates (subscription + Saint's Lock)
//   4. syncUserTimezone     — captures the signed-in user's browser
//      timezone into user_profiles on every sign-in
//
// The daily-nudge and ticket-ready templates, plus the hourly sender
// script, live in scripts/lib/lifecycleEmail.mjs instead — this file only
// covers what fires from the Vercel/Next.js side. Kept as a separate file
// from that one because scripts/ isn't part of the Next.js build and src/
// isn't part of the GitHub Actions job — same reason
// scripts/lib/supabaseAdmin.mjs and src/lib/supabaseAdmin.ts are two files
// instead of one.
// ---------------------------------------------------------------------------

// --- 1. Brevo client ---------------------------------------------------------

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

export interface SendBrevoEmailParams {
  to: string;
  toName?: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  tags?: string[];
}

export async function sendBrevoEmail(params: SendBrevoEmailParams): Promise<void> {
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
      to: [{ email: params.to, name: params.toName || undefined }],
      subject: params.subject,
      htmlContent: params.htmlContent,
      textContent: params.textContent,
      tags: params.tags ?? [],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo send failed (${res.status}): ${body}`);
  }
}

// --- 2. Notification idempotency ledger -------------------------------------
// See scripts/lib/lifecycleEmail.mjs for the full insert-first rationale —
// same pattern, TS/Vercel side.

export async function tryClaimNotification(
  supabaseAdmin: SupabaseClient,
  params: { userId: string; email: string | null | undefined; eventType: string; referenceId: string }
): Promise<boolean> {
  const { error } = await supabaseAdmin.from('notification_log').insert({
    user_id: params.userId,
    email: params.email,
    event_type: params.eventType,
    reference_id: params.referenceId,
  });

  if (error) {
    if ((error as { code?: string }).code === '23505') return false; // already sent
    throw error;
  }
  return true;
}

// --- 3. Welcome email templates ---------------------------------------------
// LEGAL/PRODUCT POSITIONING (project instructions §25): avoid "guaranteed",
// "risk-free", "certain outcome" language and keep the AI-assisted/
// statistical framing intact. Do not loosen this wording without a
// deliberate product/legal review.

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://odd-saint.vercel.app';
const BRAND_GREEN = '#0b8a4f';

function wrapEmail(bodyHtml: string, ctaLabel: string, ctaUrl: string): string {
  return `
  <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #12241c;">
    <div style="background:${BRAND_GREEN}; padding: 18px; text-align:center;">
      <span style="color:#fff; font-weight:800; font-size:18px;">Odd Saint</span>
    </div>
    <div style="padding: 24px 20px;">
      ${bodyHtml}
      <div style="text-align:center; margin: 26px 0;">
        <a href="${ctaUrl}" style="background:${BRAND_GREEN}; color:#fff; text-decoration:none; padding:12px 26px; border-radius:8px; font-weight:700; display:inline-block;">${ctaLabel}</a>
      </div>
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
       <p>Your subscription is active — every tier, every day, no more watching ads or paying per ticket.</p>`,
      "View today's tickets",
      SITE_URL
    ),
    textContent: `Thanks for subscribing to Odd Saint! Your subscription is active. ${SITE_URL}`,
  };
}

export function welcomeSaintsLockEmail() {
  return {
    subject: "Saint's Lock is unlocked — welcome",
    htmlContent: wrapEmail(
      `<h2 style="margin:0 0 10px;">Your Saint's Lock pass is active 🔒</h2>
       <p>One ultra-high-confidence pick a day, now unlocked.</p>`,
      "See today's Saint's Lock",
      SITE_URL
    ),
    textContent: `Your Saint's Lock pass is active. ${SITE_URL}`,
  };
}

// --- 4. Timezone capture ------------------------------------------------------
// Captures the signed-in user's browser timezone (Intl, zero extra
// permissions/geo-IP needed) into user_profiles, so the hourly nudge
// sender (scripts/send-lifecycle-emails.mjs) can schedule at the RIGHT
// LOCAL HOUR for that specific person — not a single global blast time or
// a guess from payment country. Called on every sign-in (both magic-link
// and OAuth) from src/app/page.tsx's auth effect.

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
