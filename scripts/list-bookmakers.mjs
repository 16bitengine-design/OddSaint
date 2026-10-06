// ---------------------------------------------------------------------------
// Odd Saint — list the bookmakers API-Football carries odds for.
// Run once via the manual "List Bookmakers" workflow, find the bookmakers
// your target market uses, and put their IDs (comma-separated, highest
// priority first) in the repo variable TARGET_BOOKMAKER_IDS.
// ---------------------------------------------------------------------------
import { getBookmakers } from './lib/apiFootball.mjs';

const list = await getBookmakers();
const rows = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
console.log(`${rows.length} bookmaker(s) available:\n`);
rows.forEach((b) => console.log(`${String(b.id).padStart(4)}  ${b.name}`));
console.log('\nSet TARGET_BOOKMAKER_IDS to the IDs your target market uses, e.g. 11,8');
