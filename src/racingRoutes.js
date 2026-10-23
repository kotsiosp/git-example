'use strict';

const express = require('express');
const { HttpError, toCents, fromCents, requireUser, requireAdmin } = require('./util');
const { settleHorseBets, recordResult } = require('./racing');
const { POOLS, BetError, expand, comboKey } = require('./tote');

function racingRoutes({ db, config, now = () => Date.now() }) {
  const router = express.Router();
  const nowIso = () => new Date(now()).toISOString();

  function racesWithRunners(rows, { openBets = false } = {}) {
    const runnerStmt = db.prepare('SELECT * FROM runners WHERE race_id = ? ORDER BY number');
    const betCount = db.prepare(`SELECT
        (SELECT COUNT(*) FROM horse_bets WHERE race_id = ?1 AND status = 'open')
      + (SELECT COUNT(*) FROM horse_tickets WHERE race_id = ?1 AND status = 'open')
      + (SELECT COUNT(*) FROM horse_parlay_legs l JOIN horse_tickets t ON t.id = l.ticket_id
         WHERE l.race_id = ?1 AND t.status = 'open') AS n`);
    const dividendStmt = db.prepare('SELECT pool, combo, dividend FROM race_dividends WHERE race_id = ? ORDER BY pool, dividend');
    return rows.map((r) => ({
      id: r.id,
      meeting: r.meeting,
      raceNo: r.race_no,
      name: r.name,
      postTime: r.post_time,
      distance: r.distance,
      placesPaid: r.places_paid,
      status: r.status,
      pricesUpdatedAt: r.prices_updated_at,
      pools: JSON.parse(r.pools || '[]').filter((p) => POOLS[p]),
      ...(r.status === 'result' && { dividends: dividendStmt.all(r.id) }),
      ...(openBets && { openBets: betCount.get(r.id).n }),
      runners: runnerStmt.all(r.id).map((u) => ({
        number: u.number,
        horse: u.horse,
        jockey: u.jockey,
        trainer: u.trainer,
        weight: u.weight,
        draw: u.draw,
        form: u.form,
        withdrawn: !!u.withdrawn,
        winPrice: u.withdrawn ? null : u.win_price,
        placePrice: u.withdrawn || !r.places_paid ? null : u.place_price,
        position: u.finish_pos,
        winDividend: u.win_dividend,
        placeDividend: u.place_dividend,
      })),
    }));
  }

  router.get('/races', requireUser, (req, res) => {
    const until = new Date(now() + 2 * 86400 * 1000).toISOString();
    const rows = db.prepare(`SELECT * FROM races WHERE status = 'open' AND post_time > ? AND post_time < ?
                             ORDER BY post_time LIMIT 60`).all(nowIso(), until);
    res.json({ races: racesWithRunners(rows), refreshedAt: db.getMeta('racing_refreshed_at') });
  });

  router.get('/races/results', requireUser, (req, res) => {
    const since = new Date(now() - 3 * 86400 * 1000).toISOString();
    const rows = db.prepare(`SELECT * FROM races WHERE status != 'open' AND post_time > ?
                             ORDER BY post_time DESC LIMIT 60`).all(since);
    res.json({ races: racesWithRunners(rows) });
  });

  // Tote bets: the price shown is only a guide, winners are paid the official final dividend.
  router.post('/horse-bets', requireUser, (req, res) => {
    if (req.user.role !== 'user') throw new HttpError(403, 'The master account cannot place bets');
    const { raceId, runnerNo, betType, stake } = req.body || {};
    const types = { win: ['win'], place: ['place'], each_way: ['win', 'place'] }[betType];
    if (!types) throw new HttpError(400, 'Choose win, place or each way');
    const stakeCents = toCents(stake, 'Stake');
    if (stakeCents < config.minStake * 100 || stakeCents > config.maxStake * 100) {
      throw new HttpError(400, `Stake must be between ${config.minStake} and ${config.maxStake}`);
    }
    const race = db.prepare('SELECT * FROM races WHERE id = ?').get(String(raceId));
    if (!race || race.status !== 'open' || race.post_time <= nowIso()) throw new HttpError(400, 'Betting on this race has closed');
    const runner = db.prepare('SELECT * FROM runners WHERE race_id = ? AND number = ?').get(race.id, Number(runnerNo));
    if (!runner) throw new HttpError(400, 'Runner not found');
    if (runner.withdrawn) throw new HttpError(400, `${runner.horse} has been withdrawn`);
    if (types.includes('place') && !race.places_paid) throw new HttpError(400, 'There is no place betting on this race');

    const ids = db.tx(() => types.map((type) => {
      const price = type === 'win' ? runner.win_price : runner.place_price;
      const { lastInsertRowid } = db.prepare(`INSERT INTO horse_bets (user_id, race_id, runner_no, bet_type, stake, price_at_bet)
                                              VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, race.id, runner.number, type, stakeCents, price);
      db.adjustBalance({ userId: req.user.id, amount: -stakeCents, type: 'bet', horseBetId: Number(lastInsertRowid) });
      return Number(lastInsertRowid);
    }));
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id).balance;
    res.status(201).json({ betIds: ids, balance: fromCents(balance) });
  });

  function horseBets(where, params, limit = 200) {
    return db.prepare(`
      SELECT b.*, us.username, r.meeting, r.race_no, r.name AS race_name, r.post_time, r.places_paid, r.status AS race_status,
        u.horse, u.jockey, u.finish_pos, u.withdrawn
      FROM horse_bets b JOIN users us ON us.id = b.user_id JOIN races r ON r.id = b.race_id
      JOIN runners u ON u.race_id = b.race_id AND u.number = b.runner_no
      WHERE ${where} ORDER BY b.id DESC LIMIT ${limit}`).all(...params).map((b) => ({
      id: b.id,
      username: b.username,
      raceId: b.race_id,
      meeting: b.meeting,
      raceNo: b.race_no,
      raceName: b.race_name,
      postTime: b.post_time,
      placesPaid: b.places_paid,
      raceStatus: b.race_status,
      runnerNo: b.runner_no,
      horse: b.horse,
      jockey: b.jockey,
      position: b.finish_pos,
      withdrawn: !!b.withdrawn,
      betType: b.bet_type,
      stake: fromCents(b.stake),
      priceAtBet: b.price_at_bet,
      status: b.status,
      dividend: b.dividend,
      payout: fromCents(b.payout),
      placedAt: b.placed_at,
      settledAt: b.settled_at,
    }));
  }

  router.get('/horse-bets', requireUser, (req, res) => res.json({ bets: horseBets('b.user_id = ?', [req.user.id]) }));

  // ------------------------------------------------------------ exotic bets and parlays

  const openRaceForBetting = (raceId) => {
    const race = db.prepare('SELECT * FROM races WHERE id = ?').get(String(raceId));
    if (!race || race.status !== 'open' || race.post_time <= nowIso()) throw new HttpError(400, 'Betting on this race has closed');
    return race;
  };
  const checkStake = (cents) => {
    if (cents < config.minStake * 100 || cents > config.maxStake * 100) {
      throw new HttpError(400, `Total stake must be between ${config.minStake} and ${config.maxStake}`);
    }
  };

  function placeExotic(user, { raceId, pool, mode, selections, unitStake }) {
    const race = openRaceForBetting(raceId);
    if (!POOLS[pool]) throw new HttpError(400, 'Unknown bet type');
    if (!JSON.parse(race.pools || '[]').includes(pool)) throw new HttpError(400, `${POOLS[pool].name} is not offered on this race`);
    let combos;
    try {
      combos = expand(pool, mode, selections);
    } catch (err) {
      if (err instanceof BetError) throw new HttpError(400, err.message);
      throw err;
    }
    const runners = new Map(db.prepare('SELECT number, horse, withdrawn FROM runners WHERE race_id = ?').all(race.id).map((r) => [r.number, r]));
    for (const n of new Set(combos.flatMap((c) => c.split('-').map(Number)))) {
      if (!runners.has(n)) throw new HttpError(400, `There is no horse number ${n} in this race`);
      if (runners.get(n).withdrawn) throw new HttpError(400, `${runners.get(n).horse} has been withdrawn`);
    }
    const unit = toCents(unitStake, 'Stake');
    if (unit < 100) throw new HttpError(400, 'The stake per combination must be at least 1');
    checkStake(unit * combos.length);
    return db.tx(() => {
      const { lastInsertRowid } = db.prepare(`INSERT INTO horse_tickets (user_id, kind, race_id, pool, mode, selections, unit_stake, lines, stake)
        VALUES (?, 'exotic', ?, ?, ?, ?, ?, ?, ?)`).run(user.id, race.id, pool, mode, JSON.stringify(selections), unit, combos.length, unit * combos.length);
      const id = Number(lastInsertRowid);
      const line = db.prepare('INSERT INTO horse_ticket_lines (ticket_id, combo) VALUES (?, ?)');
      for (const c of combos) line.run(id, c);
      db.adjustBalance({ userId: user.id, amount: -unit * combos.length, type: 'bet', horseTicketId: id });
      return id;
    });
  }

  function placeParlay(user, { legs, stake }) {
    if (!Array.isArray(legs) || legs.length < 2) throw new HttpError(400, 'A parlay needs horses in at least 2 races');
    if (legs.length > config.maxLegs) throw new HttpError(400, `At most ${config.maxLegs} races in a parlay`);
    if (new Set(legs.map((l) => String(l?.raceId))).size !== legs.length) throw new HttpError(400, 'Pick one horse per race in a parlay');
    const clean = legs.map((l) => {
      const race = openRaceForBetting(l.raceId);
      const runner = db.prepare('SELECT * FROM runners WHERE race_id = ? AND number = ?').get(race.id, Number(l.runnerNo));
      if (!runner) throw new HttpError(400, 'Runner not found');
      if (runner.withdrawn) throw new HttpError(400, `${runner.horse} has been withdrawn`);
      if (!['win', 'place'].includes(l.betType)) throw new HttpError(400, 'Each parlay leg is a win or a place bet');
      if (l.betType === 'place' && !race.places_paid) throw new HttpError(400, `There is no place betting on race ${race.race_no}`);
      return { raceId: race.id, runnerNo: runner.number, betType: l.betType, price: l.betType === 'win' ? runner.win_price : runner.place_price };
    });
    const cents = toCents(stake, 'Stake');
    checkStake(cents);
    return db.tx(() => {
      const { lastInsertRowid } = db.prepare(`INSERT INTO horse_tickets (user_id, kind, selections, unit_stake, lines, stake)
        VALUES (?, 'parlay', ?, ?, 1, ?)`).run(user.id, JSON.stringify(clean), cents, cents);
      const id = Number(lastInsertRowid);
      const leg = db.prepare('INSERT INTO horse_parlay_legs (ticket_id, race_id, runner_no, bet_type, price_at_bet) VALUES (?, ?, ?, ?, ?)');
      for (const l of clean) leg.run(id, l.raceId, l.runnerNo, l.betType, l.price);
      db.adjustBalance({ userId: user.id, amount: -cents, type: 'bet', horseTicketId: id });
      return id;
    });
  }

  router.post('/horse-tickets', requireUser, (req, res) => {
    if (req.user.role !== 'user') throw new HttpError(403, 'The master account cannot place bets');
    const body = req.body || {};
    const id = body.kind === 'parlay' ? placeParlay(req.user, body)
      : body.kind === 'exotic' ? placeExotic(req.user, body)
        : (() => { throw new HttpError(400, 'Unknown bet'); })();
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id).balance;
    res.status(201).json({ ticketId: id, balance: fromCents(balance) });
  });

  function tickets(where, params, limit = 200) {
    const legStmt = db.prepare(`SELECT l.*, r.meeting, r.race_no, r.post_time, u.horse, u.finish_pos FROM horse_parlay_legs l
      JOIN races r ON r.id = l.race_id JOIN runners u ON u.race_id = l.race_id AND u.number = l.runner_no
      WHERE l.ticket_id = ? ORDER BY r.post_time`);
    const lineStmt = db.prepare('SELECT combo, result, dividend FROM horse_ticket_lines WHERE ticket_id = ? ORDER BY id');
    const horseStmt = db.prepare('SELECT number, horse FROM runners WHERE race_id = ?');
    return db.prepare(`SELECT t.*, us.username, r.meeting, r.race_no, r.name AS race_name, r.post_time, r.status AS race_status
      FROM horse_tickets t JOIN users us ON us.id = t.user_id LEFT JOIN races r ON r.id = t.race_id
      WHERE ${where} ORDER BY t.id DESC LIMIT ${limit}`).all(...params).map((t) => ({
      id: t.id,
      kind: t.kind,
      username: t.username,
      pool: t.pool,
      poolName: t.pool ? POOLS[t.pool]?.name : null,
      mode: t.mode,
      raceId: t.race_id,
      meeting: t.meeting,
      raceNo: t.race_no,
      raceName: t.race_name,
      postTime: t.post_time,
      raceStatus: t.race_status,
      horses: t.race_id ? Object.fromEntries(horseStmt.all(t.race_id).map((h) => [h.number, h.horse])) : null,
      unitStake: fromCents(t.unit_stake),
      lines: t.lines,
      stake: fromCents(t.stake),
      status: t.status,
      payout: fromCents(t.payout),
      placedAt: t.placed_at,
      settledAt: t.settled_at,
      ...(t.kind === 'exotic' && { combos: lineStmt.all(t.id) }),
      ...(t.kind === 'parlay' && {
        legs: legStmt.all(t.id).map((l) => ({ raceId: l.race_id, meeting: l.meeting, raceNo: l.race_no, postTime: l.post_time,
          runnerNo: l.runner_no, horse: l.horse, betType: l.bet_type, priceAtBet: l.price_at_bet, result: l.result,
          dividend: l.dividend, position: l.finish_pos })),
      }),
    }));
  }

  router.get('/horse-tickets', requireUser, (req, res) => res.json({ tickets: tickets('t.user_id = ?', [req.user.id]) }));

  // ------------------------------------------------------------ admin

  const admin = express.Router();
  admin.use(requireUser, requireAdmin);

  admin.get('/horse-tickets', (req, res) => {
    const { status } = req.query;
    if (['open', 'won', 'lost', 'void'].includes(status)) return res.json({ tickets: tickets('t.status = ?', [status], 500) });
    res.json({ tickets: tickets('1 = 1', [], 500) });
  });

  admin.get('/horse-bets', (req, res) => {
    const { status } = req.query;
    if (['open', 'won', 'lost', 'void'].includes(status)) return res.json({ bets: horseBets('b.status = ?', [status], 500) });
    res.json({ bets: horseBets('1 = 1', [], 500) });
  });

  // Races that have started but have no result yet, plus upcoming races that already have bets on them.
  admin.get('/races', (req, res) => {
    const pending = db.prepare("SELECT * FROM races WHERE status = 'open' AND post_time <= ? ORDER BY post_time").all(nowIso());
    const upcoming = db.prepare(`SELECT * FROM races WHERE status = 'open' AND post_time > ? ORDER BY post_time LIMIT 20`).all(nowIso());
    res.json({
      pending: racesWithRunners(pending, { openBets: true }),
      upcoming: racesWithRunners(upcoming, { openBets: true }),
    });
  });

  const findOpenRace = (id) => {
    const race = db.prepare("SELECT * FROM races WHERE id = ? AND status = 'open'").get(id);
    if (!race) throw new HttpError(404, 'Race not found or already settled');
    return race;
  };

  admin.post('/races/:id/runners/:no/withdraw', (req, res) => {
    const race = findOpenRace(req.params.id);
    const r = db.prepare('UPDATE runners SET withdrawn = 1, win_price = NULL, place_price = NULL WHERE race_id = ? AND number = ?')
      .run(race.id, Number(req.params.no));
    if (!r.changes) throw new HttpError(404, 'Runner not found');
    res.json({ settledBets: settleHorseBets(db) });
  });

  admin.post('/races/:id/result', (req, res) => {
    const race = findOpenRace(req.params.id);
    const runners = req.body?.runners;
    if (!Array.isArray(runners)) throw new HttpError(400, 'Missing runners');
    const known = new Set(db.prepare('SELECT number FROM runners WHERE race_id = ?').all(race.id).map((r) => r.number));
    const clean = runners.map((r) => {
      const number = Number(r.number);
      if (!known.has(number)) throw new HttpError(400, `Unknown runner ${r.number}`);
      const num = (v, label) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1) throw new HttpError(400, `${label} for #${number} must be 1.00 or more`);
        return n;
      };
      const position = r.position === '' || r.position == null ? null : Number(r.position);
      if (position !== null && !(Number.isInteger(position) && position >= 1)) throw new HttpError(400, `Bad position for #${number}`);
      return { number, position, winDividend: num(r.winDividend, 'Win dividend'), placeDividend: num(r.placeDividend, 'Place dividend') };
    });
    if (!clean.some((r) => r.winDividend)) throw new HttpError(400, 'Enter the win dividend for the winner');
    // Exotic dividends, e.g. { EXACTA: { '6-9': 50.9 } }. A pool left out refunds its bets.
    const pools = {};
    for (const [pool, combos] of Object.entries(req.body?.pools || {})) {
      if (!POOLS[pool] || !combos || typeof combos !== 'object') continue;
      for (const [combo, div] of Object.entries(combos)) {
        if (div === '' || div == null) continue;
        const numbers = String(combo).split(/[-*]/).map(Number);
        if (numbers.length !== POOLS[pool].picks || numbers.some((n) => !known.has(n))) {
          throw new HttpError(400, `${POOLS[pool].name}: ${combo} is not a valid combination`);
        }
        if (!(Number(div) >= 1)) throw new HttpError(400, `${POOLS[pool].name} dividend must be 1.00 or more`);
        (pools[pool] ||= {})[comboKey(pool, numbers)] = Number(div);
      }
    }
    db.tx(() => recordResult(db, race.id, clean, pools));
    res.json({ settledBets: settleHorseBets(db) });
  });

  admin.post('/races/:id/abandon', (req, res) => {
    const race = findOpenRace(req.params.id);
    db.prepare("UPDATE races SET status = 'abandoned' WHERE id = ?").run(race.id);
    res.json({ settledBets: settleHorseBets(db) });
  });

  router.use('/admin', admin);
  return router;
}

module.exports = { racingRoutes };
