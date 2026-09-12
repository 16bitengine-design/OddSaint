// ---------------------------------------------------------------------------
// Odd Saint — TS port of scripts/lib/emailTemplates.mjs's welcome templates
// only (the daily-nudge and ticket-ready templates stay GitHub-Actions-only,
// since only welcome emails fire from Vercel — see src/lib/grantAccess.ts).
// ---------------------------------------------------------------------------
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://odd-saint.vercel.app';
const BRAND_GREEN = '#0b8a4f';

function wrap(bodyHtml: string, ctaLabel: string, ctaUrl: string): string {
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
    htmlContent: wrap(
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
    htmlContent: wrap(
      `<h2 style="margin:0 0 10px;">Your Saint's Lock pass is active 🔒</h2>
       <p>One ultra-high-confidence pick a day, now unlocked.</p>`,
      "See today's Saint's Lock",
      SITE_URL
    ),
    textContent: `Your Saint's Lock pass is active. ${SITE_URL}`,
  };
}
