import { supabase } from './supabaseClient';

// ---------------------------------------------------------------------------
// Client-side helper for an admin comping subscription or Saint's Lock
// access for another user. All real verification happens server-side in
// src/app/api/admin/grant-access/route.ts (the caller's own current
// session token is sent for the server to verify — this file does not,
// and cannot, grant anything on its own).
// ---------------------------------------------------------------------------

export type GrantableProduct = 'subscription' | 'saints_lock';

export async function adminGrantAccess(params: {
  targetEmail: string;
  product: GrantableProduct;
  plan: string;
}): Promise<{ success: boolean; error?: string }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    return { success: false, error: 'You must be signed in as an admin to do this.' };
  }

  try {
    const res = await fetch('/api/admin/grant-access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (!res.ok) return { success: false, error: json.error ?? 'Could not grant access.' };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Something went wrong.' };
  }
}
