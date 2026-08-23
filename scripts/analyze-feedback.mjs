// ---------------------------------------------------------------------------
// Odd Saint — feedback digest ("self-improvement", kept bounded)
//
// Reads APPROVED feedback (an admin must have already moderated it through
// the `feedback` table's status column — see migration 002 and
// src/lib/feedback.ts) and produces a plain-language digest bucketed by
// category, written to the GitHub Actions step summary for a human to
// review and act on.
//
// IMPORTANT — this does NOT change any code, config, or ticket-generation
// behavior automatically. "Self-improvement" here means a structured
// report a human decides how to act on, not autonomous code changes —
// the same reviewable/bounded principle already used by
// .github/workflows/ai-self-evolution.yml (which opens a PR rather than
// auto-merging). Wiring this into an actually-autonomous change pipeline
// would be a much bigger, separate decision.
//
// Run manually via .github/workflows/analyze-feedback.yml, not on a
// schedule — feedback volume on a new app won't usually justify a daily
// run, and a human should decide when a digest is worth generating.
// ---------------------------------------------------------------------------
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

const CATEGORIES = ['usability', 'performance', 'bug', 'support_request', 'general'];
const MAX_ITEMS_PER_CATEGORY_SHOWN = 10;
const MAX_ROWS_FETCHED = 200;
const MAX_MESSAGE_PREVIEW_CHARS = 200;

async function main() {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('feedback')
    .select('category, message, created_at')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS_FETCHED);
  if (error) throw error;

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  (data ?? []).forEach((row) => {
    if (byCategory[row.category]) byCategory[row.category].push(row.message);
  });

  const totalCount = data?.length ?? 0;

  let summary = `## Feedback digest — last ${totalCount} approved item(s)\n\n`;
  summary +=
    'Grouped by category. Only items an admin has already moved to ' +
    '`approved` in the `feedback` table appear here — nothing unmoderated ' +
    'is ever included.\n\n';

  for (const category of CATEGORIES) {
    const items = byCategory[category];
    summary += `### ${category} (${items.length})\n`;
    if (items.length === 0) {
      summary += '_No approved items in this category._\n\n';
      continue;
    }
    items.slice(0, MAX_ITEMS_PER_CATEGORY_SHOWN).forEach((message) => {
      const preview = message.length > MAX_MESSAGE_PREVIEW_CHARS
        ? `${message.slice(0, MAX_MESSAGE_PREVIEW_CHARS)}…`
        : message;
      summary += `- ${preview}\n`;
    });
    if (items.length > MAX_ITEMS_PER_CATEGORY_SHOWN) {
      summary += `- _...and ${items.length - MAX_ITEMS_PER_CATEGORY_SHOWN} more._\n`;
    }
    summary += '\n';
  }

  summary +=
    '---\n\n' +
    '**Before acting on anything above**, weigh it against Odd Saint\'s actual objectives:\n' +
    '1. Usability — is the app easy to use?\n' +
    '2. Performance quality — does it produce genuinely positive, well-graded results?\n' +
    '3. Discoverability — is it SEO-responsive and easily findable via search?\n' +
    '4. Competitive benchmark — how does it compare with existing similar apps, and what could it learn from them?\n\n' +
    'Not every piece of feedback is worth acting on — isolated or off-topic items ' +
    'should generally be set aside in favor of recurring, verifiable patterns ' +
    'in the categories above. This digest makes no code or configuration ' +
    'changes on its own.\n';

  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
