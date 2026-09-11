// ---------------------------------------------------------------------------
// Odd Saint — self-improvement proposals
//
// Unlike scripts/self-tune.mjs (which silently tightens a few safe
// parameters within pre-approved bounds), this script only ever produces
// a PROPOSAL — a markdown report of evidence-backed suggestions that a
// human has to read and act on manually. Nothing here edits
// generate-tickets.mjs, markets.mjs, or any other pipeline file. The
// workflow that runs this (.github/workflows/propose-improvements.yml)
// commits the resulting PROPOSALS.md to a branch and opens a PR — the PR
// diff IS the proposal, reviewed and merged (or closed) like any other
// change, same bounded pattern as ai-self-evolution.yml's dependency PRs.
//
// Covers three things self-tune.mjs deliberately does NOT touch:
//   1. Everything self-tune.mjs HAS done automatically recently (from
//      tuning_log) — so a human reviewing this has the full picture, not
//      just the parts that need a decision.
//   2. Candidate LOOSENING moves (lower confidence floor, wider small-
//      ticket odds cap) — self-tune.mjs only ever tightens automatically;
//      loosening always needs a human to sign off, even with strong
//      evidence, because it trades safety for volume.
//   3. Model cross-check coverage and agreement — once
//      scripts/lib/modelCrossCheck.mjs has logged enough graded fixtures
//      with model_available = true, this reports how often the Poisson
//      model agreed with the bookmaker-derived pick, broken out by
//      market, and flags when there's enough data to seriously consider
//      moving from cross-check-only to the blended-confidence approach
//      teamModel.mjs's own integration note describes (75% bookmaker /
//      25% model) — WITHOUT ever making that change itself.
//
// Run manually, or monthly via propose-improvements.yml — there's no
// reason to re-propose weekly when self-tune.mjs is already handling the
// safe, fast-moving adjustments in between.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

const LOOKBACK_DAYS = 30;
const MIN_CROSS_CHECK_SAMPLE_FOR_BLEND_CONSIDERATION = 150;
const MIN_LEAGUE_SAMPLE = 8;

function pct(wins, total) {
  return total > 0 ? Math.round((wins / total) * 1000) / 10 : null;
}

async function main() {
  const supabase = getSupabaseAdmin();
  const cutoffISO = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: fixtureRows, error: fixtureErr } = await supabase
    .from('fixtures')
    .select('market, confidence, odds, result_status, kickoff, league, model_probability, model_available')
    .in('result_status', ['green', 'red'])
    .gte('kickoff', cutoffISO)
    .limit(5000);
  if (fixtureErr) throw fixtureErr;
  const fixtures = fixtureRows ?? [];

  const { data: tuningRows, error: tuningErr } = await supabase
    .from('tuning_log')
    .select('*')
    .gte('created_at', cutoffISO)
    .order('created_at', { ascending: false });
  if (tuningErr) throw tuningErr;
  const recentTunes = tuningRows ?? [];

  const { data: stateRow } = await supabase.from('tuning_state').select('*').eq('id', 1).single();

  let md = `# Odd Saint — Self-Improvement Proposals\n\n`;
  md += `_Generated ${new Date().toISOString()} from the last ${LOOKBACK_DAYS} days of graded results. `;
  md += `This file is a REPORT ONLY — nothing here changes the pipeline automatically. `;
  md += `Read the evidence, then decide what (if anything) to change in scripts/generate-tickets.mjs._\n\n`;

  // -------------------------------------------------------------------
  // 1. What self-tune.mjs already did automatically
  // -------------------------------------------------------------------
  md += `## Automatic adjustments already applied (scripts/self-tune.mjs)\n\n`;
  if (recentTunes.length === 0) {
    md += `_No automatic adjustments in the last ${LOOKBACK_DAYS} days._\n\n`;
  } else {
    md += `| When | Parameter | Change | Evidence |\n|---|---|---|---|\n`;
    recentTunes.forEach((t) => {
      md += `| ${t.created_at.slice(0, 10)} | ${t.parameter} | ${t.old_value} → ${t.new_value} | ${t.reason} |\n`;
    });
    md += '\n';
  }
  if (stateRow) {
    md += `**Current live values:** min_confidence=${stateRow.min_confidence}, `;
    md += `small_ticket_max_odds=${stateRow.small_ticket_max_odds}, `;
    md += `saints_lock_min_confidence=${stateRow.saints_lock_min_confidence}\n\n`;
  }

  // -------------------------------------------------------------------
  // 2. Candidate LOOSENING moves — human decision only
  // -------------------------------------------------------------------
  md += `## Candidate loosening moves (require a human decision)\n\n`;
  md += `self-tune.mjs never does these automatically — only reports the evidence.\n\n`;

  if (stateRow) {
    const current = stateRow.min_confidence;
    const lower = current - 2;
    const atCurrent = fixtures.filter((f) => f.confidence >= current);
    const atLower = fixtures.filter((f) => f.confidence >= lower && f.confidence < current);
    const winRateCurrent = pct(atCurrent.filter((f) => f.result_status === 'green').length, atCurrent.length);
    const winRateLowerBand = pct(atLower.filter((f) => f.result_status === 'green').length, atLower.length);

    md += `**MIN_CONFIDENCE (currently ${current}%):** `;
    if (atLower.length === 0) {
      md += `the ${lower}–${current - 1}% band has too little data in the last ${LOOKBACK_DAYS} days to evaluate.\n\n`;
    } else {
      md += `the ${lower}–${current - 1}% band won ${winRateLowerBand}% over ${atLower.length} graded fixture(s) `;
      md += `(vs ${winRateCurrent}% at ${current}%+, n=${atCurrent.length}). `;
      const gap = winRateCurrent !== null && winRateLowerBand !== null ? winRateCurrent - winRateLowerBand : null;
      md += gap !== null && gap <= 5
        ? `This band is close enough to the current win rate that lowering the floor by one step may be worth considering if you want more ticket volume.\n\n`
        : `This band underperforms enough that lowering the floor is not currently recommended.\n\n`;
    }
  }

  // -------------------------------------------------------------------
  // 3. League / market health — flags, not auto-excludes
  // -------------------------------------------------------------------
  md += `## League and market health\n\n`;
  const byLeague = new Map();
  fixtures.forEach((f) => {
    const entry = byLeague.get(f.league) ?? { green: 0, red: 0 };
    if (f.result_status === 'green') entry.green++;
    else entry.red++;
    byLeague.set(f.league, entry);
  });
  const weakLeagues = Array.from(byLeague.entries())
    .filter(([, { green, red }]) => green + red >= MIN_LEAGUE_SAMPLE && pct(green, green + red) < 60)
    .sort((a, b) => pct(a[1].green, a[1].green + a[1].red) - pct(b[1].green, b[1].green + b[1].red));

  if (weakLeagues.length === 0) {
    md += `_No league fell under a 60% win rate with at least ${MIN_LEAGUE_SAMPLE} graded fixtures this window._\n\n`;
  } else {
    md += `Leagues under 60% win rate (min ${MIN_LEAGUE_SAMPLE} sample) — consider for PRIORITY_LEAGUE_NAMES `;
    md += `demotion or EXCLUDED_TEAMS review in scripts/generate-tickets.mjs:\n\n`;
    md += `| League | Win rate | Sample |\n|---|---|---|\n`;
    weakLeagues.forEach(([league, { green, red }]) => {
      md += `| ${league} | ${pct(green, green + red)}% | ${green + red} |\n`;
    });
    md += '\n';
  }

  // -------------------------------------------------------------------
  // 4. Model cross-check coverage and agreement
  // -------------------------------------------------------------------
  md += `## Model cross-check (Poisson model vs. bookmaker-derived pick)\n\n`;
  const withModel = fixtures.filter((f) => f.model_available && f.model_probability !== null);
  md += `${withModel.length} of ${fixtures.length} graded fixture(s) in this window had a model opinion available.\n\n`;

  if (withModel.length < MIN_CROSS_CHECK_SAMPLE_FOR_BLEND_CONSIDERATION) {
    md += `Not yet enough cross-check data (need ${MIN_CROSS_CHECK_SAMPLE_FOR_BLEND_CONSIDERATION}+, have ${withModel.length}) `;
    md += `to seriously evaluate moving from cross-check-only to a blended confidence score. Keep accumulating.\n\n`;
  } else {
    const byMarket = new Map();
    withModel.forEach((f) => {
      const entry = byMarket.get(f.market) ?? { fixtures: [], totalModelProb: 0 };
      entry.fixtures.push(f);
      entry.totalModelProb += f.model_probability;
      byMarket.set(f.market, entry);
    });

    md += `| Market | Observed win rate | Model-implied win rate | Sample |\n|---|---|---|---|\n`;
    Array.from(byMarket.entries()).forEach(([market, entry]) => {
      const observed = pct(entry.fixtures.filter((f) => f.result_status === 'green').length, entry.fixtures.length);
      const modelImplied = Math.round((entry.totalModelProb / entry.fixtures.length) * 1000) / 10;
      md += `| ${market} | ${observed}% | ${modelImplied}% | ${entry.fixtures.length} |\n`;
    });
    md += '\n';
    md += `There's now enough cross-check data to evaluate teamModel.mjs's own integration note — `;
    md += `blending 75% bookmaker / 25% model confidence — against real results, e.g. by extending `;
    md += `\`node scripts/analyze-performance.mjs\` with a backtest over model_probability. `;
    md += `**This script does not make that change itself** — it's a structural change to the selection `;
    md += `pipeline, not a numeric threshold, and belongs in a reviewed PR of its own.\n\n`;
  }

  md += `---\n\n`;
  md += `_Next scheduled proposal: see .github/workflows/propose-improvements.yml. `;
  md += `Automatic (safe-direction-only) tuning continues in between via .github/workflows/self-tune.yml._\n`;

  writeFileSync('PROPOSALS.md', md);
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
