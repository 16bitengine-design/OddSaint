// ---------------------------------------------------------------------------
// Odd Saint — Brevo transactional email client (Vercel/Next.js runtime)
// Same API as scripts/lib/brevo.mjs — kept as a separate file because
// scripts/ isn't part of the Next.js build and src/ isn't part of the
// GitHub Actions job, same pattern already used for the two
// getSupabaseAdmin() implementations.
// ---------------------------------------------------------------------------

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
