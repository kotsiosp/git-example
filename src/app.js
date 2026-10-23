'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { settleAll } = require('./settle');
const { settleHorseBets } = require('./racing');
const { racingRoutes } = require('./racingRoutes');
const { HttpError, toCents, fromCents, requireUser, requireAdmin } = require('./util');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, balance: fromCents(u.balance), active: !!u.active, createdAt: u.created_at };
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 128) {
    throw new HttpError(400, 'Password must be 6-128 characters');
  }
}

function createApp({ db, config, odds, racing, now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    });
    next();
  });

  // State-changing API calls must be JSON, which a cross-site form cannot send without a CORS preflight.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Expected application/json' });
    }
    next();
  });

  // ------------------------------------------------------------ sessions

  const cookieName = 'pb_sid';
  function readCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName) return decodeURIComponent(v.join('='));
    }
    return null;
  }
  function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  app.use((req, res, next) => {
    const token = readCookie(req);
    if (token) {
      const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                              WHERE s.token = ? AND s.expires_at > ?`).get(hashToken(token), now());
      if (row && row.active) {
        req.user = row;
        req.sessionToken = hashToken(token);
      }
    }
    next();
  });

  const loginAttempts = new Map();
  function checkRateLimit(key) {
    const windowMs = 15 * 60 * 1000;
    const entry = loginAttempts.get(key);
    if (entry && now() - entry.first < windowMs && entry.count >= 10) {
      throw new HttpError(429, 'Too many login attempts, try again in a few minutes');
    }
  }
  function recordFailure(key) {
    const entry = loginAttempts.get(key);
    if (!entry || now() - entry.first > 15 * 60 * 1000) loginAttempts.set(key, { first: now(), count: 1 });
    else entry.count++;
  }

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const key = `${req.ip}|${String(username).toLowerCase()}`;
    checkRateLimit(key);
    const user = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || typeof password !== 'string' || !bcrypt.compareSync(password, user.password_hash)) {
      recordFailure(key);
      throw new HttpError(401, 'Wrong username or password');
    }
    if (!user.active) throw new HttpError(403, 'This account has been disabled');
    loginAttempts.delete(key);

    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = config.sessionDays * 86400 * 1000;
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), user.id, now() + maxAge);
    res.cookie(cookieName, token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge, path: '/' });
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie(cookieName, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      siteName: config.siteName, currency: config.currency, minStake: config.minStake, maxStake: config.maxStake,
      maxLegs: config.maxLegs, oddsMode: odds ? odds.mode : null, racingMode: racing ? racing.mode : null,
    });
  });

  app.get('/api/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/me/password', requireUser, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !bcrypt.compareSync(currentPassword, req.user.password_hash)) {
      throw new HttpError(400, 'Current password is wrong');
    }
    validatePassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ events & odds

  function eventsWithOdds(rows) {
    const oddsStmt = db.prepare('SELECT market, outcome, point, price FROM odds WHERE event_id = ?');
    return rows.map((e) => {
      const markets = {};
      for (const o of oddsStmt.all(e.id)) (markets[o.market] ||= {})[o.outcome] = { price: o.price, point: o.point };
      return {
        id: e.id,
        league: e.sport_title,
        leagueKey: e.sport_key,
        home: e.home_team,
        away: e.away_team,
        commenceTime: e.commence_time,
        completed: !!e.completed,
        voided: !!e.voided,
        score: e.completed ? [e.home_score, e.away_score] : null,
        oddsUpdatedAt: e.odds_updated_at,
        markets,
      };
    });
  }

  // Football can be switched off (FOOTBALL_ENABLED); its routes then answer as if they don't exist.
  const requireFootball = (req, res, next) => (odds ? next() : res.status(404).json({ error: 'Football betting is not available' }));

  app.get('/api/events', requireUser, requireFootball, (req, res) => {
    const nowIso = new Date(now()).toISOString();
    const until = new Date(now() + 10 * 86400 * 1000).toISOString();
    const rows = db.prepare(`SELECT * FROM events WHERE commence_time > ? AND commence_time < ? AND completed = 0 AND voided = 0
                             AND EXISTS (SELECT 1 FROM odds o WHERE o.event_id = events.id)
                             ORDER BY commence_time, sport_title`).all(nowIso, until);
    res.json({ events: eventsWithOdds(rows), refreshedAt: db.getMeta('odds_refreshed_at') });
  });

  app.get('/api/results', requireUser, requireFootball, (req, res) => {
    const since = new Date(now() - 4 * 86400 * 1000).toISOString();
    const rows = db.prepare(`SELECT * FROM events WHERE commence_time > ? AND (completed = 1 OR voided = 1)
                             ORDER BY commence_time DESC LIMIT 200`).all(since);
    res.json({ events: eventsWithOdds(rows) });
  });

  // ------------------------------------------------------------ betting

  const MARKETS = { h2h: ['home', 'draw', 'away'], totals: ['over', 'under'] };

  app.post('/api/bets', requireUser, requireFootball, (req, res) => {
    if (req.user.role !== 'user') throw new HttpError(403, 'The master account cannot place bets');
    const { selections, stake, mode = 'single' } = req.body || {};
    if (!Array.isArray(selections) || selections.length === 0) throw new HttpError(400, 'Add at least one selection');
    if (!['single', 'acca'].includes(mode)) throw new HttpError(400, 'Unknown bet type');
    if (selections.length > config.maxLegs) throw new HttpError(400, `At most ${config.maxLegs} selections`);
    const stakeCents = toCents(stake, 'Stake');
    if (stakeCents < config.minStake * 100 || stakeCents > config.maxStake * 100) {
      throw new HttpError(400, `Stake must be between ${config.minStake} and ${config.maxStake}`);
    }

    const nowIso = new Date(now()).toISOString();
    const legs = [];
    const changed = [];
    for (const s of selections) {
      if (!s || !MARKETS[s.market]?.includes(s.outcome)) throw new HttpError(400, 'Invalid selection');
      const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(String(s.eventId));
      if (!ev || ev.completed || ev.voided || ev.commence_time <= nowIso) {
        throw new HttpError(400, `Betting is closed for ${ev ? `${ev.home_team} v ${ev.away_team}` : 'this match'}`);
      }
      const o = db.prepare('SELECT * FROM odds WHERE event_id = ? AND market = ? AND outcome = ?').get(ev.id, s.market, s.outcome);
      if (!o) throw new HttpError(400, `This market is suspended for ${ev.home_team} v ${ev.away_team}`);
      if (Number(s.price) !== o.price) changed.push({ eventId: ev.id, market: s.market, outcome: s.outcome, price: o.price });
      legs.push({ eventId: ev.id, market: s.market, outcome: s.outcome, point: o.point, price: o.price });
    }
    if (changed.length) throw new HttpError(409, 'Odds have changed, please review your bet slip', { changed });
    if (mode === 'acca') {
      if (legs.length < 2) throw new HttpError(400, 'An accumulator needs at least 2 selections');
      if (new Set(legs.map((l) => l.eventId)).size !== legs.length) {
        throw new HttpError(400, 'An accumulator cannot contain two selections from the same match');
      }
    }

    const groups = mode === 'acca' ? [legs] : legs.map((l) => [l]);
    const placed = db.tx(() => groups.map((group) => {
      const totalOdds = Math.round(group.reduce((acc, l) => acc * l.price, 1) * 100) / 100;
      const { lastInsertRowid: betId } = db.prepare('INSERT INTO bets (user_id, stake, total_odds) VALUES (?, ?, ?)')
        .run(req.user.id, stakeCents, totalOdds);
      const insertLeg = db.prepare('INSERT INTO bet_legs (bet_id, event_id, market, outcome, point, price) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of group) insertLeg.run(betId, l.eventId, l.market, l.outcome, l.point, l.price);
      db.adjustBalance({ userId: req.user.id, amount: -stakeCents, type: 'bet', betId: Number(betId) });
      return Number(betId);
    }));
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id).balance;
    res.status(201).json({ betIds: placed, balance: fromCents(balance) });
  });

  function betsQuery(where, params, limit = 200) {
    const bets = db.prepare(`SELECT b.*, u.username FROM bets b JOIN users u ON u.id = b.user_id
                             WHERE ${where} ORDER BY b.id DESC LIMIT ${limit}`).all(...params);
    const legStmt = db.prepare(`SELECT l.*, e.home_team, e.away_team, e.sport_title, e.commence_time, e.completed,
                                e.home_score, e.away_score FROM bet_legs l JOIN events e ON e.id = l.event_id
                                WHERE l.bet_id = ? ORDER BY e.commence_time`);
    return bets.map((b) => ({
      id: b.id,
      username: b.username,
      stake: fromCents(b.stake),
      totalOdds: b.total_odds,
      potentialReturn: fromCents(Math.round(b.stake * b.total_odds)),
      status: b.status,
      payout: fromCents(b.payout),
      placedAt: b.placed_at,
      settledAt: b.settled_at,
      legs: legStmt.all(b.id).map((l) => ({
        eventId: l.event_id,
        match: `${l.home_team} v ${l.away_team}`,
        home: l.home_team,
        away: l.away_team,
        league: l.sport_title,
        commenceTime: l.commence_time,
        market: l.market,
        outcome: l.outcome,
        point: l.point,
        price: l.price,
        result: l.result,
        score: l.completed ? [l.home_score, l.away_score] : null,
      })),
    }));
  }

  app.get('/api/bets', requireUser, (req, res) => {
    res.json({ bets: betsQuery('b.user_id = ?', [req.user.id]) });
  });

  function transactions(userId) {
    return db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 300').all(userId).map((t) => ({
      id: t.id, amount: fromCents(t.amount), balanceAfter: fromCents(t.balance_after), type: t.type, betId: t.bet_id,
      horseBetId: t.horse_bet_id, note: t.note, createdAt: t.created_at,
    }));
  }

  app.get('/api/transactions', requireUser, (req, res) => res.json({ transactions: transactions(req.user.id) }));

  // ------------------------------------------------------------ admin

  const admin = express.Router();
  admin.use(requireUser, requireAdmin);

  const findUser = (id) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(Number(id));
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  };

  admin.get('/users', (req, res) => {
    const rows = db.prepare(`SELECT u.*,
        (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id)
          + (SELECT COUNT(*) FROM horse_bets h WHERE h.user_id = u.id) AS bet_count,
        (SELECT COALESCE(SUM(stake), 0) FROM bets b WHERE b.user_id = u.id AND b.status = 'open')
          + (SELECT COALESCE(SUM(stake), 0) FROM horse_bets h WHERE h.user_id = u.id AND h.status = 'open') AS open_stake
      FROM users u WHERE role = 'user' ORDER BY u.username`).all();
    res.json({ users: rows.map((u) => ({ ...publicUser(u), betCount: u.bet_count, openStake: fromCents(u.open_stake) })) });
  });

  admin.post('/users', (req, res) => {
    const { username, password, initialCredit = 0 } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, _ . -');
    }
    validatePassword(password);
    const credit = toCents(initialCredit, 'Initial credit');
    if (credit < 0) throw new HttpError(400, 'Initial credit cannot be negative');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
    const user = db.tx(() => {
      const { lastInsertRowid } = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')")
        .run(username, bcrypt.hashSync(password, 10));
      if (credit > 0) db.adjustBalance({ userId: Number(lastInsertRowid), amount: credit, type: 'credit', note: 'Opening credit', byUserId: req.user.id });
      return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json({ user: publicUser(user) });
  });

  admin.post('/users/:id/credit', (req, res) => {
    const user = findUser(req.params.id);
    const amount = toCents(req.body?.amount);
    if (amount === 0) throw new HttpError(400, 'Amount cannot be zero');
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null;
    const balance = db.tx(() => db.adjustBalance({
      userId: user.id, amount, type: amount > 0 ? 'credit' : 'debit', note, byUserId: req.user.id,
    }));
    res.json({ balance: fromCents(balance) });
  });

  admin.post('/users/:id/password', (req, res) => {
    const user = findUser(req.params.id);
    validatePassword(req.body?.password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 10), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json({ ok: true });
  });

  admin.post('/users/:id/active', (req, res) => {
    const user = findUser(req.params.id);
    const active = req.body?.active ? 1 : 0;
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, user.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json({ ok: true });
  });

  admin.get('/users/:id/transactions', (req, res) => res.json({ transactions: transactions(findUser(req.params.id).id) }));

  admin.get('/bets', requireFootball, (req, res) => {
    const status = req.query.status;
    if (status && ['open', 'won', 'lost', 'void'].includes(status)) {
      return res.json({ bets: betsQuery('b.status = ?', [status], 500) });
    }
    res.json({ bets: betsQuery('1 = 1', [], 500) });
  });

  // Started matches that still have unsettled bets (e.g. postponed, or no result from the feed yet).
  admin.get('/events/pending', requireFootball, (req, res) => {
    const rows = db.prepare(`SELECT e.*, COUNT(l.id) AS pending_legs FROM events e JOIN bet_legs l ON l.event_id = e.id
                             WHERE l.result = 'pending' AND e.completed = 0 AND e.voided = 0 AND e.commence_time <= ?
                             GROUP BY e.id ORDER BY e.commence_time`).all(new Date(now()).toISOString());
    res.json({ events: eventsWithOdds(rows).map((e, i) => ({ ...e, pendingLegs: rows[i].pending_legs })) });
  });

  admin.post('/events/:id/result', requireFootball, (req, res) => {
    const h = Number(req.body?.homeScore);
    const a = Number(req.body?.awayScore);
    if (![h, a].every((n) => Number.isInteger(n) && n >= 0 && n < 100)) throw new HttpError(400, 'Enter both scores');
    const r = db.prepare('UPDATE events SET completed = 1, voided = 0, home_score = ?, away_score = ? WHERE id = ? AND completed = 0')
      .run(h, a, req.params.id);
    if (!r.changes) throw new HttpError(404, 'Match not found or already settled');
    res.json({ settledBets: settleAll(db) });
  });

  admin.post('/events/:id/void', requireFootball, (req, res) => {
    const r = db.prepare('UPDATE events SET voided = 1 WHERE id = ? AND completed = 0').run(req.params.id);
    if (!r.changes) throw new HttpError(404, 'Match not found or already settled');
    db.prepare('DELETE FROM odds WHERE event_id = ?').run(req.params.id);
    res.json({ settledBets: settleAll(db) });
  });

  admin.get('/status', (req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    res.json({
      oddsMode: odds ? odds.mode : null,
      leagues: config.leagues,
      oddsRefreshedAt: db.getMeta('odds_refreshed_at'),
      scoresRefreshedAt: db.getMeta('scores_refreshed_at'),
      apiRequestsRemaining: db.getMeta('odds_api_remaining'),
      lastError: db.getMeta('odds_last_error'),
      upcomingEvents: count(`SELECT COUNT(*) AS n FROM events WHERE commence_time > '${new Date(now()).toISOString()}' AND completed = 0 AND voided = 0`),
      users: count("SELECT COUNT(*) AS n FROM users WHERE role = 'user'"),
      openBets: count("SELECT COUNT(*) AS n FROM bets WHERE status = 'open'")
        + count("SELECT COUNT(*) AS n FROM horse_bets WHERE status = 'open'"),
      racingMode: racing ? racing.mode : null,
      racingRefreshedAt: db.getMeta('racing_refreshed_at'),
      racingLastError: db.getMeta('racing_last_error'),
      creditsInCirculation: fromCents(count("SELECT COALESCE(SUM(balance), 0) AS n FROM users WHERE role = 'user'")),
    });
  });

  admin.post('/refresh', async (req, res) => {
    const result = odds ? await odds.refreshOdds() : { errors: [] };
    if (odds) await odds.refreshScores();
    if (racing) await racing.refresh();
    const settledBets = settleAll(db) + settleHorseBets(db);
    res.json({ errors: result.errors, settledBets });
  });

  app.use('/api/admin', admin);
  if (racing) app.use('/api', racingRoutes({ db, config, now }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ------------------------------------------------------------ frontend

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message, ...(err.extra || {}) });
  });

  return app;
}

function ensureAdmin(db, config) {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return null;
  let password = config.adminPassword;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run(config.adminUsername, bcrypt.hashSync(password, 10));
  return { username: config.adminUsername, password: generated ? password : null };
}

module.exports = { createApp, ensureAdmin };
