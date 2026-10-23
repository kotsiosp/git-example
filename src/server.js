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

const odds = config.footballEnabled ? createOddsService(db, config) : null;
const safe = (fn) => () => fn().catch((err) => console.error(err));
if (odds) {
  console.log(`Odds feed: ${odds.mode === 'live' ? 'LIVE (The Odds API)' : 'DEMO (set ODDS_API_KEY for live odds)'}`);
  const oddsTick = async () => {
    await odds.refreshOdds();
  };
  const scoresTick = async () => {
    await odds.refreshScores();
    const n = settleAll(db);
    if (n) console.log(`Settled ${n} bet(s)`);
  };
  // Demo fixtures cost nothing, so they refresh every few minutes.
  const oddsEvery = (odds.mode === 'demo' ? 5 : config.oddsRefreshMinutes) * 60 * 1000;
  const scoresEvery = (odds.mode === 'demo' ? 5 : config.scoresRefreshMinutes) * 60 * 1000;
  safe(async () => { await oddsTick(); await scoresTick(); })();
  setInterval(safe(oddsTick), oddsEvery);
  setInterval(safe(scoresTick), scoresEvery);
} else {
  console.log('Football: off (set FOOTBALL_ENABLED=true to turn it on)');
}

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
