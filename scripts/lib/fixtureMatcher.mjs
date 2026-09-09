// ---------------------------------------------------------------------------
// Odd Saint — fixture matcher
//
// football-data.org and The Odds API are two independent providers with
// two independent ID spaces and no shared fixture ID between them. This
// joins a football-data.org match to its corresponding The Odds API event
// by normalized team name + kickoff-time proximity — the same kind of
// cross-provider join a human trader does by eye, made deterministic.
//
// This is a real, accepted source of imperfection in the majors pool: a
// team-name variant neither list anticipates, or a fixture rescheduled by
// more than the tolerance window on one provider but not the other, means
// that match is silently skipped for odds (not fabricated) — see
// unmatched handling in generate-tickets.mjs, which logs a warning and
// moves on rather than guessing a price.
// ---------------------------------------------------------------------------

// How far apart two providers' kickoff times can be and still be treated as
// the same match. Real reschedules are usually announced days ahead (so
// both providers update); this window is meant to absorb minor clock/data
// entry differences, not genuine reschedules.
const KICKOFF_TOLERANCE_MINUTES = 15;

// Trailing/leading tokens common enough across club names that stripping
// them measurably improves match rate without risking false positives
// (e.g. "Real Madrid CF" vs "Real Madrid", "Sporting CP" vs "Sporting").
// Deliberately conservative — no aggressive nickname substitution (no
// "Man Utd" <-> "Manchester United" mapping), since a wrong merge here
// means grading the wrong match's result against a ticket.
const STRIP_TOKENS = new Set(['fc', 'cf', 'afc', 'sc', 'cp', 'ac', 'sv', 'as']);

export function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation -> space
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STRIP_TOKENS.has(token))
    .join(' ')
    .trim();
}

function minutesApart(isoA, isoB) {
  return Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / 60_000;
}

/**
 * Matches football-data.org matches (see footballDataOrg.mjs) against The
 * Odds API events (see theOddsApi.mjs, already grouped by sport key by the
 * caller) for ONE competition at a time — callers should call this once
 * per fdoCode/sportKey pair rather than mixing competitions, since team
 * names are only guaranteed unique within a competition.
 *
 * Returns { matched: [{ fdoMatch, oddsEvent }], unmatchedFdoMatches: [...] }.
 * Never fabricates a match when uncertain — an unmatched football-data.org
 * fixture just has no odds and is excluded from the pool, same as an
 * API-Football fixture with no usable market.
 */
export function matchFixtures(fdoMatches, oddsEvents) {
  const matched = [];
  const unmatchedFdoMatches = [];
  const usedOddsEventIds = new Set();

  for (const fdoMatch of fdoMatches) {
    const fdoHome = normalizeTeamName(fdoMatch.homeTeam?.name);
    const fdoAway = normalizeTeamName(fdoMatch.awayTeam?.name);

    const candidate = oddsEvents.find((event) => {
      if (usedOddsEventIds.has(event.id)) return false;
      const oddsHome = normalizeTeamName(event.home_team);
      const oddsAway = normalizeTeamName(event.away_team);
      if (fdoHome !== oddsHome || fdoAway !== oddsAway) return false;
      return minutesApart(fdoMatch.utcDate, event.commence_time) <= KICKOFF_TOLERANCE_MINUTES;
    });

    if (candidate) {
      usedOddsEventIds.add(candidate.id);
      matched.push({ fdoMatch, oddsEvent: candidate });
    } else {
      unmatchedFdoMatches.push(fdoMatch);
    }
  }

  return { matched, unmatchedFdoMatches };
}
