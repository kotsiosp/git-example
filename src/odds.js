'use strict';

// Pulls fixtures, odds and results from The Odds API (https://the-odds-api.com),
// or generates realistic demo fixtures when no API key is configured.
// Results come from football-data.org instead when a key for it is set (free, saves odds credits).

const { createFootballDataClient, findMatch, finalScore } = require('./footballData');

const TOTALS_LINE = 2.5;

const LEAGUE_TITLES = {
  soccer_epl: 'Premier League',
  soccer_spain_la_liga: 'La Liga',
  soccer_italy_serie_a: 'Serie A',
  soccer_germany_bundesliga: 'Bundesliga',
  soccer_france_ligue_one: 'Ligue 1',
  soccer_uefa_champs_league: 'Champions League',
  soccer_uefa_europa_league: 'Europa League',
  soccer_efl_champ: 'Championship',
  soccer_netherlands_eredivisie: 'Eredivisie',
  soccer_portugal_primeira_liga: 'Primeira Liga',
  soccer_greece_super_league: 'Super League Greece',
};

const round2 = (n) => Math.round(n * 100) / 100;

// Collapses the bookmakers of one API event into a single price per outcome.
function consensusOdds(apiEvent, preferredBookmaker) {
  let books = apiEvent.bookmakers || [];
  if (preferredBookmaker) {
    const preferred = books.filter((b) => b.key === preferredBookmaker);
    if (preferred.length) books = preferred;
  }
  const buckets = {};
  const add = (market, outcome, price, point = null) => {
    const key = `${market}|${outcome}`;
    (buckets[key] ||= { market, outcome, point, prices: [] }).prices.push(price);
  };
  for (const book of books) {
    for (const m of book.markets || []) {
      if (m.key === 'h2h') {
        for (const o of m.outcomes) {
          const outcome = o.name === apiEvent.home_team ? 'home'
            : o.name === apiEvent.away_team ? 'away'
              : o.name === 'Draw' ? 'draw' : null;
          if (outcome && o.price > 1) add('h2h', outcome, o.price);
        }
      } else if (m.key === 'totals') {
        for (const o of m.outcomes) {
          if (o.point === TOTALS_LINE && o.price > 1) add('totals', o.name.toLowerCase(), o.price, o.point);
        }
      }
    }
  }
  return Object.values(buckets)
    .filter((b) => ['home', 'draw', 'away', 'over', 'under'].includes(b.outcome))
    .map((b) => ({
      market: b.market,
      outcome: b.outcome,
      point: b.point,
      price: round2(b.prices.reduce((s, p) => s + p, 0) / b.prices.length),
    }));
}

function storeEvent(db, ev, odds) {
  db.prepare(`INSERT INTO events (id, sport_key, sport_title, home_team, away_team, commence_time, odds_updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET commence_time = excluded.commence_time,
                odds_updated_at = excluded.odds_updated_at`)
    .run(ev.id, ev.sport_key, ev.sport_title, ev.home_team, ev.away_team, ev.commence_time, new Date().toISOString());
  const h2hComplete = ['home', 'draw', 'away'].every((o) => odds.some((x) => x.market === 'h2h' && x.outcome === o));
  const totalsComplete = ['over', 'under'].every((o) => odds.some((x) => x.market === 'totals' && x.outcome === o));
  const upsert = db.prepare(`INSERT INTO odds (event_id, market, outcome, point, price) VALUES (?, ?, ?, ?, ?)
                             ON CONFLICT(event_id, market, outcome) DO UPDATE SET point = excluded.point, price = excluded.price`);
  for (const [market, complete] of [['h2h', h2hComplete], ['totals', totalsComplete]]) {
    // A market missing an outcome is pulled rather than shown half-priced.
    if (!complete) {
      db.prepare('DELETE FROM odds WHERE event_id = ? AND market = ?').run(ev.id, market);
      continue;
    }
    for (const o of odds.filter((x) => x.market === market)) upsert.run(ev.id, o.market, o.outcome, o.point, o.price);
  }
}

function recordResult(db, id, homeScore, awayScore) {
  db.prepare('UPDATE events SET completed = 1, home_score = ?, away_score = ? WHERE id = ? AND completed = 0 AND voided = 0')
    .run(homeScore, awayScore, id);
}

// ---------------------------------------------------------------- live provider

function createLiveProvider(config, fetchImpl = fetch) {
  async function get(path, params) {
    const url = new URL(config.oddsApiBase + path);
    url.searchParams.set('apiKey', config.oddsApiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url);
    const remaining = res.headers.get('x-requests-remaining');
    // What this request cost, in credits.
    const cost = res.headers.get('x-requests-last');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Odds API ${path} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return { data: await res.json(), remaining, cost: cost == null ? null : Number(cost) };
  }

  return {
    mode: 'live',
    async fetchOdds(sportKey) {
      return get(`/sports/${sportKey}/odds`, {
        regions: config.oddsRegions,
        markets: config.oddsMarkets,
        oddsFormat: 'decimal',
        dateFormat: 'iso',
      });
    },
    // The fixture list, without prices. It is free on The Odds API, which the service double-checks.
    async fetchEvents(sportKey) {
      return get(`/sports/${sportKey}/events`, { dateFormat: 'iso' });
    },
    async fetchScores(sportKey) {
      return get(`/sports/${sportKey}/scores`, { daysFrom: 3, dateFormat: 'iso' });
    },
  };
}

// ---------------------------------------------------------------- demo provider

const DEMO_TEAMS = {
  soccer_epl: ['Arsenal', 'Chelsea', 'Liverpool', 'Manchester City', 'Manchester United', 'Tottenham Hotspur',
    'Newcastle United', 'Aston Villa', 'Brighton and Hove Albion', 'West Ham United'],
  soccer_spain_la_liga: ['Real Madrid', 'Barcelona', 'Atlético Madrid', 'Sevilla', 'Real Sociedad', 'Villarreal',
    'Real Betis', 'Athletic Bilbao'],
  soccer_italy_serie_a: ['Inter Milan', 'AC Milan', 'Juventus', 'Napoli', 'AS Roma', 'Lazio', 'Atalanta BC', 'Fiorentina'],
  soccer_germany_bundesliga: ['Bayern Munich', 'Borussia Dortmund', 'RB Leipzig', 'Bayer Leverkusen',
    'Eintracht Frankfurt', 'VfB Stuttgart'],
  soccer_france_ligue_one: ['Paris Saint Germain', 'Marseille', 'Lyon', 'Monaco', 'Lille', 'Nice', 'Lens', 'Rennes'],
  soccer_uefa_champs_league: ['Real Madrid', 'Manchester City', 'Bayern Munich', 'Inter Milan', 'Paris Saint Germain',
    'Arsenal', 'Barcelona', 'Liverpool', 'Benfica', 'Porto'],
  soccer_greece_super_league: ['Olympiacos', 'Panathinaikos', 'AEK Athens', 'PAOK', 'Aris', 'Asteras Tripolis'],
};

// Deterministic pseudo-random so a demo fixture keeps the same teams/odds across restarts.
function seeded(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function demoFixtures(sportKey, now = Date.now()) {
  const teams = DEMO_TEAMS[sportKey] || DEMO_TEAMS.soccer_epl;
  const slot = 3 * 3600 * 1000;
  const base = Math.floor(now / slot) * slot;
  const fixtures = [];
  // Fixtures every 3 hours from 9 hours ago to 4 days ahead, so some are always finished, live and upcoming.
  for (let t = base - 3 * slot; t < base + 32 * slot; t += slot) {
    const rnd = seeded(`${sportKey}:${t}`);
    const pool = [...teams];
    const home = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    const away = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    const strength = rnd() * 1.6 - 0.8; // >0 favours home
    const pHome = Math.min(0.8, Math.max(0.12, 0.45 + strength * 0.4));
    const pDraw = Math.max(0.15, 0.28 - Math.abs(strength) * 0.12);
    const pAway = 1 - pHome - pDraw;
    const pOver = 0.42 + rnd() * 0.2;
    const margin = 1.06;
    const price = (p) => round2(Math.max(1.01, 1 / (p * margin)));
    const id = `demo_${sportKey}_${t}`;
    fixtures.push({
      id,
      sport_key: sportKey,
      sport_title: LEAGUE_TITLES[sportKey] || sportKey,
      home_team: home,
      away_team: away,
      commence_time: new Date(t).toISOString(),
      odds: [
        { market: 'h2h', outcome: 'home', point: null, price: price(pHome) },
        { market: 'h2h', outcome: 'draw', point: null, price: price(pDraw) },
        { market: 'h2h', outcome: 'away', point: null, price: price(pAway) },
        { market: 'totals', outcome: 'over', point: TOTALS_LINE, price: price(pOver) },
        { market: 'totals', outcome: 'under', point: TOTALS_LINE, price: price(1 - pOver) },
      ],
      // Simulated full-time score, revealed two hours after kick-off.
      score: [Math.floor(rnd() * (2 + strength * 2 + 1.5)), Math.floor(rnd() * (2 - strength * 2 + 1.5))]
        .map((g) => Math.max(0, Math.min(g, 6))),
    });
  }
  return fixtures;
}

// ---------------------------------------------------------------- sync

function createOddsService(db, config, { fetchImpl, now = () => Date.now(), log = console } = {}) {
  const provider = config.oddsApiKey ? createLiveProvider(config, fetchImpl) : null;
  const results = config.footballDataKey ? createFootballDataClient(config, fetchImpl) : null;
  const mode = provider ? 'live' : 'demo';
  const HOUR = 3600 * 1000;

  // How old a league's prices may get, given its next kick-off: fresher as the match nears,
  // and no spending at all on a league with nothing in the next week.
  function maxAgeFor(nextKickoff) {
    const until = nextKickoff - now();
    if (until <= 3 * HOUR) return 3 * HOUR;
    if (until <= 24 * HOUR) return 12 * HOUR;
    if (until <= 3 * 24 * HOUR) return 24 * HOUR;
    if (until <= 7 * 24 * HOUR) return 48 * HOUR;
    return null;
  }

  // Decides whether this league's prices are worth spending credits on right now.
  async function oddsDue(sportKey, force) {
    if (force) return true;
    let nextKickoff = null;
    let maxAge = config.oddsFallbackHours * HOUR;
    if (db.getMeta('odds_events_cost_credits') !== 'true') {
      const { data, remaining, cost } = await provider.fetchEvents(sportKey);
      if (remaining != null) db.setMeta('odds_api_remaining', remaining);
      if (cost > 0) {
        // The fixture list is not free after all: stop using it and refresh on a fixed timer instead.
        db.setMeta('odds_events_cost_credits', 'true');
        log.error(`[odds] the fixture list cost ${cost} credit(s); switching to a refresh every ${config.oddsFallbackHours}h`);
      } else {
        const upcoming = data.map((e) => Date.parse(e.commence_time)).filter((t) => t > now());
        nextKickoff = upcoming.length ? Math.min(...upcoming) : null;
        maxAge = nextKickoff ? maxAgeFor(nextKickoff) : null;
      }
    }
    if (maxAge == null) return false;
    const last = db.getMeta(`odds_refreshed_at:${sportKey}`);
    if (last && now() - Date.parse(last) < maxAge) return false;
    // Keep a small reserve of credits for the last refresh before kick-off.
    const remaining = db.getMeta('odds_api_remaining');
    const soon = nextKickoff && nextKickoff - now() <= 3 * HOUR;
    if (remaining != null && Number(remaining) < config.oddsReserveCredits && !soon) return false;
    return true;
  }

  async function refreshOdds({ force = false } = {}) {
    const errors = [];
    for (const sportKey of config.leagues) {
      try {
        if (provider) {
          if (!await oddsDue(sportKey, force)) continue;
          const { data, remaining } = await provider.fetchOdds(sportKey);
          if (remaining != null) db.setMeta('odds_api_remaining', remaining);
          db.setMeta(`odds_refreshed_at:${sportKey}`, new Date(now()).toISOString());
          db.tx(() => {
            for (const ev of data) {
              storeEvent(db, { ...ev, sport_title: LEAGUE_TITLES[ev.sport_key] || ev.sport_title },
                consensusOdds(ev, config.oddsBookmaker));
            }
          });
        } else {
          db.tx(() => {
            for (const fx of demoFixtures(sportKey, now())) {
              // Demo: prices are frozen once the match starts, just like a pre-match market.
              if (Date.parse(fx.commence_time) > now()) storeEvent(db, fx, fx.odds);
              else storeEvent(db, fx, []);
            }
          });
        }
      } catch (err) {
        errors.push(`${sportKey}: ${err.message}`);
        log.error(`[odds] ${sportKey}: ${err.message}`);
      }
    }
    db.setMeta('odds_refreshed_at', new Date(now()).toISOString());
    db.setMeta('odds_last_error', errors.join('\n') || null);
    return { errors };
  }

  // Only asks for results in leagues that have bets waiting to be settled, to save API credits.
  async function refreshScores() {
    const leagues = db.prepare(`
      SELECT DISTINCT e.sport_key FROM bet_legs l JOIN events e ON e.id = l.event_id
      WHERE l.result = 'pending' AND e.completed = 0 AND e.voided = 0 AND e.commence_time <= ?`)
      .all(new Date(now()).toISOString()).map((r) => r.sport_key);
    for (const sportKey of leagues) {
      try {
        if (results?.covers(sportKey)) {
          await settleFromFootballData(sportKey);
        } else if (provider && !config.oddsApiScores) {
          // No free results source for this league: the master enters the score on the Settlement page.
          continue;
        } else if (provider) {
          const { data, remaining } = await provider.fetchScores(sportKey);
          if (remaining != null) db.setMeta('odds_api_remaining', remaining);
          db.tx(() => {
            for (const s of data) {
              if (!s.completed || !s.scores) continue;
              const home = s.scores.find((x) => x.name === s.home_team);
              const away = s.scores.find((x) => x.name === s.away_team);
              if (home && away) recordResult(db, s.id, Number(home.score), Number(away.score));
            }
          });
        } else {
          const finishedBy = now() - 2 * 3600 * 1000;
          db.tx(() => {
            for (const fx of demoFixtures(sportKey, now())) {
              if (Date.parse(fx.commence_time) <= finishedBy) recordResult(db, fx.id, fx.score[0], fx.score[1]);
            }
          });
          // Fixtures that fell outside the generated window: regenerate them from their own kick-off time.
          const stale = db.prepare(`SELECT id, commence_time FROM events WHERE sport_key = ? AND completed = 0
                                    AND voided = 0 AND id LIKE 'demo_%' AND commence_time <= ?`)
            .all(sportKey, new Date(finishedBy).toISOString());
          db.tx(() => {
            for (const ev of stale) {
              const fx = demoFixtures(sportKey, Date.parse(ev.commence_time)).find((f) => f.id === ev.id);
              if (fx) recordResult(db, fx.id, fx.score[0], fx.score[1]);
            }
          });
        }
      } catch (err) {
        log.error(`[scores] ${sportKey}: ${err.message}`);
      }
    }
    db.setMeta('scores_refreshed_at', new Date(now()).toISOString());
  }

  // Results from football-data.org, matched to our events by kick-off time and club names.
  // A match it can't pair up stays on the master's Settlement page.
  async function settleFromFootballData(sportKey) {
    const pending = db.prepare(`
      SELECT DISTINCT e.* FROM events e JOIN bet_legs l ON l.event_id = e.id
      WHERE e.sport_key = ? AND l.result = 'pending' AND e.completed = 0 AND e.voided = 0 AND e.commence_time <= ?`)
      .all(sportKey, new Date(now()).toISOString());
    if (!pending.length) return;
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    // The free plan allows a window of about ten days; older matches are left to the master.
    const earliest = Math.max(Math.min(...pending.map((e) => Date.parse(e.commence_time))), now() - 9 * 24 * HOUR);
    const matches = await results.matches(sportKey, day(earliest - 24 * HOUR), day(now()));
    db.tx(() => {
      for (const ev of pending) {
        const m = findMatch(ev, matches);
        const score = m && finalScore(m);
        if (score) recordResult(db, ev.id, score[0], score[1]);
      }
    });
  }

  const resultsSource = results ? 'football-data' : !provider ? 'demo' : config.oddsApiScores ? 'odds-api' : 'manual';
  return { mode, resultsSource, refreshOdds, refreshScores };
}

module.exports = { createOddsService, consensusOdds, demoFixtures, LEAGUE_TITLES, TOTALS_LINE };
