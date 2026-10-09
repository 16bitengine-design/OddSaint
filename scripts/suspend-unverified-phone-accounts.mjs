// ---------------------------------------------------------------------------
// Odd Saint — suspend unverified phone-only accounts
//
// Runs daily via .github/workflows/suspend-unverified-phone-accounts.yml.
//
// Policy (mirrors PhoneVerifyBanner in src/app/page.tsx — keep in sync):
//   - A phone-only account must verify an email (click the confirmation link).
//   - 3 days after creation the app starts warning "your account will be
//     suspended within 7 days".
//   - So an account still unverified 3 + 7 = 10 days after creation is due
//     for suspension, which is what this script does.
//
// "Suspend" = Supabase Auth ban (admin updateUserById with ban_duration): the
// user can no longer sign in or refresh a session. Nothing is deleted. It is
// fully reversible — reinstate with
//   supabase.auth.admin.updateUserById(id, { ban_duration: 'none' })
// (or clear "Banned until" on the user in the Supabase dashboard). Each
// suspended user gets app_metadata.suspended_reason / suspended_at so you can
// find them later.
//
// Safeguards: DRY_RUN=true only reports; admins are never suspended; at most
// MAX_SUSPENSIONS_PER_RUN accounts per run, so a logic bug can't mass-ban.
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

export const WARN_AFTER_DAYS = 3; // PHONE_VERIFY_WARN_AFTER_DAYS in page.tsx
export const SUSPEND_WITHIN_DAYS = 7; // PHONE_SUSPEND_WITHIN_DAYS in page.tsx
export const SUSPEND_AFTER_DAYS = WARN_AFTER_DAYS + SUSPEND_WITHIN_DAYS;
const MAX_SUSPENSIONS_PER_RUN = 200;
const BAN_DURATION = '876000h'; // ~100 years; Supabase has no "forever"
const DAY_MS = 86_400_000;

/** Pure rule: is this auth user a phone-only account past its deadline? */
export function isDueForSuspension(user, adminIds, now = Date.now()) {
  if (!user.phone) return false; // not a phone account
  if (user.email_confirmed_at) return false; // verified an email
  if (adminIds.has(user.id)) return false;
  if (user.banned_until && new Date(user.banned_until).getTime() > now) return false; // already suspended
  const ageMs = now - new Date(user.created_at).getTime();
  return ageMs >= SUSPEND_AFTER_DAYS * DAY_MS;
}

async function listAllUsers(supabase) {
  const users = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < perPage) break;
  }
  return users;
}

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  const supabase = getSupabaseAdmin();

  const { data: admins, error: adminErr } = await supabase.from('admins').select('user_id');
  if (adminErr) throw adminErr;
  const adminIds = new Set((admins ?? []).map((a) => a.user_id));

  const users = await listAllUsers(supabase);
  const now = Date.now();
  const due = users.filter((u) => isDueForSuspension(u, adminIds, now));
  const batch = due.slice(0, MAX_SUSPENSIONS_PER_RUN);

  console.log(
    `${users.length} users scanned; ${due.length} phone-only account(s) unverified for ${SUSPEND_AFTER_DAYS}+ days` +
      (dryRun ? ' (DRY RUN — nothing will be changed).' : '.')
  );
  if (due.length > batch.length) {
    console.warn(`Capped at ${MAX_SUSPENSIONS_PER_RUN} this run; ${due.length - batch.length} remain for the next run.`);
  }

  const suspended = [];
  const failed = [];
  for (const user of batch) {
    const label = `${user.id} (${user.phone})`;
    if (dryRun) {
      suspended.push(label);
      continue;
    }
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      ban_duration: BAN_DURATION,
      app_metadata: { suspended_reason: 'phone_unverified', suspended_at: new Date().toISOString() },
    });
    if (error) {
      console.error(`Failed to suspend ${label}:`, error.message);
      failed.push(label);
    } else {
      suspended.push(label);
    }
  }

  const summary =
    `### Unverified phone accounts\n` +
    `- Scanned: ${users.length}\n- Due: ${due.length}\n` +
    `- ${dryRun ? 'Would suspend' : 'Suspended'}: ${suspended.length}\n- Failed: ${failed.length}\n` +
    (suspended.length ? `\n${suspended.map((s) => `- ${s}`).join('\n')}\n` : '');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Suspension run failed:', err);
    process.exit(1);
  });
}
