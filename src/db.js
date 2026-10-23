'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  balance INTEGER NOT NULL DEFAULT 0,          -- in hundredths of a credit
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  sport_key TEXT NOT NULL,
  sport_title TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  commence_time TEXT NOT NULL,                 -- ISO 8601 UTC
  completed INTEGER NOT NULL DEFAULT 0,
  voided INTEGER NOT NULL DEFAULT 0,
  home_score INTEGER,
  away_score INTEGER,
  odds_updated_at TEXT
);
CREATE INDEX IF NOT EXISTS events_time ON events(commence_time);

CREATE TABLE IF NOT EXISTS odds (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  market TEXT NOT NULL,                        -- h2h | totals
  outcome TEXT NOT NULL,                       -- home | draw | away | over | under
  point REAL,
  price REAL NOT NULL,
  PRIMARY KEY (event_id, market, outcome)
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  stake INTEGER NOT NULL,
  total_odds REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
  payout INTEGER NOT NULL DEFAULT 0,
  placed_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS bets_user ON bets(user_id, id);

CREATE TABLE IF NOT EXISTS bet_legs (
  id INTEGER PRIMARY KEY,
  bet_id INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id),
  market TEXT NOT NULL,
  outcome TEXT NOT NULL,
  point REAL,
  price REAL NOT NULL,
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost', 'void'))
);
CREATE INDEX IF NOT EXISTS legs_event ON bet_legs(event_id, result);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type TEXT NOT NULL,                          -- credit | debit | bet | payout | refund
  bet_id INTEGER,
  horse_bet_id INTEGER,
  horse_ticket_id INTEGER,
  note TEXT,
  by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tx_user ON transactions(user_id, id);

CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  meeting TEXT NOT NULL,                       -- e.g. Nicosia
  race_no INTEGER NOT NULL,
  name TEXT,
  post_time TEXT NOT NULL,                     -- ISO 8601 UTC
  distance TEXT,
  places_paid INTEGER NOT NULL DEFAULT 3,      -- 0 = no place betting
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'result', 'abandoned')),
  prices_updated_at TEXT,
  pools TEXT                                   -- JSON list of exotic pools offered, e.g. ["EXACTA","QUINELLA"]
);
CREATE INDEX IF NOT EXISTS races_time ON races(post_time);

CREATE TABLE IF NOT EXISTS runners (
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  horse TEXT NOT NULL,
  jockey TEXT,
  trainer TEXT,
  weight TEXT,
  draw INTEGER,
  form TEXT,
  win_price REAL,                              -- live tote prices, moving until the off
  place_price REAL,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  finish_pos INTEGER,
  win_dividend REAL,                           -- official final payouts per 1 credit staked
  place_dividend REAL,
  PRIMARY KEY (race_id, number)
);

CREATE TABLE IF NOT EXISTS horse_bets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  race_id TEXT NOT NULL REFERENCES races(id),
  runner_no INTEGER NOT NULL,
  bet_type TEXT NOT NULL CHECK (bet_type IN ('win', 'place')),
  stake INTEGER NOT NULL,
  price_at_bet REAL,                           -- for information only; bets pay the final dividend
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
  dividend REAL,
  payout INTEGER NOT NULL DEFAULT 0,
  placed_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS horse_bets_user ON horse_bets(user_id, id);
CREATE INDEX IF NOT EXISTS horse_bets_race ON horse_bets(race_id, status);

-- Official dividends for exotic pools, per winning combination ("6-9" in order; sorted for Twin/Omni).
CREATE TABLE IF NOT EXISTS race_dividends (
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  pool TEXT NOT NULL,
  combo TEXT NOT NULL,
  dividend REAL NOT NULL,
  PRIMARY KEY (race_id, pool, combo)
);
-- Pools whose result was published. A pool without one (nobody won, or no data) refunds its bets.
CREATE TABLE IF NOT EXISTS race_pool_results (
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  pool TEXT NOT NULL,
  PRIMARY KEY (race_id, pool)
);

-- Exotic bets (Forecast, Twin, Omni, Trio, Tetracast) and parlays. One ticket can cover many
-- combinations (a box or banker), each costing the unit stake.
CREATE TABLE IF NOT EXISTS horse_tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('exotic', 'parlay')),
  race_id TEXT REFERENCES races(id),           -- exotic only
  pool TEXT,                                   -- exotic only: EXACTA, QUINELLA, SWINGER, TRIFECTA, SUPERFECTA
  mode TEXT,                                   -- exotic only: straight, reverse, box, banker
  selections TEXT,                             -- JSON, as chosen (for display)
  unit_stake INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  stake INTEGER NOT NULL,                      -- unit_stake * lines
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
  payout INTEGER NOT NULL DEFAULT 0,
  placed_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS horse_tickets_user ON horse_tickets(user_id, id);

CREATE TABLE IF NOT EXISTS horse_ticket_lines (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES horse_tickets(id) ON DELETE CASCADE,
  combo TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost', 'void')),
  dividend REAL
);
CREATE INDEX IF NOT EXISTS horse_ticket_lines_ticket ON horse_ticket_lines(ticket_id);

CREATE TABLE IF NOT EXISTS horse_parlay_legs (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES horse_tickets(id) ON DELETE CASCADE,
  race_id TEXT NOT NULL REFERENCES races(id),
  runner_no INTEGER NOT NULL,
  bet_type TEXT NOT NULL CHECK (bet_type IN ('win', 'place')),
  price_at_bet REAL,
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost', 'void')),
  dividend REAL
);
CREATE INDEX IF NOT EXISTS horse_parlay_legs_race ON horse_parlay_legs(race_id, result);

-- The master log: an append-only record of bets, results, settlements, logins and master actions,
-- for settling disputes. Rows cannot be changed or deleted, and each row's hash covers the one
-- before it, so editing the file directly breaks the chain.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,                            -- server time, ISO 8601 with milliseconds
  actor_id INTEGER,                            -- who did it; NULL for the system or a feed
  actor TEXT NOT NULL,                         -- username, 'system' or the feed's name
  user_id INTEGER,                             -- the player it concerns, for filtering
  action TEXT NOT NULL,
  summary TEXT NOT NULL,                       -- plain-language description
  details TEXT,                                -- JSON with everything known at the time
  ip TEXT,
  prev_hash TEXT,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log(user_id, id);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, id);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'The master log cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'The master log cannot be changed'); END;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Columns added after the first release, for databases created before them.
  const addColumn = (table, column, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  };
  addColumn('transactions', 'horse_bet_id', 'INTEGER');
  addColumn('transactions', 'horse_ticket_id', 'INTEGER');
  addColumn('races', 'pools', 'TEXT');

  db.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  db.getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  db.setMeta = (key, value) =>
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value == null ? null : String(value));

  const logHash = (prev, r) => crypto.createHash('sha256')
    .update(JSON.stringify([prev, r.at, r.actor_id, r.actor, r.user_id, r.action, r.summary, r.details, r.ip])).digest('hex');

  // Appends to the master log. `details` is stored as JSON.
  db.log = ({ action, summary, actor = null, userId = null, details = null, ip = null, at = new Date().toISOString() }) => {
    const prev = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.hash ?? null;
    const row = { at, actor_id: actor?.id ?? null, actor: actor?.username ?? actor?.name ?? 'system', user_id: userId,
      action, summary, details: details == null ? null : JSON.stringify(details), ip };
    db.prepare(`INSERT INTO audit_log (at, actor_id, actor, user_id, action, summary, details, ip, prev_hash, hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.at, row.actor_id, row.actor, row.user_id, row.action, row.summary, row.details, row.ip, prev, logHash(prev, row));
  };

  // Recomputes the chain. Returns the first entry that no longer matches what was written, if any.
  db.verifyLog = () => {
    let prev = null;
    let count = 0;
    for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
      if (r.prev_hash !== prev || r.hash !== logHash(prev, r)) return { intact: false, count, brokenAt: r.id };
      prev = r.hash;
      count++;
    }
    return { intact: true, count };
  };

  // Moves money and writes the ledger entry. Must run inside db.tx().
  db.adjustBalance = ({ userId, amount, type, betId = null, horseBetId = null, horseTicketId = null, note = null, byUserId = null }) => {
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    const after = user.balance + amount;
    if (after < 0) throw Object.assign(new Error('Insufficient balance'), { status: 400 });
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(after, userId);
    db.prepare(`INSERT INTO transactions (user_id, amount, balance_after, type, bet_id, horse_bet_id, horse_ticket_id, note, by_user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, amount, after, type, betId, horseBetId, horseTicketId, note, byUserId);
    return after;
  };

  return db;
}

module.exports = { open };
