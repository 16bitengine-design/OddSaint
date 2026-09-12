// ---------------------------------------------------------------------------
// Odd Saint — lifecycle email copy
//
// LEGAL/PRODUCT POSITIONING (see project instructions §25): every template
// here avoids "guaranteed", "risk-free", "certain outcome" language and
// keeps the AI-assisted/statistical framing intact. Do not loosen this
// wording without a deliberate product/legal review.
// ---------------------------------------------------------------------------

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://odd-saint.vercel.app';
const BRAND_GREEN = '#0b8a4f';

function wrap(bodyHtml, ctaLabel, ctaUrl) {
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
    htmlContent: wrap(
      `<h2 style="margin:0 0 10px;">Thanks for subscribing 🎉</h2>
       <p>Your subscription is active — every tier, every day, no more watching ads or paying per ticket.</p>
       <p>New batches drop twice daily. We'll keep you posted, but you can always check in anytime.</p>`,
      'View today\'s tickets',
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
    htmlContent: wrap(
      `<h2 style="margin:0 0 10px;">Your Saint's Lock pass is active 🔒</h2>
       <p>One ultra-high-confidence pick a day, now unlocked. We'll let you know the moment each day's pick is ready.</p>`,
      "See today's Saint's Lock",
      SITE_URL
    ),
    textContent:
      "Your Saint's Lock pass is active — one ultra-high-confidence pick a day, now unlocked. " +
      `${SITE_URL}`,
  };
}

export function dailySubscriptionNudgeEmail() {
  return {
    subject: 'Today\'s tickets are live',
    htmlContent: wrap(
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
    htmlContent: wrap(
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
    htmlContent: wrap(
      `<h2 style="margin:0 0 10px;">Today's pick just dropped 🔒</h2>
       <p>Our single most confident selection of the day is up now. Subscribe to reveal it before kickoff.</p>`,
      'Reveal today\'s pick',
      `${SITE_URL}?utm_source=email&utm_campaign=saints_lock_ready`
    ),
    textContent: `Today's Saint's Lock is ready. Reveal it: ${SITE_URL}`,
  };
}

export function weeklyTicketReadyEmail(tierLabel) {
  return {
    subject: `${tierLabel} is ready for this week`,
    htmlContent: wrap(
      `<h2 style="margin:0 0 10px;">${tierLabel} just dropped</h2>
       <p>This week's curated accumulator is live now and stays up all week.</p>`,
      'View it now',
      `${SITE_URL}?utm_source=email&utm_campaign=weekly_ready`
    ),
    textContent: `${tierLabel} is ready for this week. View it: ${SITE_URL}`,
  };
}
