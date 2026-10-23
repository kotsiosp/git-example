'use strict';

// Free match results from football-data.org (v4), used to settle football bets so no odds credits
// are spent on scores. Its free plan covers the major European competitions below.

const COMPETITIONS = {
  soccer_epl: 'PL',
  soccer_spain_la_liga: 'PD',
  soccer_italy_serie_a: 'SA',
  soccer_germany_bundesliga: 'BL1',
  soccer_france_ligue_one: 'FL1',
  soccer_uefa_champs_league: 'CL',
  soccer_netherlands_eredivisie: 'DED',
  soccer_portugal_primeira_liga: 'PPL',
  soccer_efl_champ: 'ELC',
  soccer_brazil_campeonato: 'BSA',
};

// Words that differ between the two services' club names without identifying the club.
const NOISE = new Set(['fc', 'cf', 'afc', 'ac', 'as', 'ssc', 'sc', 'cd', 'ud', 'rc', 'rcd', 'sd', 'club', 'de', 'del', 'la',
  'calcio', 'fk', 'sv', 'and', 'the', 'football', '1']);

function tokens(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !NOISE.has(t));
}

// Share of the shorter name's words found in the other ("Inter" matches "Internazionale").
function teamSimilarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const hits = short.filter((s) => long.some((l) => l === s || (Math.min(s.length, l.length) >= 3 && (l.startsWith(s) || s.startsWith(l)))));
  return hits.length / short.length;
}

const MAX_KICKOFF_GAP_MS = 6 * 3600 * 1000;

// Finds the football-data match for one of our events: same kick-off (within hours) and both clubs matching.
function findMatch(event, matches) {
  let best = null;
  for (const m of matches) {
    if (Math.abs(Date.parse(m.utcDate) - Date.parse(event.commence_time)) > MAX_KICKOFF_GAP_MS) continue;
    const home = teamSimilarity(event.home_team, m.homeTeam?.name || '');
    const away = teamSimilarity(event.away_team, m.awayTeam?.name || '');
    if (home < 0.5 || away < 0.5) continue;
    if (!best || home + away > best.score) best = { match: m, score: home + away };
  }
  return best?.match ?? null;
}

// Bets settle on the result after 90 minutes; extra time and penalties don't count.
function finalScore(match) {
  if (match.status !== 'FINISHED') return null;
  const s = match.score?.regularTime ?? match.score?.fullTime;
  if (s?.home == null || s?.away == null) return null;
  return [Number(s.home), Number(s.away)];
}

function createFootballDataClient(config, fetchImpl = fetch) {
  return {
    covers: (sportKey) => !!COMPETITIONS[sportKey],
    async matches(sportKey, dateFrom, dateTo) {
      const url = new URL(`${config.footballDataBase}/competitions/${COMPETITIONS[sportKey]}/matches`);
      url.searchParams.set('dateFrom', dateFrom);
      url.searchParams.set('dateTo', dateTo);
      const res = await fetchImpl(url, { headers: { 'X-Auth-Token': config.footballDataKey } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`football-data.org ${COMPETITIONS[sportKey]} failed: ${res.status} ${body.slice(0, 200)}`);
      }
      return (await res.json()).matches || [];
    },
  };
}

module.exports = { createFootballDataClient, findMatch, finalScore, teamSimilarity, COMPETITIONS };
