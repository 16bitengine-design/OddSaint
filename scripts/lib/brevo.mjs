// ---------------------------------------------------------------------------
// Odd Saint — Brevo transactional email client (GitHub Actions runtime)
// Thin wrapper over Brevo's REST API (https://api.brevo.com/v3/smtp/email).
// Node's built-in fetch, no SDK dependency needed.
//
// Free-tier note: Brevo's free plan caps at 300 emails/day. This client
// does not enforce that cap itself — callers (send-lifecycle-emails.mjs,
// notifyTicketReady.mjs) are responsible for checking remaining budget via
// notification_log before calling sendBrevoEmail. See DAILY_EMAIL_CAP in
// send-lifecycle-emails.mjs.
// ---------------------------------------------------------------------------

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

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
