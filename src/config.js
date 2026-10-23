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
  oddsMarkets: process.env.ODDS_MARKETS || 'h2h,totals', // each market costs 1 credit per refresh
  // Four leagues fit The Odds API's free plan (500 credits a month) with the schedule below.
  leagues: list(process.env.LEAGUES, 'soccer_epl,soccer_spain_la_liga,soccer_italy_serie_a,soccer_uefa_champs_league'),
  // How often to check whether a league's prices are due (checks are free). Prices are refreshed
  // daily when a league plays within a week, every 8h on the day before, every 2h in the last 3h.
  oddsCheckMinutes: Number(process.env.ODDS_CHECK_MINUTES || 60),
  oddsFallbackHours: Number(process.env.ODDS_FALLBACK_HOURS || 12), // used if the fixture list ever costs credits
  oddsReserveCredits: Number(process.env.ODDS_RESERVE_CREDITS || 20),
  scoresRefreshMinutes: Number(process.env.SCORES_REFRESH_MINUTES || 30),

  // Free automatic results from football-data.org (https://www.football-data.org). Without a key the
  // master enters scores on the Settlement page, unless ODDS_API_SCORES=true (costs 2 credits per check).
  footballDataKey: process.env.FOOTBALL_DATA_KEY || '',
  oddsApiScores: process.env.ODDS_API_SCORES === 'true',
  footballDataBase: process.env.FOOTBALL_DATA_BASE || 'https://api.football-data.org/v4',

  // Cyprus horse racing: 'nrc' reads Racing NRC (racingnrc.com.cy); 'demo' simulates races.
  racingEnabled: process.env.RACING_ENABLED !== 'false',
  racingSource: process.env.RACING_SOURCE || 'demo',
  racingRefreshSeconds: Number(process.env.RACING_REFRESH_SECONDS || 60),
  nrcDbUrl: process.env.NRC_DB_URL || 'https://nicosia-rc.europe-west1.firebasedatabase.app',
  nrcTracks: list(process.env.NRC_TRACKS, 'CY-NICOSIA-TH'),
  nrcTimeZone: process.env.NRC_TIME_ZONE || 'Asia/Nicosia',
  // Days the feed is read (Cyprus racing is on Wednesdays and Sundays); add a day for an extra meeting.
  nrcRaceDays: list(process.env.NRC_RACE_DAYS, 'wed,sun').map((d) => d.toLowerCase().slice(0, 3)),
  // Nicosia pays the first two places.
  nrcPlacesPaid: Number(process.env.NRC_PLACES_PAID || 2),

  minStake: Number(process.env.MIN_STAKE || 1),
  maxStake: Number(process.env.MAX_STAKE || 10000),
  maxLegs: Number(process.env.MAX_LEGS || 12),
};
