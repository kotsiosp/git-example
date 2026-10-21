'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
  note TEXT,
  by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tx_user ON transactions(user_id, id);

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

  // Moves money and writes the ledger entry. Must run inside db.tx().
  db.adjustBalance = ({ userId, amount, type, betId = null, note = null, byUserId = null }) => {
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    const after = user.balance + amount;
    if (after < 0) throw Object.assign(new Error('Insufficient balance'), { status: 400 });
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(after, userId);
    db.prepare(`INSERT INTO transactions (user_id, amount, balance_after, type, bet_id, note, by_user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, amount, after, type, betId, note, byUserId);
    return after;
  };

  return db;
}

module.exports = { open };
