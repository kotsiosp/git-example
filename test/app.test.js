'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createOddsService, consensusOdds } = require('../src/odds');
const { settleAll } = require('../src/settle');

let clock = Date.parse('2026-10-21T12:00:00Z');
const now = () => clock;
const config = {
  ...require('../src/config'),
  oddsApiKey: '',
  adminUsername: 'boss',
  adminPassword: 'boss-pass',
  leagues: ['soccer_epl', 'soccer_spain_la_liga'],
};

let db; let odds; let server; let base;

function client() {
  let cookie = '';
  return async (path, body, method) => {
    const res = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

before(async () => {
  db = open(':memory:');
  ensureAdmin(db, config);
  odds = createOddsService(db, config, { now, log: { error() {} } });
  await odds.refreshOdds();
  server = createApp({ db, config, odds, now }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const adminC = client();
const alice = client();

test('master logs in, opens an account and credits it', async () => {
  assert.equal((await adminC('/api/login', { username: 'boss', password: 'nope' })).status, 401);
  assert.equal((await adminC('/api/login', { username: 'boss', password: 'boss-pass' })).status, 200);

  const created = await adminC('/api/admin/users', { username: 'alice', password: 'secret1', initialCredit: 100 });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.balance, 100);
  assert.equal((await adminC('/api/admin/users', { username: 'ALICE', password: 'secret1' })).status, 409);

  const credited = await adminC(`/api/admin/users/${created.body.user.id}/credit`, { amount: 50.5, note: 'bonus' });
  assert.equal(credited.body.balance, 150.5);
  const tooMuch = await adminC(`/api/admin/users/${created.body.user.id}/credit`, { amount: -1000 });
  assert.equal(tooMuch.status, 400);
});

test('players cannot use admin routes', async () => {
  await alice('/api/login', { username: 'alice', password: 'secret1' });
  assert.equal((await alice('/api/admin/users')).status, 403);
  assert.equal((await client()('/api/events')).status, 401);
});

test('betting: odds-change protection, singles, accas and settlement', async () => {
  const { body } = await alice('/api/events');
  const events = body.events.filter((e) => e.markets.h2h && e.markets.totals);
  assert.ok(events.length >= 3, 'demo feed provides upcoming matches');
  const [e1, e2, e3] = events;

  // Stale price is rejected with the current one.
  const stale = await alice('/api/bets', { mode: 'single', stake: 10, selections: [{ eventId: e1.id, market: 'h2h', outcome: 'home', price: 99 }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.changed[0].price, e1.markets.h2h.home.price);

  const single = await alice('/api/bets', { mode: 'single', stake: 10, selections: [
    { eventId: e1.id, market: 'h2h', outcome: 'home', price: e1.markets.h2h.home.price },
    { eventId: e2.id, market: 'totals', outcome: 'over', price: e2.markets.totals.over.price },
  ] });
  assert.equal(single.status, 201);
  assert.equal(single.body.betIds.length, 2);
  assert.equal(single.body.balance, 130.5);

  const accaSameMatch = await alice('/api/bets', { mode: 'acca', stake: 5, selections: [
    { eventId: e1.id, market: 'h2h', outcome: 'home', price: e1.markets.h2h.home.price },
    { eventId: e1.id, market: 'totals', outcome: 'over', price: e1.markets.totals.over.price },
  ] });
  assert.equal(accaSameMatch.status, 400);

  const acca = await alice('/api/bets', { mode: 'acca', stake: 20, selections: [
    { eventId: e1.id, market: 'h2h', outcome: 'draw', price: e1.markets.h2h.draw.price },
    { eventId: e3.id, market: 'h2h', outcome: 'away', price: e3.markets.h2h.away.price },
  ] });
  assert.equal(acca.status, 201);
  assert.equal(acca.body.balance, 110.5);

  const broke = await alice('/api/bets', { mode: 'single', stake: 1000, selections: [
    { eventId: e1.id, market: 'h2h', outcome: 'home', price: e1.markets.h2h.home.price }] });
  assert.equal(broke.status, 400);

  // Fast-forward past the matches; demo results get recorded and bets settle.
  clock += 4 * 86400 * 1000;
  await odds.refreshScores();
  settleAll(db);

  const bets = (await alice('/api/bets')).body.bets;
  assert.equal(bets.length, 3);
  assert.ok(bets.every((b) => b.status !== 'open'), 'all bets settled');
  const expected = 110.5 + bets.reduce((s, b) => s + b.payout, 0);
  for (const b of bets) {
    if (b.status === 'won') assert.equal(b.payout, Math.round(b.stake * b.totalOdds * 100) / 100);
    if (b.status === 'lost') assert.equal(b.payout, 0);
  }
  const me = (await alice('/api/me')).body.user;
  assert.equal(Math.round(me.balance * 100), Math.round(expected * 100));

  // Ledger always matches the balance.
  const tx = (await alice('/api/transactions')).body.transactions;
  assert.equal(tx[0].balanceAfter, me.balance);
  assert.equal(Math.round(tx.reduce((s, t) => s + t.amount, 0) * 100), Math.round(me.balance * 100));

  // Settling again never pays twice.
  assert.equal(settleAll(db), 0);
});

test('master can void a match and refund singles', async () => {
  clock = Date.parse('2026-11-01T12:00:00Z');
  await odds.refreshOdds();
  const ev = (await alice('/api/events')).body.events[0];
  const before = (await alice('/api/me')).body.user.balance;
  await alice('/api/bets', { mode: 'single', stake: 7, selections: [{ eventId: ev.id, market: 'h2h', outcome: 'home', price: ev.markets.h2h.home.price }] });

  clock = Date.parse(ev.commenceTime) + 60 * 1000;
  const late = await alice('/api/bets', { mode: 'single', stake: 1, selections: [{ eventId: ev.id, market: 'h2h', outcome: 'home', price: ev.markets.h2h.home.price }] });
  assert.equal(late.status, 400, 'no bets after kick-off');

  const pending = (await adminC('/api/admin/events/pending')).body.events;
  assert.ok(pending.some((e) => e.id === ev.id));
  const r = await adminC(`/api/admin/events/${encodeURIComponent(ev.id)}/void`, {});
  assert.equal(r.body.settledBets, 1);
  assert.equal((await alice('/api/me')).body.user.balance, before);
});

test('disabled players are logged out', async () => {
  const users = (await adminC('/api/admin/users')).body.users;
  const id = users.find((u) => u.username === 'alice').id;
  await adminC(`/api/admin/users/${id}/active`, { active: false });
  assert.equal((await alice('/api/me')).status, 401);
  assert.equal((await client()('/api/login', { username: 'alice', password: 'secret1' })).status, 403);
});

test('live feed: averages bookmakers and maps outcomes', () => {
  const ev = {
    id: 'x', home_team: 'Arsenal', away_team: 'Chelsea',
    bookmakers: [
      { key: 'pinnacle', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.0 }, { name: 'Chelsea', price: 4.0 }, { name: 'Draw', price: 3.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 2.5 }, { name: 'Under', price: 1.95, point: 2.5 }] },
      ] },
      { key: 'betfair', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.1 }, { name: 'Chelsea', price: 3.8 }, { name: 'Draw', price: 3.4 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: 2.4, point: 3.5 }, { name: 'Under', price: 1.6, point: 3.5 }] },
      ] },
    ],
  };
  const avg = Object.fromEntries(consensusOdds(ev, '').map((o) => [o.outcome, o.price]));
  assert.deepEqual(avg, { home: 2.05, away: 3.9, draw: 3.45, over: 1.9, under: 1.95 });
  const pin = Object.fromEntries(consensusOdds(ev, 'pinnacle').map((o) => [o.outcome, o.price]));
  assert.equal(pin.home, 2.0);
});

test('live feed: stores odds and settles from scores endpoint', async () => {
  const ldb = open(':memory:');
  const kickoff = '2026-10-25T15:00:00Z';
  const fakeFetch = async (url) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('apiKey'), 'KEY');
    if (u.pathname.endsWith('/events')) {
      return new Response(JSON.stringify([{ id: 'ev1', commence_time: kickoff, home_team: 'Arsenal', away_team: 'Chelsea' }]),
        { headers: { 'x-requests-remaining': '480', 'x-requests-last': '0' } });
    }
    const body = u.pathname.endsWith('/odds')
      ? [{ id: 'ev1', sport_key: 'soccer_epl', sport_title: 'EPL', commence_time: kickoff, home_team: 'Arsenal', away_team: 'Chelsea',
        bookmakers: [{ key: 'b', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2 }, { name: 'Chelsea', price: 3.6 }, { name: 'Draw', price: 3.3 }] }] }] }]
      : [{ id: 'ev1', completed: true, home_team: 'Arsenal', away_team: 'Chelsea', scores: [{ name: 'Arsenal', score: '2' }, { name: 'Chelsea', score: '1' }] }];
    return new Response(JSON.stringify(body), { headers: { 'x-requests-remaining': '480', 'x-requests-last': '2' } });
  };
  let t = Date.parse('2026-10-24T12:00:00Z');
  const svc = createOddsService(ldb, { ...config, oddsApiKey: 'KEY', leagues: ['soccer_epl'] }, { fetchImpl: fakeFetch, now: () => t });
  await svc.refreshOdds();
  assert.equal(ldb.prepare('SELECT COUNT(*) AS n FROM odds').get().n, 3, 'h2h stored, incomplete totals skipped');
  assert.equal(ldb.getMeta('odds_api_remaining'), '480');

  ldb.prepare("INSERT INTO users (id, username, password_hash, role, balance) VALUES (1, 'p', 'x', 'user', 0)").run();
  ldb.prepare('INSERT INTO bets (id, user_id, stake, total_odds) VALUES (1, 1, 1000, 2)').run();
  ldb.prepare("INSERT INTO bet_legs (bet_id, event_id, market, outcome, price) VALUES (1, 'ev1', 'h2h', 'home', 2)").run();
  t = Date.parse('2026-10-25T18:00:00Z');
  await svc.refreshScores();
  assert.equal(settleAll(ldb), 1);
  assert.equal(ldb.prepare('SELECT balance FROM users WHERE id = 1').get().balance, 2000);
});
