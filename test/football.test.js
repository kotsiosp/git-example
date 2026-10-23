'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createOddsService } = require('../src/odds');
const { settleAll } = require('../src/settle');
const { findMatch, finalScore, teamSimilarity } = require('../src/footballData');

const HOUR = 3600 * 1000;
const base = { ...require('../src/config'), oddsApiKey: 'KEY', leagues: ['soccer_epl'], footballDataKey: '' };

// A fake Odds API: one Arsenal v Chelsea fixture; counts what each kind of request is called.
function oddsApi(kickoff, { eventsCost = 0 } = {}) {
  const calls = { events: 0, odds: 0, scores: 0, footballData: 0 };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    if (u.hostname === 'api.football-data.org') {
      calls.footballData++;
      assert.equal(opts.headers['X-Auth-Token'], 'FD');
      return new Response(JSON.stringify({ matches: fdMatches }));
    }
    const kind = u.pathname.split('/').pop();
    calls[kind]++;
    const bodies = {
      events: [{ id: 'ev1', commence_time: kickoff, home_team: 'Arsenal', away_team: 'Chelsea' }],
      odds: [{ id: 'ev1', sport_key: 'soccer_epl', commence_time: kickoff, home_team: 'Arsenal', away_team: 'Chelsea',
        bookmakers: [{ key: 'b', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2 }, { name: 'Chelsea', price: 3.6 }, { name: 'Draw', price: 3.3 }] }] }] }],
      scores: [],
    };
    const cost = { events: eventsCost, odds: 2, scores: 2 }[kind];
    return new Response(JSON.stringify(bodies[kind]), { headers: { 'x-requests-remaining': '400', 'x-requests-last': String(cost) } });
  };
  return { calls, fetchImpl };
}
let fdMatches = [];

test('club names from both services are matched', () => {
  const pairs = [['Inter Milan', 'FC Internazionale Milano'], ['Atlético Madrid', 'Club Atlético de Madrid'],
    ['Brighton and Hove Albion', 'Brighton & Hove Albion FC'], ['Bayern Munich', 'FC Bayern München'],
    ['Paris Saint Germain', 'Paris Saint-Germain FC'], ['AS Roma', 'AS Roma'], ['Manchester United', 'Manchester United FC']];
  for (const [a, b] of pairs) assert.ok(teamSimilarity(a, b) >= 0.5, `${a} ~ ${b}`);
  assert.ok(teamSimilarity('Manchester United', 'Manchester City FC') < 1);
  assert.equal(teamSimilarity('Chelsea', 'Arsenal FC'), 0);
});

test('a result is paired by kick-off time and both clubs, and settles on 90 minutes', () => {
  const ev = { home_team: 'Manchester United', away_team: 'Inter Milan', commence_time: '2026-10-21T19:00:00Z' };
  const m = (home, away, utcDate, score, status = 'FINISHED') => ({ homeTeam: { name: home }, awayTeam: { name: away }, utcDate, status, score });
  const matches = [
    m('Manchester City FC', 'FC Internazionale Milano', '2026-10-21T19:00:00Z', { fullTime: { home: 0, away: 0 } }),
    m('Manchester United FC', 'FC Internazionale Milano', '2026-10-21T19:00:00Z',
      { duration: 'EXTRA_TIME', fullTime: { home: 3, away: 2 }, regularTime: { home: 2, away: 2 } }),
    m('Manchester United FC', 'FC Internazionale Milano', '2026-11-04T19:00:00Z', { fullTime: { home: 1, away: 0 } }),
  ];
  const found = findMatch(ev, matches);
  assert.equal(found, matches[1]);
  assert.deepEqual(finalScore(found), [2, 2], 'extra time does not count');
  assert.equal(finalScore({ ...found, status: 'POSTPONED' }), null);
  assert.equal(findMatch({ ...ev, away_team: 'Juventus' }, matches), null);
});

test('prices refresh more often as kick-off nears, and not at all with nothing to play', async () => {
  const db = open(':memory:');
  const kickoff = Date.parse('2026-10-25T15:00:00Z');
  let t = kickoff - 5 * 24 * HOUR;
  const { calls, fetchImpl } = oddsApi(new Date(kickoff).toISOString());
  const svc = createOddsService(db, base, { fetchImpl, now: () => t, log: { error() {} } });

  const tick = async (hours) => { t += hours * HOUR; await svc.refreshOdds(); };
  await tick(0);
  assert.equal(calls.odds, 1, 'first refresh');
  for (let i = 0; i < 23; i++) await tick(1);
  assert.equal(calls.odds, 1, 'a week out: once a day');
  await tick(1);
  assert.equal(calls.odds, 2);
  t = kickoff - 20 * HOUR; await tick(0);
  assert.equal(calls.odds, 3, 'the day before: every 8 hours');
  await tick(7); assert.equal(calls.odds, 3);
  await tick(1); assert.equal(calls.odds, 4);
  t = kickoff - 2 * HOUR; await tick(0);
  assert.equal(calls.odds, 5, 'just before kick-off');
  await tick(1.5); assert.equal(calls.odds, 5);
  // After kick-off there is nothing left to price.
  t = kickoff + HOUR; await tick(0); await tick(30);
  assert.equal(calls.odds, 5);
  assert.ok(calls.events > 20, 'the free fixture list is what gets checked every hour');

  await svc.refreshOdds({ force: true });
  assert.equal(calls.odds, 6, 'the master can always refresh by hand');
});

test('if the fixture list ever costs credits, it is dropped for a fixed twice-a-day refresh', async () => {
  const db = open(':memory:');
  let t = Date.parse('2026-10-20T00:00:00Z');
  const { calls, fetchImpl } = oddsApi('2026-10-25T15:00:00Z', { eventsCost: 1 });
  const svc = createOddsService(db, { ...base, oddsFallbackHours: 12 }, { fetchImpl, now: () => t, log: { error() {} } });
  for (let h = 0; h < 48; h++) { await svc.refreshOdds(); t += HOUR; }
  assert.equal(calls.events, 1, 'checked once, then never again');
  assert.equal(calls.odds, 4, 'every 12 hours over two days');
});

test('football results are settled from football-data.org without spending odds credits', async () => {
  const db = open(':memory:');
  const kickoff = '2026-10-25T15:00:00Z';
  let t = Date.parse(kickoff) - 24 * HOUR;
  const { calls, fetchImpl } = oddsApi(kickoff);
  const svc = createOddsService(db, { ...base, footballDataKey: 'FD' }, { fetchImpl, now: () => t, log: { error() {} } });
  assert.equal(svc.resultsSource, 'football-data');
  await svc.refreshOdds();
  db.prepare("INSERT INTO users (id, username, password_hash, role, balance) VALUES (1, 'p', 'x', 'user', 0)").run();
  db.prepare('INSERT INTO bets (id, user_id, stake, total_odds) VALUES (1, 1, 1000, 2)').run();
  db.prepare("INSERT INTO bet_legs (bet_id, event_id, market, outcome, price) VALUES (1, 'ev1', 'h2h', 'home', 2)").run();

  t = Date.parse(kickoff) + 2.5 * HOUR;
  fdMatches = [{ homeTeam: { name: 'Arsenal FC' }, awayTeam: { name: 'Chelsea FC' }, utcDate: kickoff, status: 'FINISHED',
    score: { fullTime: { home: 2, away: 1 } } }];
  await svc.refreshScores();
  assert.equal(settleAll(db), 1);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = 1').get().balance, 2000);
  assert.equal(calls.scores, 0, 'no odds credits spent on results');
  assert.equal(calls.footballData, 1);
});
