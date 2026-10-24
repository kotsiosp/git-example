'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createOddsService } = require('../src/odds');
const { createRacingService, settleHorseBets, placesFor } = require('../src/racing');

let clock = Date.parse('2026-10-22T12:05:00Z');
const now = () => clock;
const config = { ...require('../src/config'), oddsApiKey: '', adminUsername: 'boss', adminPassword: 'boss-pass', leagues: [] };

let db; let racing; let server; let base;

function client() {
  let cookie = '';
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

const boss = client();
const bob = client();
const balance = async () => (await bob('/api/me')).body.user.balance;

before(async () => {
  db = open(':memory:');
  ensureAdmin(db, config);
  const odds = createOddsService(db, config, { now, log: { error() {} } });
  racing = createRacingService(db, config, { now, log: { error() {} } });
  await racing.refresh();
  server = createApp({ db, config, odds, racing, now }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await boss('/api/login', { username: 'boss', password: 'boss-pass' });
  await boss('/api/admin/users', { username: 'bob', password: 'secret1', initialCredit: 500 });
  await bob('/api/login', { username: 'bob', password: 'secret1' });
});
after(() => server.close());

test('place terms follow field size', () => {
  assert.deepEqual([3, 4, 5, 7, 8, 14].map(placesFor), [0, 0, 2, 2, 3, 3]);
});

test('race cards come with live prices; withdrawn runners have none', async () => {
  const { races } = (await bob('/api/races')).body;
  assert.ok(races.length > 10);
  for (const r of races) {
    assert.ok(Date.parse(r.postTime) > clock);
    for (const u of r.runners) {
      if (u.withdrawn) assert.equal(u.winPrice, null);
      else assert.ok(u.winPrice >= 1.1);
    }
  }
});

test('win, place and each-way bets settle at the final dividend', async () => {
  const races = (await bob('/api/races')).body.races.filter((r) => r.placesPaid > 0);
  const race = races[0];
  const [a, b] = race.runners.filter((u) => !u.withdrawn);

  assert.equal((await bob('/api/horse-bets', { raceId: race.id, runnerNo: a.number, betType: 'win', stake: 10 })).status, 201);
  const ew = await bob('/api/horse-bets', { raceId: race.id, runnerNo: b.number, betType: 'each_way', stake: 5 });
  assert.equal(ew.status, 201);
  assert.equal(ew.body.betIds.length, 2);
  assert.equal(ew.body.balance, 480);
  assert.equal((await boss('/api/horse-bets', { raceId: race.id, runnerNo: a.number, betType: 'win', stake: 1 })).status, 403);

  // Prices keep moving before the off, then freeze.
  clock = Date.parse(race.postTime) + 60 * 1000;
  await racing.refresh();
  assert.equal((await bob('/api/horse-bets', { raceId: race.id, runnerNo: a.number, betType: 'win', stake: 1 })).status, 400,
    'no bets after the off');
  const frozen = db.prepare('SELECT number, win_price FROM runners WHERE race_id = ?').all(race.id);
  clock += 5 * 60 * 1000;
  await racing.refresh();
  assert.deepEqual(db.prepare('SELECT number, win_price FROM runners WHERE race_id = ?').all(race.id), frozen);

  // Demo results arrive 8 minutes after the off.
  clock = Date.parse(race.postTime) + 9 * 60 * 1000;
  await racing.refresh();
  settleHorseBets(db);
  const runners = db.prepare('SELECT * FROM runners WHERE race_id = ?').all(race.id);
  const bets = (await bob('/api/horse-bets')).body.bets.filter((x) => x.raceId === race.id);
  assert.equal(bets.length, 3);
  for (const bet of bets) {
    const u = runners.find((r) => r.number === bet.runnerNo);
    const div = bet.betType === 'win' ? u.win_dividend : u.place_dividend;
    if (div) {
      assert.equal(bet.status, 'won');
      assert.equal(bet.payout, Math.round(bet.stake * div * 100) / 100);
    } else {
      assert.equal(bet.status, 'lost');
      assert.equal(bet.payout, 0);
    }
  }
  const winners = runners.filter((r) => r.win_dividend);
  assert.equal(winners.length, 1);
  assert.equal(runners.filter((r) => r.place_dividend).length, race.placesPaid);

  const me = await balance();
  assert.equal(Math.round(me * 100), Math.round((480 + bets.reduce((s, x) => s + x.payout, 0)) * 100));
  assert.equal(settleHorseBets(db), 0, 'never pays twice');
});

test('master withdraws a runner (refund), abandons a race (refund) and enters a result by hand', async () => {
  const races = (await bob('/api/races')).body.races.filter((r) => r.placesPaid > 0);
  const [r1, r2, r3] = races;
  const start = await balance();

  const pick = (r) => r.runners.filter((u) => !u.withdrawn);
  await bob('/api/horse-bets', { raceId: r1.id, runnerNo: pick(r1)[0].number, betType: 'win', stake: 20 });
  await bob('/api/horse-bets', { raceId: r2.id, runnerNo: pick(r2)[0].number, betType: 'place', stake: 30 });
  await bob('/api/horse-bets', { raceId: r3.id, runnerNo: pick(r3)[0].number, betType: 'win', stake: 40 });
  await bob('/api/horse-bets', { raceId: r3.id, runnerNo: pick(r3)[1].number, betType: 'win', stake: 10 });
  assert.equal(await balance(), start - 100);

  const w = await boss(`/api/admin/races/${r1.id}/runners/${pick(r1)[0].number}/withdraw`, {});
  assert.equal(w.body.settledBets, 1);
  assert.equal((await bob('/api/horse-bets', { raceId: r1.id, runnerNo: pick(r1)[0].number, betType: 'win', stake: 1 })).status, 400);

  assert.equal((await boss(`/api/admin/races/${r2.id}/abandon`, {})).body.settledBets, 1);
  assert.equal(await balance(), start - 50);

  // Manual result: first pick wins at 3.40, a dead-heat style second winner is not needed here.
  const result = pick(r3).map((u, i) => ({ number: u.number, position: i + 1, winDividend: i === 0 ? 3.4 : null, placeDividend: i < 2 ? 1.5 : null }));
  assert.equal((await boss(`/api/admin/races/${r3.id}/result`, { runners: [] })).status, 400);
  const res = await boss(`/api/admin/races/${r3.id}/result`, { runners: result });
  assert.equal(res.body.settledBets, 2);
  assert.equal(await balance(), start - 50 + 136);
  assert.equal((await boss(`/api/admin/races/${r3.id}/abandon`, {})).status, 404, 'settled races are locked');

  // The statement still adds up to the balance.
  const tx = (await bob('/api/transactions')).body.transactions;
  assert.equal(Math.round(tx.reduce((s, t) => s + t.amount, 0) * 100), Math.round((await balance()) * 100));
  assert.ok(tx.some((t) => t.horseBetId && t.type === 'refund'));
});

test('no place betting on small fields', async () => {
  const id = 'tiny';
  db.prepare("INSERT INTO races (id, meeting, race_no, post_time, places_paid) VALUES (?, 'Nicosia', 1, ?, 0)")
    .run(id, new Date(clock + 3600 * 1000).toISOString());
  db.prepare("INSERT INTO runners (race_id, number, horse, win_price) VALUES (?, 1, 'Solo', 2.0)").run(id);
  assert.equal((await bob('/api/horse-bets', { raceId: id, runnerNo: 1, betType: 'place', stake: 5 })).status, 400);
  assert.equal((await bob('/api/horse-bets', { raceId: id, runnerNo: 1, betType: 'each_way', stake: 5 })).status, 400);
  assert.equal((await bob('/api/horse-bets', { raceId: id, runnerNo: 1, betType: 'win', stake: 5 })).status, 201);
});
