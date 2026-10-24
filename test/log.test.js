'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createRacingService } = require('../src/racing');

test('the master log records what happened, cannot be changed, and detects tampering', async () => {
  const config = { ...require('../src/config'), adminUsername: 'boss', adminPassword: 'boss-pass' };
  let clock = Date.parse('2026-10-25T10:00:00Z');
  const db = open(':memory:');
  ensureAdmin(db, config);
  const racing = createRacingService(db, config, { now: () => clock, log: { error() {} } });
  await racing.refresh();
  const server = createApp({ db, config, odds: null, racing, now: () => clock }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (path, body) => {
      const res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      const text = await res.text();
      return { status: res.status, text, body: text.startsWith('{') ? JSON.parse(text) : null };
    };
  };
  const boss = client();
  const maria = client();
  try {
    await boss('/api/login', { username: 'boss', password: 'boss-pass' });
    const { user } = (await boss('/api/admin/users', { username: 'maria', password: 'secret1', initialCredit: 200 })).body;
    await boss(`/api/admin/users/${user.id}/credit`, { amount: 50, note: 'birthday' });
    await maria('/api/login', { username: 'maria', password: 'wrong' });
    await maria('/api/login', { username: 'maria', password: 'secret1' });

    const race = (await maria('/api/races')).body.races.find((r) => r.placesPaid);
    const runner = race.runners.find((u) => !u.withdrawn);
    await maria('/api/horse-bets', { raceId: race.id, runnerNo: runner.number, betType: 'win', stake: 10 });
    await maria('/api/horse-tickets', { kind: 'exotic', raceId: race.id, pool: 'EXACTA', mode: 'reverse',
      selections: { horses: race.runners.filter((u) => !u.withdrawn).slice(0, 2).map((u) => u.number) }, unitStake: 2 });

    assert.equal((await maria('/api/admin/log')).status, 403, 'players cannot read the log');

    // The race runs and the feed publishes the result.
    clock = Date.parse(race.postTime) + 9 * 60 * 1000;
    await racing.refresh();
    await boss('/api/admin/refresh', {});

    const { entries } = (await boss(`/api/admin/log?user=${user.id}`)).body;
    const actions = entries.map((e) => e.action).reverse();
    assert.deepEqual(actions.slice(0, 5), ['account_created', 'credit', 'login_failed', 'login', 'bet_placed']);
    const placed = entries.find((e) => e.action === 'bet_placed' && e.details.betType === 'win');
    assert.match(placed.summary, new RegExp(`maria placed bet #H\\d+: Win 10.00 on ${runner.number}\\. `));
    assert.equal(placed.details.priceShown, runner.winPrice);
    assert.ok(placed.details.secondsBeforeOff > 0);
    assert.equal(placed.details.postTime, race.postTime);
    assert.match(placed.ip, /127\.0\.0\.1$/);
    assert.match(entries.find((e) => e.action === 'credit').summary, /boss added 50.00 to maria \("birthday"\); balance now 250.00/);
    assert.equal(entries.filter((e) => e.action === 'bet_settled').length, 2, 'both bets settled and logged');

    const results = (await boss('/api/admin/log?type=results')).body.entries;
    assert.ok(results.some((e) => e.action === 'result_received' && e.details.raceId === race.id && /demo feed result/.test(e.summary)));

    const search = (await boss(`/api/admin/log?q=${encodeURIComponent('birthday')}`)).body.entries;
    assert.equal(search.length, 1);

    const csv = await boss('/api/admin/log.csv');
    assert.equal(csv.status, 200);
    assert.ok(csv.text.includes('"What happened"') && csv.text.includes('maria placed bet'));

    // The log is intact, cannot be changed through the database, and a change made by going around
    // the protection is detected.
    assert.deepEqual((await boss('/api/admin/log/verify')).body, { intact: true, count: db.prepare('SELECT COUNT(*) n FROM audit_log').get().n });
    assert.throws(() => db.prepare("UPDATE audit_log SET summary = 'nothing happened' WHERE id = 3").run(), /cannot be changed/);
    assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = 3').run(), /cannot be changed/);
    db.exec('DROP TRIGGER audit_log_no_update');
    db.prepare("UPDATE audit_log SET summary = 'nothing happened' WHERE id = 3").run();
    assert.deepEqual((await boss('/api/admin/log/verify')).body, { intact: false, count: 2, brokenAt: 3 });
  } finally {
    server.close();
  }
});
