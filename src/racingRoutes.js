'use strict';

const express = require('express');
const { HttpError, toCents, fromCents, requireUser, requireAdmin } = require('./util');
const { settleHorseBets, recordResult } = require('./racing');

function racingRoutes({ db, config, now = () => Date.now() }) {
  const router = express.Router();
  const nowIso = () => new Date(now()).toISOString();

  function racesWithRunners(rows, { openBets = false } = {}) {
    const runnerStmt = db.prepare('SELECT * FROM runners WHERE race_id = ? ORDER BY number');
    const betCount = db.prepare("SELECT COUNT(*) AS n FROM horse_bets WHERE race_id = ? AND status = 'open'");
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

  // ------------------------------------------------------------ admin

  const admin = express.Router();
  admin.use(requireUser, requireAdmin);

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
    db.tx(() => recordResult(db, race.id, clean));
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
