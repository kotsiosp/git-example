'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createRacingService } = require('../src/racing');

test('with football switched off, only horse racing is offered', async () => {
  const config = { ...require('../src/config'), adminUsername: 'boss', adminPassword: 'boss-pass' };
  const db = open(':memory:');
  ensureAdmin(db, config);
  const racing = createRacingService(db, config, { log: { error() {} } });
  await racing.refresh();
  const server = createApp({ db, config, odds: null, racing }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  try {
    const cfg = (await call('/api/config')).body;
    assert.equal(cfg.oddsMode, null);
    assert.equal(cfg.racingMode, 'demo');

    await call('/api/login', { username: 'boss', password: 'boss-pass' });
    assert.equal((await call('/api/admin/status')).status, 200);
    assert.equal((await call('/api/admin/refresh', {})).status, 200);
    assert.equal((await call('/api/admin/events/pending')).status, 404);
    await call('/api/admin/users', { username: 'eleni', password: 'secret1', initialCredit: 100 });

    await call('/api/login', { username: 'eleni', password: 'secret1' });
    assert.equal((await call('/api/events')).status, 404);
    assert.equal((await call('/api/bets', { mode: 'single', stake: 5, selections: [] })).status, 404);
    assert.deepEqual((await call('/api/bets')).body.bets, [], 'my bets still loads');
    const race = (await call('/api/races')).body.races[0];
    const runner = race.runners.find((u) => !u.withdrawn);
    const bet = await call('/api/horse-bets', { raceId: race.id, runnerNo: runner.number, betType: 'win', stake: 5 });
    assert.equal(bet.status, 201);
    assert.equal(bet.body.balance, 95);
  } finally {
    server.close();
  }
});
