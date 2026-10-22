'use strict';

const path = require('node:path');

function list(value, fallback) {
  return (value || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'playbet.db'),
  siteName: process.env.SITE_NAME || 'PlayBet',
  currency: process.env.CURRENCY_NAME || 'credits',

  // Master account, created on first start if no admin exists yet.
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // Set to true when running behind HTTPS (Caddy / a hosting platform).
  secureCookies: process.env.SECURE_COOKIES === 'true',
  sessionDays: Number(process.env.SESSION_DAYS || 14),

  // Live odds via https://the-odds-api.com. Without a key the site runs in demo mode.
  oddsApiKey: process.env.ODDS_API_KEY || '',
  oddsApiBase: process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4',
  oddsRegions: process.env.ODDS_REGIONS || 'eu',
  // Empty = average of all bookmakers; otherwise use this bookmaker key (e.g. pinnacle).
  oddsBookmaker: process.env.ODDS_BOOKMAKER || '',
  leagues: list(process.env.LEAGUES,
    'soccer_epl,soccer_spain_la_liga,soccer_italy_serie_a,soccer_germany_bundesliga,soccer_france_ligue_one,soccer_uefa_champs_league'),
  oddsRefreshMinutes: Number(process.env.ODDS_REFRESH_MINUTES || 60),
  scoresRefreshMinutes: Number(process.env.SCORES_REFRESH_MINUTES || 30),

  // Cyprus horse racing. Only the demo feed exists until the Racing NRC feed is connected.
  racingEnabled: process.env.RACING_ENABLED !== 'false',
  racingRefreshSeconds: Number(process.env.RACING_REFRESH_SECONDS || 60),

  minStake: Number(process.env.MIN_STAKE || 1),
  maxStake: Number(process.env.MAX_STAKE || 10000),
  maxLegs: Number(process.env.MAX_LEGS || 12),
};
