import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — Odd Saint',
  description: 'Terms of Service governing use of the Odd Saint football prediction tickets platform.',
};

const COLORS = {
  bg: '#f4f6f5',
  surface: '#ffffff',
  border: '#d7dedb',
  emerald: '#0b8a4f',
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

export default function TermsPage() {
  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.textPrimary }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 20px 80px' }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Terms of Service</h1>
        <p style={{ fontSize: 12.5, color: COLORS.textMuted, marginBottom: 30 }}>
          Effective date: September 10, 2026 · Last updated: September 10, 2026
        </p>

        <Section title="1. Who we are">
          <p>
            Odd Saint ("Odd Saint", "we", "us", "our") is operated by an individual trading as 16bitengine,
            based in Uganda ("Operator"), pending formal business registration under that name. These Terms
            of Service ("Terms") govern your access to and use of the Odd Saint website at odd-saint.net and
            any related services (collectively, the "Service"). By creating an account, purchasing a plan,
            or otherwise using the Service, you agree to these Terms. If you do not agree, do not use the
            Service.
          </p>
        </Section>

        <Section title="2. What Odd Saint is — and is not">
          <p>
            Odd Saint provides AI-assisted statistical analysis of football fixtures, presented as curated
            prediction "tickets." <strong>Odd Saint is not a betting operator, a bookmaker, or a gambling
            platform.</strong> We do not accept wagers, hold customer betting funds, or pay out winnings of
            any kind. Any wagering you choose to place with a third-party bookmaker based on our content is
            done entirely at your own discretion and risk, on that bookmaker's own platform and terms.
          </p>
          <p>
            Every prediction, confidence score, and ticket is a statistical opinion derived from bookmaker
            consensus odds and selection heuristics — it is <strong>never a guarantee of any outcome</strong>.
            Past performance, including any win-rate figures shown in our Performance History, is historical
            and does not predict future results.
          </p>
        </Section>

        <Section title="3. Eligibility">
          <p>
            You must be at least 18 years old (or the age of legal majority in your jurisdiction, if higher)
            to create an account or purchase a plan. By using the Service you represent that you meet this
            requirement and that your use of the Service is lawful in your jurisdiction, including any local
            laws governing sports-prediction, tipster, or gambling-adjacent content.
          </p>
        </Section>

        <Section title="4. Accounts">
          <p>
            You may create an account via email magic link or via Google/Facebook sign-in. You are
            responsible for maintaining the confidentiality of your account and for all activity under it.
            Notify us immediately at 16bitengine@gmail.com of any unauthorized use.
          </p>
        </Section>

        <Section title="5. Free trial, subscriptions & Saint's Lock">
          <p>
            New visitors receive a time-limited free trial during which ticket content is unlocked without
            payment. Trial length is disclosed in the app and may change, including a shortened trial once
            stated usage milestones are reached.
          </p>
          <p>
            Paid plans grant access to premium ticket tiers for a fixed period (e.g. weekly, monthly, yearly)
            from the time of successful payment. <strong>Plans do not auto-renew</strong> — access simply
            expires at the end of the paid period unless you purchase again. Saint's Lock is a separate,
            single-match premium product with its own pricing and no free trial; it requires a registered
            account and a completed purchase to access.
          </p>
          <p>
            Current pricing is shown in the app at checkout and is the authoritative figure at time of
            purchase.
          </p>
        </Section>

        <Section title="6. Payments">
          <p>
            Payments are processed by third-party payment providers (currently Pesapal, and optionally
            mobile money via PawaPay where you explicitly choose that method). We do not store your full
            card or mobile money credentials — payment data is handled directly by these providers under
            their own terms and privacy policies. You agree to those providers' terms when you complete a
            transaction through them.
          </p>
        </Section>

        <Section title="7. Refunds">
          <p>
            Because access is granted immediately upon payment and consists of digital analytical content,
            <strong> all sales are final and non-refundable</strong>, except where required by applicable
            law or at our sole discretion in cases of a demonstrable billing error (e.g. a duplicate charge).
            Refund requests can be sent to 16bitengine@gmail.com.
          </p>
        </Section>

        <Section title="8. Acceptable use">
          <p>You agree not to:</p>
          <ul style={{ paddingLeft: 18, margin: '6px 0' }}>
            <li>Attempt to circumvent access controls, paywalls, or rate limits;</li>
            <li>Scrape, resell, or redistribute ticket content without our written permission;</li>
            <li>Use the Service for any unlawful purpose, including in a jurisdiction where accessing
              sports-prediction content of this kind is prohibited;</li>
            <li>Submit false, abusive, or spam feedback/support messages;</li>
            <li>Attempt to gain unauthorized administrative access.</li>
          </ul>
        </Section>

        <Section title="9. Intellectual property">
          <p>
            All content, branding, design, and underlying software of the Service are owned by the Operator
            or its licensors. You may view and use ticket content for your own personal, non-commercial
            reference; you may not republish it as your own.
          </p>
        </Section>

        <Section title="10. Disclaimers and limitation of liability">
          <p>
            The Service is provided "as is" without warranties of any kind. Sports outcomes are inherently
            unpredictable. To the maximum extent permitted by law, the Operator is not liable for any
            financial loss, damages, or claims arising from decisions made on the basis of content provided
            through the Service, including losses incurred through third-party wagering. You use the
            Service, and any information from it, entirely at your own risk.
          </p>
        </Section>

        <Section title="11. Termination">
          <p>
            We may suspend or terminate your access to the Service at our discretion, including for
            violation of these Terms, without obligation to refund any unused portion of a paid plan except
            as required by law.
          </p>
        </Section>

        <Section title="12. Changes to these Terms">
          <p>
            We may update these Terms from time to time. Continued use of the Service after an update
            constitutes acceptance of the revised Terms. Material changes will be reflected by an updated
            "Last updated" date above.
          </p>
        </Section>

        <Section title="13. Governing law">
          <p>These Terms are governed by the laws of the Republic of Uganda, without regard to conflict-of-law principles.</p>
        </Section>

        <Section title="14. Contact">
          <p>Questions about these Terms can be sent to 16bitengine@gmail.com.</p>
        </Section>
      </div>
    </div>
  );
      }

