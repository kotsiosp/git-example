'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { recordResult, settleHorseBets } = require('../src/racing');
const { expand, comboFromFeed } = require('../src/tote');

test('box, reverse, banker and straight selections expand to the right combinations', () => {
  assert.deepEqual(expand('EXACTA', 'reverse', { horses: [3, 7] }), ['3-7', '7-3']);
  assert.equal(expand('TRIFECTA', 'box', { horses: [1, 2, 3, 4] }).length, 24);
  assert.equal(expand('SUPERFECTA', 'box', { horses: [1, 2, 3, 4, 5] }).length, 120);
  assert.deepEqual(expand('QUINELLA', 'box', { horses: [5, 2, 9] }), ['2-5', '5-9', '2-9']);
  assert.deepEqual(expand('SWINGER', 'banker', { banker: 4, with: [1, 6] }), ['1-4', '4-6']);
  assert.deepEqual(expand('EXACTA', 'banker', { banker: 4, with: [1, 6] }), ['4-1', '4-6']);
  assert.equal(expand('TRIFECTA', 'banker', { banker: 1, with: [2, 3, 4] }).length, 6);
  // Any of 1/2 first, any of 2/3 second: 1-2, 1-3, 2-3 (2-2 is impossible).
  assert.deepEqual(expand('EXACTA', 'straight', { positions: [[1, 2], [2, 3]] }), ['1-2', '1-3', '2-3']);
  assert.throws(() => expand('TRIFECTA', 'box', { horses: [1, 2] }), /at least 3/);
  assert.throws(() => expand('QUINELLA', 'reverse', { horses: [1, 2] }), /reverse/);
  assert.throws(() => expand('SUPERFECTA', 'box', { horses: [1, 2, 3, 4, 5, 6, 7, 8] }), /1680 combinations/);
});

test('feed combinations are normalised', () => {
  assert.equal(comboFromFeed('EXACTA', '6*9'), '6-9');
  assert.equal(comboFromFeed('QUINELLA', '9*6'), '6-9');
  assert.equal(comboFromFeed('SWINGER', '6*3'), '3-6');
  assert.equal(comboFromFeed('TRIFECTA', '6*9*3'), '6-9-3');
});

// ------------------------------------------------------------ through the API

const config = { ...require('../src/config'), adminUsername: 'boss', adminPassword: 'boss-pass' };
let db; let server; let base;
const t0 = Date.parse('2026-10-25T10:00:00Z');
let clock = t0;

function client() {
  let cookie = '';
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
const boss = client();
const kostas = client();
const balance = async () => (await kostas('/api/me')).body.user.balance;

function addRace(no, runners = 8, pools = ['EXACTA', 'QUINELLA', 'SWINGER', 'TRIFECTA', 'SUPERFECTA']) {
  const id = `R${no}`;
  db.prepare("INSERT INTO races (id, meeting, race_no, post_time, places_paid, pools) VALUES (?, 'Nicosia', ?, ?, 2, ?)")
    .run(id, no, new Date(t0 + no * 3600 * 1000).toISOString(), JSON.stringify(pools));
  for (let n = 1; n <= runners; n++) {
    db.prepare('INSERT INTO runners (race_id, number, horse, win_price, place_price) VALUES (?, ?, ?, ?, ?)').run(id, n, `Horse ${no}.${n}`, 2 + n, 1.2 + n / 10);
  }
  return id;
}

before(async () => {
  db = open(':memory:');
  ensureAdmin(db, config);
  server = createApp({ db, config, odds: null, racing: { mode: 'nrc', refresh: async () => ({}) }, now: () => clock }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (let no = 1; no <= 4; no++) addRace(no);
  addRace(5, 6, ['QUINELLA']);
  await boss('/api/login', { username: 'boss', password: 'boss-pass' });
  await boss('/api/admin/users', { username: 'kostas', password: 'secret1', initialCredit: 1000 });
  await kostas('/api/login', { username: 'kostas', password: 'secret1' });
});
after(() => server.close());

const bet = (body) => kostas('/api/horse-tickets', body);

test('exotic bets: costs, payouts, dead heats, withdrawals and unpublished pools', async () => {
  // Trio box of 4 = 24 combinations at 1 each.
  const box = await bet({ kind: 'exotic', raceId: 'R1', pool: 'TRIFECTA', mode: 'box', selections: { horses: [1, 2, 3, 4] }, unitStake: 1 });
  assert.equal(box.status, 201);
  assert.equal(box.body.balance, 976);
  // Reverse forecast 2 x 5 = 10; Omni banker 3 with 5 and 6 = 2 x 5 = 10.
  await bet({ kind: 'exotic', raceId: 'R1', pool: 'EXACTA', mode: 'reverse', selections: { horses: [2, 1] }, unitStake: 5 });
  await bet({ kind: 'exotic', raceId: 'R1', pool: 'SWINGER', mode: 'banker', selections: { banker: 3, with: [5, 6] }, unitStake: 5 });
  // Twin straight on 6 and 7, which will not place.
  await bet({ kind: 'exotic', raceId: 'R1', pool: 'QUINELLA', mode: 'straight', selections: { positions: [[6], [7]] }, unitStake: 10 });
  // Tetracast with a horse that gets withdrawn.
  await bet({ kind: 'exotic', raceId: 'R1', pool: 'SUPERFECTA', mode: 'straight', selections: { positions: [[1], [2], [8], [4]] }, unitStake: 3 });
  assert.equal(await balance(), 976 - 10 - 10 - 10 - 3);

  // Refusals.
  assert.equal((await bet({ kind: 'exotic', raceId: 'R5', pool: 'EXACTA', mode: 'reverse', selections: { horses: [1, 2] }, unitStake: 1 })).status, 400,
    'pool not offered on that race');
  assert.equal((await bet({ kind: 'exotic', raceId: 'R1', pool: 'EXACTA', mode: 'reverse', selections: { horses: [1, 99] }, unitStake: 1 })).status, 400);
  assert.equal((await bet({ kind: 'exotic', raceId: 'R1', pool: 'EXACTA', mode: 'reverse', selections: { horses: [1, 2] }, unitStake: 0.5 })).status, 400);
  assert.equal((await boss('/api/horse-tickets', { kind: 'exotic', raceId: 'R1', pool: 'EXACTA', mode: 'reverse', selections: { horses: [1, 2] }, unitStake: 1 })).status, 403);

  // Horse 8 is withdrawn; the result is 1-2-3-4 with a dead heat for 2nd in the Forecast pool,
  // and no Tetracast dividend is published.
  db.prepare("UPDATE runners SET withdrawn = 1 WHERE race_id = 'R1' AND number = 8").run();
  clock = t0 + 2 * 3600 * 1000;
  const res = await boss('/api/admin/races/R1/result', {
    runners: [{ number: 1, position: 1, winDividend: 3 }, { number: 2, position: 2 }, { number: 3, position: 3 }, { number: 4, position: 4 }],
    pools: { TRIFECTA: { '1-2-3': 42.5 }, EXACTA: { '1-2': 12.4, '1-3': 15 }, SWINGER: { '1-2': 2.1, '1-3': 3.2, '2-3': 4.4 }, QUINELLA: { '1-2': 6.6 } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settledBets, 5);

  const tickets = (await kostas('/api/horse-tickets')).body.tickets.reverse();
  const by = (pool) => tickets.find((t) => t.pool === pool);
  assert.equal(by('TRIFECTA').status, 'won');
  assert.equal(by('TRIFECTA').payout, 42.5);
  assert.equal(by('EXACTA').payout, 62, 'reverse forecast: only 1-2 paid, 5 x 12.40');
  assert.equal(by('SWINGER').status, 'lost', 'Omni 3 with 5 or 6: neither pair placed');
  assert.equal(by('QUINELLA').status, 'lost');
  assert.equal(by('SUPERFECTA').status, 'void', 'withdrawn horse and no published pool: refunded');
  assert.equal(by('SUPERFECTA').payout, 3);
  assert.equal(await balance(), 976 - 33 + 42.5 + 62 + 3);

  const race = (await kostas('/api/races/results')).body.races.find((r) => r.id === 'R1');
  assert.ok(race.dividends.some((d) => d.pool === 'TRIFECTA' && d.combo === '1-2-3' && d.dividend === 42.5));
});

test('parlays multiply the dividends; a withdrawn leg counts as 1.00 and a loser sinks it', async () => {
  clock = t0 + 90 * 60 * 1000; // after race 1, before race 2
  const start = await balance();
  const p1 = await bet({ kind: 'parlay', stake: 10, legs: [
    { raceId: 'R2', runnerNo: 1, betType: 'win' }, { raceId: 'R3', runnerNo: 2, betType: 'place' }, { raceId: 'R4', runnerNo: 3, betType: 'win' }] });
  assert.equal(p1.status, 201);
  const p2 = await bet({ kind: 'parlay', stake: 5, legs: [{ raceId: 'R2', runnerNo: 2, betType: 'win' }, { raceId: 'R3', runnerNo: 2, betType: 'win' }] });
  assert.equal(p2.status, 201);
  assert.equal(await balance(), start - 15);
  assert.equal((await bet({ kind: 'parlay', stake: 5, legs: [{ raceId: 'R2', runnerNo: 1, betType: 'win' }] })).status, 400, 'needs 2 races');
  assert.equal((await bet({ kind: 'parlay', stake: 5, legs: [{ raceId: 'R2', runnerNo: 1, betType: 'win' }, { raceId: 'R2', runnerNo: 2, betType: 'win' }] })).status, 400,
    'one horse per race');

  clock = t0 + 5 * 3600 * 1000;
  const result = (raceId, first, second) => db.tx(() => recordResult(db, raceId, [
    { number: first, position: 1, winDividend: 4, placeDividend: 1.8 }, { number: second, position: 2, placeDividend: 2.5 }]));
  result('R2', 1, 5);
  settleHorseBets(db);
  let tickets = (await kostas('/api/horse-tickets')).body.tickets;
  assert.equal(tickets.find((t) => t.id === p2.body.ticketId).status, 'lost', 'first leg lost: settled straight away');
  assert.equal(tickets.find((t) => t.id === p1.body.ticketId).status, 'open');

  result('R3', 6, 2); // horse 2 placed at 2.50
  db.prepare("UPDATE runners SET withdrawn = 1 WHERE race_id = 'R4' AND number = 3").run();
  settleHorseBets(db);
  tickets = (await kostas('/api/horse-tickets')).body.tickets;
  const won = tickets.find((t) => t.id === p1.body.ticketId);
  assert.equal(won.status, 'won');
  assert.equal(won.payout, 100, '10 x 4.00 x 2.50 x 1.00');
  assert.deepEqual(won.legs.map((l) => l.result), ['won', 'won', 'void']);
  assert.equal(await balance(), start - 15 + 100);

  // The statement still adds up.
  const tx = (await kostas('/api/transactions')).body.transactions;
  assert.equal(Math.round(tx.reduce((s, t) => s + t.amount, 0) * 100), Math.round((await balance()) * 100));
  assert.ok(tx.some((t) => t.horseTicketId === p1.body.ticketId && t.type === 'payout'));
});
