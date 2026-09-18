
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — Odd Saint',
  description: 'How Odd Saint collects, uses, and protects your personal information.',
};

const COLORS = {
  bg: '#f4f6f5',
  textPrimary: '#12241c',
  textMuted: '#5c6b63',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 17, fontWeight: 800, color: COLORS.textPrimary, marginBottom: 8 }}>{title}</h2>
      <div style={{ fontSize: 13.5, lineHeight: 1.7, color: COLORS.textMuted }}>{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.textPrimary }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 20px 80px' }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Privacy Policy</h1>
        <p style={{ fontSize: 12.5, color: COLORS.textMuted, marginBottom: 30 }}>
          Effective date: September 10, 2026 · Last updated: September 10, 2026
        </p>

        <Section title="1. Overview">
          <p>
            This Privacy Policy explains what personal information Odd Saint ("we", "us") collects, why we
            collect it, and how it's handled. Odd Saint is operated by an individual trading as 16bitengine,
            based in Uganda, pending formal business registration under that name.
          </p>
        </Section>

        <Section title="2. Information we collect">
          <p><strong>Account information:</strong> email address; if you sign in with Google or Facebook, your
            name, email, and profile identifier from that provider.</p>
          <p><strong>Payment-related information:</strong> your mobile money phone number (only if you choose
            mobile money checkout), and transaction status/reference IDs from our payment providers (Pesapal,
            PawaPay). We do not receive or store your full card number, mobile money PIN, or bank credentials —
            those are handled directly by the payment provider.</p>
          <p><strong>Usage data:</strong> pages viewed, ticket interactions, general device/browser information,
            and approximate location, collected via Google Analytics 4.</p>
          <p><strong>Feedback/support messages:</strong> anything you submit through the in-app feedback form,
            along with your email if provided.</p>
          <p><strong>Local device storage:</strong> we use your browser's local storage to remember your free
            trial start date and whether you've dismissed certain in-app notices. This stays on your device
            and is not transmitted to us as a separate data collection step.</p>
        </Section>

        <Section title="3. How we use this information">
          <ul style={{ paddingLeft: 18, margin: '6px 0' }}>
            <li>To create and maintain your account and free trial status;</li>
            <li>To process payments and grant access to the tier/product you purchased;</li>
            <li>To send account-related and, if you opt in, marketing emails;</li>
            <li>To respond to support requests and feedback;</li>
            <li>To understand aggregate usage of the Service and improve it;</li>
            <li>To detect and prevent abuse of the Service.</li>
          </ul>
        </Section>

        <Section title="4. Marketing emails">
          <p>
            Marketing emails are only sent if you explicitly opt in via the checkbox shown at sign-up, which
            is separate from and not bundled with acceptance of our Terms. You can opt out at any time via
            the unsubscribe link in any marketing email.
          </p>
        </Section>

        <Section title="5. Who we share information with">
          <p>We share information with the following categories of third-party service providers, solely to
            operate the Service:</p>
          <ul style={{ paddingLeft: 18, margin: '6px 0' }}>
            <li><strong>Supabase</strong> — database, authentication, and file storage;</li>
            <li><strong>Google / Facebook</strong> — if you use OAuth sign-in;</li>
            <li><strong>Google Analytics (GA4)</strong> — usage analytics;</li>
            <li><strong>Pesapal / PawaPay</strong> — payment processing;</li>
            <li><strong>Brevo</strong> — transactional and marketing email delivery.</li>
          </ul>
          <p>
            We do not sell your personal information. We may disclose information if required by law, or to
            protect the rights, safety, or property of Odd Saint or its users.
          </p>
        </Section>

        <Section title="6. Data retention">
          <p>
            We retain account and transaction data for as long as your account is active and for a
            reasonable period afterward for legal, accounting, and fraud-prevention purposes. You can
            request deletion of your account as described in Section 8.
          </p>
        </Section>

        <Section title="7. International transfers">
          <p>
            Our service providers may process and store data outside your country of residence. Where this
            occurs, we rely on those providers' own compliance safeguards.
          </p>
        </Section>

        <Section title="8. Your rights">
          <p>
            Depending on your location, you may have rights to access, correct, or delete your personal
            information, or to object to certain processing (such as marketing emails). To exercise these
            rights, contact us at 16bitengine@gmail.com.
          </p>
        </Section>

        <Section title="9. Children's privacy">
          <p>
            The Service is not directed to, and we do not knowingly collect personal information from,
            anyone under 18. If you believe a minor has provided us information, contact us at
            16bitengine@gmail.com and we will delete it.
          </p>
        </Section>

        <Section title="10. Security">
          <p>
            We use industry-standard safeguards, including database-level access controls, to protect your
            information. No method of transmission or storage is 100% secure, and we cannot guarantee
            absolute security.
          </p>
        </Section>

        <Section title="11. Changes to this policy">
          <p>
            We may update this Privacy Policy from time to time. Material changes will be reflected by an
            updated "Last updated" date above.
          </p>
        </Section>

        <Section title="12. Contact">
          <p>Questions about this Privacy Policy can be sent to 16bitengine@gmail.com.</p>
        </Section>
      </div>
    </div>
  );
          }
