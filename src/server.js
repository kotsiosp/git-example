'use strict';

const config = require('./config');
const { open } = require('./db');
const { createApp, ensureAdmin } = require('./app');
const { createOddsService } = require('./odds');
const { settleAll } = require('./settle');
const { createRacingService, settleHorseBets } = require('./racing');
const { createNrcProvider } = require('./racingNrc');

const db = open(config.dbFile);
const created = ensureAdmin(db, config);
if (created) {
  console.log(`Created master account "${created.username}".`);
  if (created.password) console.log(`  Generated password: ${created.password}  (change it after logging in)`);
}

const odds = createOddsService(db, config);
console.log(`Odds feed: ${odds.mode === 'live' ? 'LIVE (The Odds API)' : 'DEMO (set ODDS_API_KEY for live odds)'}`);

async function oddsTick() {
  await odds.refreshOdds();
}
async function scoresTick() {
  await odds.refreshScores();
  const n = settleAll(db);
  if (n) console.log(`Settled ${n} bet(s)`);
}
const safe = (fn) => () => fn().catch((err) => console.error(err));

console.log(`Football results: ${{ 'football-data': 'football-data.org (free)', 'odds-api': 'The Odds API (uses credits)', manual: 'entered by the master', demo: 'DEMO' }[odds.resultsSource]}`);

// Demo fixtures cost nothing, so they refresh every few minutes. Live checks are free; credits are
// only spent when a league's prices are due.
const oddsEvery = (odds.mode === 'demo' ? 5 : config.oddsCheckMinutes) * 60 * 1000;
const scoresEvery = (odds.mode === 'demo' ? 5 : config.scoresRefreshMinutes) * 60 * 1000;
safe(async () => { await oddsTick(); await scoresTick(); })();
setInterval(safe(oddsTick), oddsEvery);
setInterval(safe(scoresTick), scoresEvery);

const racingProvider = config.racingSource === 'nrc' ? createNrcProvider(config) : undefined;
const racing = config.racingEnabled ? createRacingService(db, config, { provider: racingProvider }) : null;
if (racing) {
  console.log(`Racing feed: ${racing.mode === 'nrc' ? `Racing NRC (${config.nrcTracks.join(', ')})` : 'DEMO (set RACING_SOURCE=nrc for Racing NRC)'}`);
  const racingTick = async () => {
    await racing.refresh();
    const n = settleHorseBets(db);
    if (n) console.log(`Settled ${n} horse bet(s)`);
  };
  safe(racingTick)();
  setInterval(safe(racingTick), config.racingRefreshSeconds * 1000);
}

const app = createApp({ db, config, odds, racing });
app.listen(config.port, () => console.log(`${config.siteName} listening on http://localhost:${config.port}`));
