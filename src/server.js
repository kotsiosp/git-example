'use strict';

const config = require('./config');
const { open } = require('./db');
const { createApp, ensureAdmin } = require('./app');
const { createOddsService } = require('./odds');
const { settleAll } = require('./settle');

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

// Demo fixtures cost nothing, so they refresh every few minutes.
const oddsEvery = (odds.mode === 'demo' ? 5 : config.oddsRefreshMinutes) * 60 * 1000;
const scoresEvery = (odds.mode === 'demo' ? 5 : config.scoresRefreshMinutes) * 60 * 1000;
safe(async () => { await oddsTick(); await scoresTick(); })();
setInterval(safe(oddsTick), oddsEvery);
setInterval(safe(scoresTick), scoresEvery);

const app = createApp({ db, config, odds });
app.listen(config.port, () => console.log(`${config.siteName} listening on http://localhost:${config.port}`));
