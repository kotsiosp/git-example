'use strict';

// Cyprus horse racing: race cards, live tote prices, results and final dividends.
//
// A feed provider has two methods, both returning plain objects in this shape:
//
//   fetchCards() -> [{ id, meeting, raceNo, name, postTime (ISO), distance, placesPaid,
//                      runners: [{ number, horse, jockey, trainer, weight, draw, form,
//                                  winPrice, placePrice, withdrawn }] }]
//   fetchResults(raceIds) -> [{ id, abandoned,
//                      runners: [{ number, position, winDividend, placeDividend, withdrawn }] }]
//
// Prices and dividends are decimal returns per 1 credit staked, stake included.
// Only the demo provider exists so far; a Racing NRC provider plugs in with the same shape.

const { POOLS, comboKey, settleTickets } = require('./tote');

const round2 = (n) => Math.round(n * 100) / 100;

function seeded(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// Usual tote terms: no place pool for small fields, 2 places for 5-7 runners, 3 places for 8 or more.
function placesFor(fieldSize) {
  if (fieldSize < 5) return 0;
  return fieldSize < 8 ? 2 : 3;
}

// ---------------------------------------------------------------- demo provider

const HORSE_NAMES = ['Aphrodite Star', 'Troodos King', 'Kyrenia Bay', 'Golden Halloumi', 'Limassol Lady', 'Akamas Wind',
  'Paphos Prince', 'Blue Lagoon', 'Olympus Rise', 'Salt Lake Runner', 'Commandaria', 'Zeus Thunder', 'Orange Grove',
  'Cedar Valley', 'Ayia Napa Dream', 'Larnaca Light', 'Hermes Flight', 'Carob Queen', 'Fig Tree Lane', 'Meltemi',
  'Silver Kouros', 'Petra Tou Romiou', 'Lefkara Lace', 'Marathasa', 'Famagusta Gold', 'Pentadaktylos', 'Kantara',
  'Morning Zivania', 'Athena Bright', 'Nicosia Flyer', 'Agros Rose', 'Cape Greco'];
const JOCKEYS = ['A. Georgiou', 'C. Ioannou', 'M. Christodoulou', 'P. Charalambous', 'S. Constantinou', 'N. Demetriou',
  'K. Andreou', 'L. Michael', 'G. Savva', 'E. Panayiotou', 'R. Kyriakou', 'T. Nicolaou'];
const TRAINERS = ['Y. Hadjigeorgiou', 'M. Petrou', 'A. Antoniou', 'C. Pavlou', 'S. Stylianou', 'D. Loizou'];
const RACE_NAMES = ['Maiden Plate', 'Handicap', 'Class 4 Handicap', 'Class 3 Handicap', 'Arabian Handicap',
  'Sprint Handicap', 'Novice Stakes', 'Conditions Race'];
const DISTANCES = ['1100m', '1200m', '1400m', '1600m', '1800m', '2000m', '2200m'];

const SLOT_MS = 30 * 60 * 1000;
const TAKEOUT = 0.2; // share of each pool kept by the tote

function demoRace(postMs) {
  const rnd = seeded(`race:${postMs}`);
  const field = 6 + Math.floor(rnd() * 7);
  const names = [...HORSE_NAMES];
  const runners = [];
  for (let n = 1; n <= field; n++) {
    runners.push({
      number: n,
      horse: names.splice(Math.floor(rnd() * names.length), 1)[0],
      jockey: JOCKEYS[Math.floor(rnd() * JOCKEYS.length)],
      trainer: TRAINERS[Math.floor(rnd() * TRAINERS.length)],
      weight: `${52 + Math.floor(rnd() * 8)}kg`,
      draw: 1 + Math.floor(rnd() * field),
      form: Array.from({ length: 4 }, () => '1234567890'[Math.floor(rnd() * 10)]).join(''),
      strength: 0.3 + rnd() ** 2 * 3,
      withdrawn: false,
    });
  }
  // About one race in four has a late withdrawal.
  if (rnd() < 0.25) runners[Math.floor(rnd() * field)].withdrawn = true;
  return {
    id: `demo_race_${postMs}`,
    meeting: 'Nicosia',
    // Back-to-back 8-race meetings, a race every 30 minutes, so the demo always has something running.
    raceNo: (Math.floor(postMs / SLOT_MS) % 8) + 1,
    name: RACE_NAMES[Math.floor(rnd() * RACE_NAMES.length)],
    postTime: new Date(postMs).toISOString(),
    distance: DISTANCES[Math.floor(rnd() * DISTANCES.length)],
    placesPaid: placesFor(runners.filter((r) => !r.withdrawn).length),
    pools: ['EXACTA', 'QUINELLA', 'SWINGER', 'TRIFECTA', ...(runners.filter((r) => !r.withdrawn).length >= 6 ? ['SUPERFECTA'] : [])],
    runners,
  };
}

// Demo exotic dividends: the chance of each winning combination, worked out from the final win
// prices, less a 25% tote deduction.
function demoExoticDividends(race, prices, order) {
  const live = race.runners.filter((r) => !r.withdrawn).map((r) => r.number);
  const raw = Object.fromEntries(live.map((n) => [n, (1 - TAKEOUT) / prices[n].win]));
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  const p = Object.fromEntries(live.map((n) => [n, raw[n] / sum]));
  const inOrder = (ns) => ns.reduce((acc, n, i) => acc * p[n] / (1 - ns.slice(0, i).reduce((s, m) => s + p[m], 0)), 1);
  const pays = (prob) => Math.max(1.1, Math.round((0.75 / prob) * 10) / 10);
  const [a, b, c, d] = order;
  const pools = {
    EXACTA: { [comboKey('EXACTA', [a, b])]: pays(inOrder([a, b])) },
    QUINELLA: { [comboKey('QUINELLA', [a, b])]: pays(inOrder([a, b]) + inOrder([b, a])) },
    TRIFECTA: { [comboKey('TRIFECTA', [a, b, c])]: pays(inOrder([a, b, c])) },
    SWINGER: {},
  };
  // Omni: each pair from the first three, paid on the chance both finish in the top three.
  for (const [x, y] of [[a, b], [a, c], [b, c]]) {
    let prob = 0;
    for (const z of live.filter((n) => n !== x && n !== y)) {
      for (const ord of [[x, y, z], [x, z, y], [y, x, z], [y, z, x], [z, x, y], [z, y, x]]) prob += inOrder(ord);
    }
    pools.SWINGER[comboKey('SWINGER', [x, y])] = pays(prob);
  }
  if (race.pools.includes('SUPERFECTA') && d) pools.SUPERFECTA = { [comboKey('SUPERFECTA', [a, b, c, d])]: pays(inOrder([a, b, c, d])) };
  return pools;
}

// Pool shares drift every couple of minutes, so prices move like a real tote market until the off.
function demoPrices(race, atMs) {
  const t = Math.min(atMs, Date.parse(race.postTime));
  const bucket = Math.floor(t / (2 * 60 * 1000));
  const live = race.runners.filter((r) => !r.withdrawn);
  const weights = live.map((r) => {
    const rnd = seeded(`${race.id}:${r.number}:${bucket}`);
    return r.strength * Math.exp((rnd() - 0.5) * 0.3);
  });
  const total = weights.reduce((s, w) => s + w, 0);
  const prices = {};
  live.forEach((r, i) => {
    const p = weights[i] / total;
    const win = Math.max(1.1, round2((1 - TAKEOUT) / p));
    const place = race.placesPaid ? Math.max(1.05, round2(1 + (win - 1) / (race.placesPaid + 1))) : null;
    prices[r.number] = { win, place };
  });
  return prices;
}

function createDemoProvider({ now }) {
  const windowRaces = () => {
    const base = Math.floor(now() / SLOT_MS) * SLOT_MS;
    const races = [];
    for (let t = base - 4 * SLOT_MS; t <= base + 20 * SLOT_MS; t += SLOT_MS) races.push(demoRace(t));
    return races;
  };
  return {
    mode: 'demo',
    async fetchCards() {
      return windowRaces().map((race) => {
        const prices = demoPrices(race, now());
        return {
          ...race,
          runners: race.runners.map(({ strength, ...r }) => ({
            ...r, winPrice: prices[r.number]?.win ?? null, placePrice: prices[r.number]?.place ?? null,
          })),
        };
      });
    },
    // Results are published 8 minutes after the off. The order is drawn by strength; dividends are the off prices.
    async fetchResults(raceIds) {
      const out = [];
      for (const id of raceIds) {
        const postMs = Number(id.replace('demo_race_', ''));
        if (!Number.isFinite(postMs) || now() < postMs + 8 * 60 * 1000) continue;
        const race = demoRace(postMs);
        const prices = demoPrices(race, postMs);
        const rnd = seeded(`result:${id}`);
        const pool = race.runners.filter((r) => !r.withdrawn);
        const order = [];
        while (pool.length) {
          const total = pool.reduce((s, r) => s + r.strength, 0);
          let pick = rnd() * total;
          const i = pool.findIndex((r) => (pick -= r.strength) <= 0);
          order.push(pool.splice(i < 0 ? pool.length - 1 : i, 1)[0]);
        }
        out.push({
          id,
          abandoned: false,
          pools: demoExoticDividends(race, prices, order.map((r) => r.number)),
          runners: race.runners.map((r) => {
            const position = r.withdrawn ? null : order.indexOf(r) + 1;
            return {
              number: r.number,
              withdrawn: r.withdrawn,
              position,
              winDividend: position === 1 ? prices[r.number].win : null,
              placeDividend: position && position <= race.placesPaid ? prices[r.number].place : null,
            };
          }),
        });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- service

const raceLabel = (race) => `${race.meeting} race ${race.race_no}`;
const ORDINAL = ['', '1st', '2nd', '3rd', '4th'];

// A race's result in words and in full, for the master log.
function resultSummary(db, raceId) {
  const runners = db.prepare('SELECT * FROM runners WHERE race_id = ? ORDER BY finish_pos IS NULL, finish_pos, number').all(raceId);
  const dividends = db.prepare('SELECT pool, combo, dividend FROM race_dividends WHERE race_id = ?').all(raceId);
  const placed = runners.filter((u) => u.finish_pos && u.finish_pos <= 4);
  const pays = (u) => [u.win_dividend && `win ${u.win_dividend.toFixed(2)}`, u.place_dividend && `place ${u.place_dividend.toFixed(2)}`].filter(Boolean);
  const text = [
    placed.map((u) => `${ORDINAL[u.finish_pos]} ${u.number}. ${u.horse}${pays(u).length ? ` (${pays(u).join(', ')})` : ''}`).join(', '),
    ...dividends.map((d) => `${POOLS[d.pool]?.name || d.pool} ${d.combo} ${d.dividend.toFixed(2)}`),
    ...(runners.some((u) => u.withdrawn) ? [`withdrawn: ${runners.filter((u) => u.withdrawn).map((u) => u.number).join(', ')}`] : []),
  ].filter(Boolean).join('; ');
  return {
    text,
    details: {
      finishingOrder: placed.map((u) => u.number),
      runners: runners.map((u) => ({ number: u.number, horse: u.horse, position: u.finish_pos, withdrawn: !!u.withdrawn,
        winDividend: u.win_dividend, placeDividend: u.place_dividend })),
      dividends,
    },
  };
}

function createRacingService(db, config, { now = () => Date.now(), log = console, provider } = {}) {
  provider ||= createDemoProvider({ now });
  const feed = { name: provider.mode === 'nrc' ? 'Racing NRC feed' : 'demo feed' };
  const stamp = () => new Date(now()).toISOString();

  function storeCards(cards) {
    const nowIso = new Date(now()).toISOString();
    const upsertRace = db.prepare(`
      INSERT INTO races (id, meeting, race_no, name, post_time, distance, places_paid, prices_updated_at, pools)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET meeting = excluded.meeting, race_no = excluded.race_no, name = excluded.name,
        post_time = excluded.post_time, distance = excluded.distance, places_paid = excluded.places_paid,
        prices_updated_at = excluded.prices_updated_at, pools = excluded.pools
      WHERE races.status = 'open'`);
    // Prices freeze at the off; a withdrawal (from the feed or the master) is never undone by the feed.
    const upsertRunner = db.prepare(`
      INSERT INTO runners (race_id, number, horse, jockey, trainer, weight, draw, form, win_price, place_price, withdrawn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(race_id, number) DO UPDATE SET horse = excluded.horse, jockey = excluded.jockey,
        trainer = excluded.trainer, weight = excluded.weight, draw = excluded.draw, form = excluded.form,
        win_price = excluded.win_price, place_price = excluded.place_price,
        withdrawn = MAX(runners.withdrawn, excluded.withdrawn)
      WHERE (SELECT status FROM races WHERE id = runners.race_id) = 'open'
        AND (SELECT post_time FROM races WHERE id = runners.race_id) > ?`);
    const before = db.prepare('SELECT withdrawn, horse FROM runners WHERE race_id = ? AND number = ?');
    db.tx(() => {
      for (const c of cards) {
        upsertRace.run(c.id, c.meeting, c.raceNo, c.name ?? null, c.postTime, c.distance ?? null, c.placesPaid ?? 3, nowIso,
          JSON.stringify((c.pools || []).filter((pool) => POOLS[pool])));
        for (const r of c.runners) {
          const was = before.get(c.id, r.number);
          if (was && !was.withdrawn && r.withdrawn && Date.parse(c.postTime) > now()) {
            db.log({ action: 'runner_withdrawn', actor: feed, at: stamp(),
              summary: `${feed.name} reported ${r.number}. ${was.horse} withdrawn from ${c.meeting} race ${c.raceNo}`,
              details: { raceId: c.id, runnerNo: r.number, horse: was.horse } });
          }
          upsertRunner.run(c.id, r.number, r.horse, r.jockey ?? null, r.trainer ?? null, r.weight ?? null,
            r.draw ?? null, r.form ?? null, r.withdrawn ? null : r.winPrice ?? null,
            r.withdrawn ? null : r.placePrice ?? null, r.withdrawn ? 1 : 0, nowIso);
        }
      }
    });
  }

  function storeResults(results) {
    db.tx(() => {
      for (const res of results) {
        const race = db.prepare("SELECT id FROM races WHERE id = ? AND status = 'open'").get(res.id);
        if (!race) continue;
        const label = raceLabel(db.prepare('SELECT * FROM races WHERE id = ?').get(res.id));
        if (res.abandoned) {
          db.prepare("UPDATE races SET status = 'abandoned' WHERE id = ?").run(res.id);
          db.log({ action: 'race_abandoned', actor: feed, at: stamp(), summary: `${feed.name} reported ${label} cancelled; all bets on it are refunded`,
            details: { raceId: res.id } });
          continue;
        }
        recordResult(db, res.id, res.runners, res.pools);
        const r = resultSummary(db, res.id);
        db.log({ action: 'result_received', actor: feed, at: stamp(), summary: `${feed.name} result for ${label}: ${r.text}`,
          details: { raceId: res.id, ...r.details } });
      }
    });
  }

  async function refresh() {
    let error = null;
    try {
      storeCards(await provider.fetchCards());
      const due = db.prepare("SELECT id FROM races WHERE status = 'open' AND post_time <= ?")
        .all(new Date(now()).toISOString()).map((r) => r.id);
      if (due.length) storeResults(await provider.fetchResults(due));
    } catch (err) {
      error = err.message;
      log.error(`[racing] ${err.message}`);
    }
    db.setMeta('racing_refreshed_at', new Date(now()).toISOString());
    db.setMeta('racing_last_error', error);
    return { error };
  }

  return { mode: provider.mode, refresh };
}

// Writes a race result. Runners missing from `runners` are treated as unplaced. `pools` holds the
// exotic dividends, e.g. { EXACTA: { '6-9': 50.9 } }; a pool left out refunds its bets.
function recordResult(db, raceId, runners, pools = {}) {
  db.prepare('UPDATE runners SET finish_pos = NULL, win_dividend = NULL, place_dividend = NULL WHERE race_id = ?').run(raceId);
  const set = db.prepare(`UPDATE runners SET finish_pos = ?, win_dividend = ?, place_dividend = ?,
                            withdrawn = MAX(withdrawn, ?) WHERE race_id = ? AND number = ?`);
  for (const r of runners) {
    set.run(r.position ?? null, r.winDividend ?? null, r.placeDividend ?? null, r.withdrawn ? 1 : 0, raceId, r.number);
  }
  db.prepare('DELETE FROM race_dividends WHERE race_id = ?').run(raceId);
  db.prepare('DELETE FROM race_pool_results WHERE race_id = ?').run(raceId);
  for (const [pool, combos] of Object.entries(pools || {})) {
    if (!POOLS[pool] || !combos) continue;
    db.prepare('INSERT INTO race_pool_results (race_id, pool) VALUES (?, ?)').run(raceId, pool);
    for (const [combo, dividend] of Object.entries(combos)) {
      if (dividend > 0) {
        db.prepare('INSERT OR REPLACE INTO race_dividends (race_id, pool, combo, dividend) VALUES (?, ?, ?, ?)').run(raceId, pool, combo, dividend);
      }
    }
  }
  db.prepare("UPDATE races SET status = 'result' WHERE id = ?").run(raceId);
}

// Settles horse bets: withdrawn runners and abandoned races are refunded, the rest pay the final dividend.
// Also settles exotic bets and parlays.
function settleHorseBets(db) {
  let settled = 0;
  db.tx(() => {
    const bets = db.prepare(`
      SELECT b.*, r.status AS race_status, r.meeting, r.race_no, u.horse, u.finish_pos, u.withdrawn, u.win_dividend, u.place_dividend,
        us.username
      FROM horse_bets b JOIN races r ON r.id = b.race_id JOIN users us ON us.id = b.user_id
      JOIN runners u ON u.race_id = b.race_id AND u.number = b.runner_no
      WHERE b.status = 'open' AND (r.status != 'open' OR u.withdrawn = 1)`).all();
    for (const b of bets) {
      let status;
      let dividend = null;
      if (b.race_status === 'abandoned' || b.withdrawn) {
        status = 'void';
      } else {
        dividend = b.bet_type === 'win' ? b.win_dividend : b.place_dividend;
        status = dividend ? 'won' : 'lost';
      }
      const payout = status === 'void' ? b.stake : status === 'won' ? Math.round(b.stake * dividend) : 0;
      db.prepare("UPDATE horse_bets SET status = ?, dividend = ?, payout = ?, settled_at = datetime('now') WHERE id = ?")
        .run(status, dividend, payout, b.id);
      if (payout > 0) {
        db.adjustBalance({ userId: b.user_id, amount: payout, type: status === 'void' ? 'refund' : 'payout', horseBetId: b.id });
      }
      const outcome = status === 'void' ? `refunded ${(payout / 100).toFixed(2)} (${b.race_status === 'abandoned' ? 'race abandoned' : 'horse withdrawn'})`
        : status === 'won' ? `won at ${dividend.toFixed(2)}, paid ${(payout / 100).toFixed(2)}` : `lost${b.finish_pos ? `, finished ${b.finish_pos}` : ''}`;
      db.log({ action: 'bet_settled', userId: b.user_id,
        summary: `Bet #H${b.id} (${b.username}): ${b.bet_type === 'win' ? 'Win' : 'Place'} ${(b.stake / 100).toFixed(2)} on ${b.runner_no}. ${b.horse}, `
          + `${raceLabel(b)}: ${outcome}`,
        details: { betId: `H${b.id}`, status, dividend, payout: payout / 100, position: b.finish_pos } });
      settled++;
    }
  });
  return settled + settleTickets(db);
}

module.exports = { createRacingService, createDemoProvider, settleHorseBets, recordResult, placesFor, raceLabel, resultSummary };
