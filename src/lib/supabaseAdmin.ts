import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Service-role Supabase client — for server-side Next.js code ONLY (API
// routes, webhook handlers). The service role key bypasses Row Level
// Security, which is exactly why it must never reach the browser:
//   - Never import this file from a 'use client' component.
//   - Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as plain Vercel
//     environment variables — NEVER prefix them with NEXT_PUBLIC_, which
//     would bundle the service-role key into client-side JS.
//
// This is the Next.js/Vercel counterpart to scripts/lib/supabaseAdmin.mjs,
// which is the equivalent client used by the GitHub Actions pipeline
// (plain .mjs, reads the same-named secrets from GitHub Actions instead of
// Vercel). Same pattern, two runtimes — kept as separate files rather than
// shared, since scripts/ isn't part of the Next.js build and src/ isn't
// part of the GitHub Actions job.
// ---------------------------------------------------------------------------

let cachedAdmin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedAdmin) return cachedAdmin;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. ' +
        'Add both in Vercel: Project Settings → Environment Variables (all environments). ' +
        'Never prefix either with NEXT_PUBLIC_ — that would expose the service-role key to the browser.'
    );
  }

  cachedAdmin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return cachedAdmin;
}
