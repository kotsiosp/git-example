'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createRacingService, settleHorseBets } = require('../src/racing');
const { createNrcProvider, localDateKey, shortName } = require('../src/racingNrc');

// Made-up data in the same shape as the Racing NRC feed.
const DATE = '20261021';
const TRACK = 'CY-NICOSIA-TH';
const POOLS = { 'ext|TO|WIN|EUR': { enabled: true }, 'ext|TO|PLACE|EUR': { enabled: true } };

function feed() {
  const runner = (n, horse, extra = {}) => ({ programNo: String(n), horseName: horse, jockeyName: `J${n}`, trainerName: `T${n}`,
    carriedWeight: 55 + n, barrierPos: n, scrached: false, scratchType: 'NONE', ...extra });
  return {
    raceDetails: {
      R_1: { postTime: '2026-10-21T15:30:00+0300', status: 'OPEN', cancelled: false, trackName: 'Nicosia', distance: 1200,
        raceName: 'Mixed Race In Class 3 For Thoroughbred Horses. Free Handicap.', tenantPools: POOLS },
      R_2: { postTime: '2026-10-21T16:00:00+0300', status: 'OPEN', cancelled: false, trackName: 'Nicosia', distance: 1000,
        raceName: 'Maiden Race', tenantPools: { 'ext|TO|WIN|EUR': { enabled: true } } },
    },
    tripDetails: {
      R_1: { S_1: runner(1, 'Akamas Wind'), S_2: runner(2, 'Blue Lagoon'), S_3: runner(3, 'Kantara'),
        S_4: runner(4, 'Meltemi', { scrached: true, scratchType: 'LATE' }), S_5: runner(5, 'Cape Greco'), S_6: runner(6, 'Petra') },
      R_2: { S_1: runner(1, 'Solo'), S_2: runner(2, 'Duo') },
    },
    timedDetails: {
      R_1: { 'ext|TO|WIN|EUR': { odds: [null, 3.1, 4.7, 6.2, 0, 9.5, 12] }, 'ext|TO|PLACE|EUR': { odds: [null, 1.4, 1.8, 2.1, 0, 2.9, 3.3] } },
    },
    poolDetails: {
      R_1: {
        'ext|TO|WIN|EUR': { poolType: 'WIN', status: 'RESULTED', resultConfirmed: true, payoff: { 2: 4.9 } },
        // The feed sends small numeric keys as an array indexed by programme number.
        'ext|TO|PLACE|EUR': { poolType: 'PLACE', status: 'RESULTED', resultConfirmed: true, payoff: [null, null, 2.7, null, null, 4.6] },
      },
    },
  };
}

function fakeFetch(data, calls) {
  return async (url) => {
    const m = String(url).match(/scheduleData\/(\d{8})\/(\w+)\/([\w-]+)(?:\/(R_\d+))?\.json$/);
    calls.push(String(url));
    let body = null;
    if (m && m[1] === DATE && m[3] === TRACK) {
      body = data[m[2]] ?? null;
      if (body && m[4]) body = body[m[4]] ?? null;
    }
    return new Response(JSON.stringify(body));
  };
}

const config = { nrcDbUrl: 'https://example.firebasedatabase.app', nrcTracks: [TRACK], nrcTimeZone: 'Asia/Nicosia',
  nrcRaceDays: ['wed', 'sun'], nrcPlacesPaid: 2 };

test('only Wednesday and Sunday are read; other days make no requests', async () => {
  const calls = [];
  // Thursday 22 Oct to Saturday 24 Oct: no race day in the window.
  const quiet = createNrcProvider(config, { fetchImpl: fakeFetch(feed(), calls), now: () => Date.parse('2026-10-22T09:00:00Z') });
  assert.deepEqual(await quiet.fetchCards(), []);
  assert.equal(calls.length, 0);
  // Friday 23 Oct: the window reaches Sunday 25 Oct, which is read.
  const friday = createNrcProvider(config, { fetchImpl: fakeFetch(feed(), calls), now: () => Date.parse('2026-10-23T09:00:00Z') });
  await friday.fetchCards();
  assert.deepEqual(calls.map((u) => u.match(/scheduleData\/(\d{8})/)[1]), ['20261025']);
});

test('race day key uses Cyprus time', () => {
  assert.equal(localDateKey(Date.parse('2026-10-20T22:30:00Z'), 'Asia/Nicosia'), '20261021');
  assert.equal(localDateKey(Date.parse('2026-10-20T20:30:00Z'), 'Asia/Nicosia'), '20261020');
});

test('long Cyprus race conditions are shortened to the first sentence', () => {
  assert.equal(shortName('Mixed Race In Class 3 For Thoroughbred Horses. Free Handicap.'), 'Mixed Race In Class 3 For Thoroughbred Horses');
  assert.ok(shortName('x'.repeat(200)).length <= 70);
});

test('cards, live prices, withdrawals, results and dividends from the Racing NRC feed', async () => {
  const data = feed();
  const calls = [];
  let t = Date.parse('2026-10-21T10:00:00Z'); // 13:00 in Nicosia, before race 1
  const provider = createNrcProvider(config, { fetchImpl: fakeFetch(data, calls), now: () => t });

  const cards = await provider.fetchCards();
  assert.equal(cards.length, 2);
  const [r1, r2] = cards;
  assert.equal(r1.id, `${DATE}~${TRACK}~01`);
  assert.equal(r1.postTime, '2026-10-21T12:30:00.000Z');
  assert.equal(r1.meeting, 'Nicosia');
  assert.equal(r1.distance, '1200m');
  assert.equal(r1.placesPaid, 2, 'Nicosia pays two places');
  assert.equal(r2.placesPaid, 0, 'no place pool on race 2');
  assert.deepEqual(r1.runners.map((u) => [u.number, u.winPrice, u.placePrice, u.withdrawn]),
    [[1, 3.1, 1.4, false], [2, 4.7, 1.8, false], [3, 6.2, 2.1, false], [4, null, null, true], [5, 9.5, 2.9, false], [6, 12, 3.3, false]]);
  assert.equal(r2.runners[0].winPrice, null, 'no prices yet');
  // One request per section for the whole track, plus empty checks for the next two days.
  assert.equal(calls.filter((u) => u.includes(DATE)).length, 3);

  // Store through the racing service, bet, then the feed publishes the result.
  const db = open(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash, role, balance) VALUES (1, 'p', 'x', 'user', 10000)").run();
  const service = createRacingService(db, config, { provider, now: () => t, log: { error() {} } });
  await service.refresh();
  const bet = (no, type) => db.prepare(`INSERT INTO horse_bets (user_id, race_id, runner_no, bet_type, stake) VALUES (1, ?, ?, ?, 1000)`)
    .run(r1.id, no, type);
  bet(2, 'win'); bet(5, 'place'); bet(1, 'win'); bet(4, 'win');
  assert.equal(settleHorseBets(db), 1, 'bet on the withdrawn horse is refunded straight away');

  t = Date.parse('2026-10-21T12:35:00Z'); // race 1 is off, no result yet
  await service.refresh();
  assert.equal(settleHorseBets(db), 0);

  data.raceDetails.R_1.status = 'RESULTED';
  data.raceDetails.R_1.finishingOrder = ['2', '5', '1', '3'];
  t += 10 * 60 * 1000;
  await service.refresh();
  assert.equal(settleHorseBets(db), 3);
  const paid = db.prepare('SELECT runner_no, bet_type, status, dividend, payout FROM horse_bets ORDER BY id').all()
    .map((b) => ({ ...b }));
  assert.deepEqual(paid, [
    { runner_no: 2, bet_type: 'win', status: 'won', dividend: 4.9, payout: 4900 },
    { runner_no: 5, bet_type: 'place', status: 'won', dividend: 4.6, payout: 4600 },
    { runner_no: 1, bet_type: 'win', status: 'lost', dividend: null, payout: 0 },
    { runner_no: 4, bet_type: 'win', status: 'void', dividend: null, payout: 1000 },
  ]);
  assert.equal(db.prepare("SELECT finish_pos FROM runners WHERE race_id = ? AND number = 5").get(r1.id).finish_pos, 2);
});

test('a cancelled race is abandoned and bets refunded', async () => {
  const data = feed();
  let t = Date.parse('2026-10-21T10:00:00Z');
  const provider = createNrcProvider(config, { fetchImpl: fakeFetch(data, []), now: () => t });
  const db = open(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash, role, balance) VALUES (1, 'p', 'x', 'user', 0)").run();
  const service = createRacingService(db, config, { provider, now: () => t, log: { error() {} } });
  await service.refresh();
  const id = `${DATE}~${TRACK}~02`;
  db.prepare("INSERT INTO horse_bets (user_id, race_id, runner_no, bet_type, stake) VALUES (1, ?, 1, 'win', 500)").run(id);
  data.raceDetails.R_2.cancelled = true;
  t = Date.parse('2026-10-21T13:05:00Z');
  await service.refresh();
  assert.equal(settleHorseBets(db), 1);
  assert.equal(db.prepare('SELECT status FROM races WHERE id = ?').get(id).status, 'abandoned');
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = 1').get().balance, 500);
});
