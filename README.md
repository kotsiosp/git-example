# PlayBet — play-money football betting

A private football betting site for friends, using **play money only**. One master account opens player
accounts, sets their usernames and passwords, and gives them credits. Players bet on real matches at **live
bookmaker odds**, and bets settle automatically from real results.

> **Currently horse racing only.** Football betting is built but switched off (`FOOTBALL_ENABLED=false`).
> Set `FOOTBALL_ENABLED=true` to bring back the Football and Results tabs; nothing else needs to change.

## Features

- **Master account:** open accounts (username + password + opening credit), credit or debit balances, reset
  passwords, disable accounts, see every bet, check each player's statement, and settle or void matches by hand.
- **Players:** match list by day and league with 1X2 and Over/Under 2.5 goals, singles and accumulators, my bets,
  statement and results.
- **Live odds** from [The Odds API](https://the-odds-api.com), which collects prices from real bookmakers (Pinnacle,
  Bet365, William Hill, Unibet…). By default the site shows the average across bookmakers; set `ODDS_BOOKMAKER` to
  copy one bookmaker instead.
- **Safe bet slip:** the odds are fixed when the bet is placed. If a price moves before the player confirms, the
  slip shows the new price and the player must accept it. Betting on a match closes at kick-off.
- **Auto-settlement:** final scores come from the same API. A match with no result (for example, postponed) shows up
  on the master's *Settlement* page, where it can be settled or voided.
- **Ledger:** every credit, bet, payout and refund is recorded, and the balance always equals the sum of the ledger.
- **Cyprus horse racing:** race cards with live tote prices, and Win, Place and Each-way bets that pay the official
  final dividend, like at the track. Withdrawn horses and abandoned races are refunded. See below.
- No API key yet? The site runs with **demo fixtures** so you can try everything.

## Run locally

Needs Node.js 22.13 or newer.

```bash
npm install
ADMIN_PASSWORD=secret123 npm start      # http://localhost:3000, log in as admin / secret123
npm test
```

## Put it online

**Step-by-step guide for a rented Ubuntu server (e.g. servers.guru): [docs/SERVER-SETUP.md](docs/SERVER-SETUP.md).**
`scripts/setup-server.sh` installs Docker, a firewall and automatic security updates, starts the site behind Caddy
(automatic HTTPS), and switches on two timers:

- **`playbet-update.timer`** checks GitHub every 5 minutes and rebuilds the site when there is new code
  (`scripts/update.sh`). A version that fails to build is not installed, and the old one keeps running.
- **`playbet-backup.timer`** copies the database every night at 03:30 to `/opt/playbet-backups`, keeping 14 days
  (`scripts/backup.sh`).

The site works without buying a domain: a free name from duckdns.org (or `<ip-with-dashes>.sslip.io`) gets a real
HTTPS certificate too.

## Live odds and API costs

Sign up at [the-odds-api.com](https://the-odds-api.com) and put the key in `ODDS_API_KEY`.

| Call | Cost | When |
| --- | --- | --- |
| Odds for one league | 2 credits (1X2 + totals, 1 region) | every `ODDS_REFRESH_MINUTES`, for each league in `LEAGUES` |
| Scores for one league | 2 credits | every `SCORES_REFRESH_MINUTES`, **only** for leagues with bets waiting to settle |

With the default 6 leagues refreshing hourly, odds use about 8,600 credits a month. That fits the **20K plan
(about $30/month)**. To stay on the **free plan (500/month)**, use 1–2 leagues and refresh every 6–12 hours.
For example, `LEAGUES=soccer_epl` with `ODDS_REFRESH_MINUTES=360` uses about 240 credits a month. The *Odds feed*
page shows how many credits are left and has a "refresh now" button.

Other league keys include `soccer_greece_super_league`, `soccer_uefa_europa_league`, `soccer_efl_champ`,
`soccer_netherlands_eredivisie` and `soccer_portugal_primeira_liga`. See the
[full list](https://the-odds-api.com/sports-odds-data/sports-apis.html).

## Horse racing (Cyprus)

Players see each race card with the horses, jockeys, weights, draw and form, plus the live **Win** and **Place**
tote prices. Prices refresh every 30 seconds and freeze at the off.

- **Tote rules:** the price shown is only a guide. Winning bets are paid the **official final dividend** (per 1
  credit, stake included), which can be higher or lower than the price when the bet was placed.
- **Place terms:** 1st–2nd for 5–7 runners, 1st–3rd for 8 or more, and no place betting below 5 runners.
- **Each way:** one Win bet plus one Place bet of the same stake.
- **More bets** (on each race, for the pools Racing NRC offers there): **Forecast** (1st and 2nd in order), **Twin**
  (first two, any order), **Omni** (two horses both in the top 3), **Trio** (top 3 in order) and **Tetracast** (top 4
  in order). They can be played **Straight** (one or more horses per place), **Reverse** (Forecast both ways),
  **Box** (every order of the chosen horses) or with a **Banker**. Each combination costs the unit stake and pays the
  official dividend for that pool; combinations with a withdrawn horse are refunded, as is a pool with no published
  result.
- **Parlay:** one horse (win or place) in each of 2 or more races; the dividends multiply. A withdrawn horse counts
  as 1.00 and a losing leg loses the parlay.
- **Withdrawn horse or abandoned race:** the stake is refunded.
- **Master *Racing* page:** enter a result and its dividends by hand, withdraw a horse, or abandon a race.

**Data source:** set `RACING_SOURCE=nrc` to use **Racing NRC** (racingnrc.com.cy). The site then reads the Nicosia
race cards, runners, live Win/Place tote prices, results and official dividends from the GlobalTote database behind
their website. Only Cyprus races are read (`NRC_TRACKS=CY-NICOSIA-TH`), and only on race days, Wednesday and Sunday
(`NRC_RACE_DAYS=wed,sun`). On other days it makes no requests at all. It reads whole tracks rather than single races
and fetches each race's dividends once, after they are confirmed. Nicosia pays two places (`NRC_PLACES_PAID=2`).

This is not a documented public API: Racing NRC can change or close it without notice. If that happens, races stop
updating and the master can still settle bets from the *Racing* page. Without `RACING_SOURCE=nrc` the site runs
simulated demo races. Set `RACING_ENABLED=false` to hide horse racing entirely.

## Master log (for disputes)

The master's **Log** page records everything that happens, in order, with the server's time to the second:

- **Bets:** who, what, the stake, the prices on screen at that moment, how long before the off, and the device's
  internet address.
- **Results:** the finishing order and every dividend, and whether it came from the Racing NRC feed or was entered
  by the master. Withdrawals and abandoned races are logged too.
- **Settlements:** every bet's outcome and what was paid.
- **Accounts:** accounts opened, credits added or removed, passwords reset, accounts disabled.
- **Logins**, including failed attempts.

It can be filtered by player and type, searched, and downloaded as a CSV spreadsheet. Entries cannot be edited or
deleted, not even directly in the database. Each entry also carries a fingerprint (SHA-256) of the one before it,
so **Check log is intact** shows whether anything was changed in the database file behind the site's back.

## How bets settle

- **1X2:** decided on the final score reported by the results feed.
- **Over/Under 2.5:** total goals.
- **Accumulator:** every leg must win. A voided leg counts as odds 1.00.
- **Void match:** single bets are refunded in full.

## Project layout

```
src/server.js    startup, background refresh timers
src/app.js       HTTP API (auth, betting, admin)
src/odds.js      The Odds API client + demo feed
src/settle.js    result → football bet settlement
src/racing.js    horse racing service, demo feed + tote settlement
src/racingNrc.js Racing NRC feed (Nicosia cards, prices, dividends)
src/racingRoutes.js  horse racing API
src/db.js        SQLite schema (built into Node, no native modules)
public/          single-page frontend (no build step)
test/            node:test suite
```
