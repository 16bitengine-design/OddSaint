import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import Script from 'next/script';

// Single bold sans-serif family, used everywhere — headlines through data
// rows. Sportsbook/bookmaker interfaces prioritize fast scanning over
// editorial polish, so one consistent, heavily-weighted sans reads clearer
// at a glance than mixing in a display serif. Self-hosted at build time by
// next/font (no runtime request to Google, no extra npm package).
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://odd-saint.net'),
  title: 'Odd Saint — AI Football Prediction Tickets',
  description:
    'Curated football prediction tickets, AI-assisted and graded in the open. Not financial or betting advice.',
};

// Set NEXT_PUBLIC_GA_MEASUREMENT_ID in Vercel (and .env.local for dev) once
// you've created a GA4 property — see .env.local.example. Until it's set,
// no analytics script loads at all, so the site works identically either way.
const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body
        style={{
          margin: 0,
          background: '#f4f6f5',
          fontFamily: 'var(--font-body), system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        {/*
          Global styles kept as a plain <style> tag — no CSS-in-JS library,
          no framework, per the "native styling only" brief. Covers a couple
          of accessibility basics and the live/pending pulse used on
          in-play status indicators.
        */}
        <style>{`
          * { box-sizing: border-box; }
          ::selection { background: rgba(11,138,79,0.25); color: #12241c; }

          @keyframes livePulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.45; }
          }
          .live-pulse { animation: livePulse 1.6s ease-in-out infinite; }
          @media (prefers-reduced-motion: reduce) {
            .live-pulse { animation: none; }
          }

          button:focus-visible,
          input:focus-visible,
          a:focus-visible {
            outline: 2px solid #0b8a4f;
            outline-offset: 2px;
          }
        `}</style>

        {/*
          Google Analytics 4. GA4 automatically tracks engagement time and
          scroll depth per page/session on its own — the custom events fired
          from src/lib/analytics.ts add the app-specific detail on top (which
          tier a ticket is, where someone hit a paywall, which unlock method
          they tried), so both the automatic and custom signals show up
          together in GA4's reports.
        */}
        {GA_MEASUREMENT_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
              strategy="afterInteractive"
            />
            <Script id="ga4-init" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){ window.dataLayer.push(arguments); }
                window.gtag = gtag;
                gtag('js', new Date());
                gtag('config', '${GA_MEASUREMENT_ID}');
              `}
            </Script>
          </>
        )}

        {children}
      </body>
    </html>
  );
}
