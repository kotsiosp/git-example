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
    runners,
  };
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

function createRacingService(db, config, { now = () => Date.now(), log = console, provider } = {}) {
  provider ||= createDemoProvider({ now });

  function storeCards(cards) {
    const nowIso = new Date(now()).toISOString();
    const upsertRace = db.prepare(`
      INSERT INTO races (id, meeting, race_no, name, post_time, distance, places_paid, prices_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET meeting = excluded.meeting, race_no = excluded.race_no, name = excluded.name,
        post_time = excluded.post_time, distance = excluded.distance, places_paid = excluded.places_paid,
        prices_updated_at = excluded.prices_updated_at
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
    db.tx(() => {
      for (const c of cards) {
        upsertRace.run(c.id, c.meeting, c.raceNo, c.name ?? null, c.postTime, c.distance ?? null, c.placesPaid ?? 3, nowIso);
        for (const r of c.runners) {
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
        if (res.abandoned) {
          db.prepare("UPDATE races SET status = 'abandoned' WHERE id = ?").run(res.id);
          continue;
        }
        recordResult(db, res.id, res.runners);
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

// Writes a race result. Runners missing from `runners` are treated as unplaced.
function recordResult(db, raceId, runners) {
  db.prepare('UPDATE runners SET finish_pos = NULL, win_dividend = NULL, place_dividend = NULL WHERE race_id = ?').run(raceId);
  const set = db.prepare(`UPDATE runners SET finish_pos = ?, win_dividend = ?, place_dividend = ?,
                            withdrawn = MAX(withdrawn, ?) WHERE race_id = ? AND number = ?`);
  for (const r of runners) {
    set.run(r.position ?? null, r.winDividend ?? null, r.placeDividend ?? null, r.withdrawn ? 1 : 0, raceId, r.number);
  }
  db.prepare("UPDATE races SET status = 'result' WHERE id = ?").run(raceId);
}

// Settles horse bets: withdrawn runners and abandoned races are refunded, the rest pay the final dividend.
function settleHorseBets(db) {
  let settled = 0;
  db.tx(() => {
    const bets = db.prepare(`
      SELECT b.*, r.status AS race_status, u.withdrawn, u.win_dividend, u.place_dividend
      FROM horse_bets b JOIN races r ON r.id = b.race_id
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
      settled++;
    }
  });
  return settled;
}

module.exports = { createRacingService, createDemoProvider, settleHorseBets, recordResult, placesFor };
