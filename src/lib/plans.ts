// ---------------------------------------------------------------------------
// Subscription plan definitions — shared between the pricing UI and the
// checkout API route.
//
// IMPORTANT: the checkout route looks up the price from THIS file using
// only the plan ID the client sends — it never accepts a price/amount
// directly from the client. That's a deliberate security practice for
// payment integrations: a client-submitted amount could be tampered with
// before it reaches the server.
// ---------------------------------------------------------------------------

export type PlanId = 'weekly' | 'monthly' | 'yearly';

export interface PlanConfig {
  id: PlanId;
  label: string;
  amountUsd: number;
  days: number; // how long a successful payment grants access for
}

export const PLANS: Record<PlanId, PlanConfig> = {
  weekly: { id: 'weekly', label: 'Weekly', amountUsd: 2.49, days: 7 },
  monthly: { id: 'monthly', label: 'Monthly', amountUsd: 7.99, days: 30 },
  yearly: { id: 'yearly', label: 'Yearly', amountUsd: 67, days: 365 },
};

export function isValidPlanId(value: string): value is PlanId {
  return value === 'weekly' || value === 'monthly' || value === 'yearly';
}

// ---------------------------------------------------------------------------
// Saint's Lock plans — deliberately separate from PLANS above. This is a
// distinct product (single-match, ultra-high-confidence picks), not a
// discount tier of the main subscription: it has its own pricing, its own
// sign-up requirement, and explicitly no free trial ever applies to it.
// ---------------------------------------------------------------------------

export type SaintsLockPlanId = 'daily' | 'weekly' | 'monthly';

export interface SaintsLockPlanConfig {
  id: SaintsLockPlanId;
  label: string;
  amountUsd: number;
  days: number;
}

export const SAINTS_LOCK_PLANS: Record<SaintsLockPlanId, SaintsLockPlanConfig> = {
  daily: { id: 'daily', label: 'Daily', amountUsd: 1.5, days: 1 },
  weekly: { id: 'weekly', label: 'Weekly', amountUsd: 7, days: 7 },
  monthly: { id: 'monthly', label: 'Monthly', amountUsd: 27, days: 30 },
};

export function isValidSaintsLockPlanId(value: string): value is SaintsLockPlanId {
  return value === 'daily' || value === 'weekly' || value === 'monthly';
}

// ---------------------------------------------------------------------------
// Pay-per-ticket unlock ("Pay Micro-Fee") — a flat one-off price, not a
// dated plan like PLANS/SAINTS_LOCK_PLANS above. No trial or recurring
// billing applies here; a successful payment upserts exactly one row into
// `ticket_unlocks` for that specific ticket only (see grantAccess.ts and
// supabase/migrations/004_ticket_unlocks.sql).
//
// ASSUMPTION — PLACEHOLDER PRICE: no per-ticket price existed anywhere in
// the codebase before this change. $0.99 is a reasonable placeholder given
// the subscription tiers above, but confirm/adjust this before going live.
// ---------------------------------------------------------------------------
export const TICKET_UNLOCK_PRICE_USD = 0.99;
