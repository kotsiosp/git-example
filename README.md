# PlayBet — play-money football betting

A private football betting site for friends, using **play money only**. One master account opens player
accounts, sets their usernames and passwords, and gives them credits. Players bet on real matches at **live
bookmaker odds**, and bets settle automatically from real results.

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
- No API key yet? The site runs with **demo fixtures** so you can try everything.

## Run locally

Needs Node.js 22.13 or newer.

```bash
npm install
ADMIN_PASSWORD=secret123 npm start      # http://localhost:3000, log in as admin / secret123
npm test
```

## Put it on your own domain

1. **Buy a domain** from any registrar (Namecheap, Cloudflare, Porkbun, GoDaddy…).
2. **Rent a small Linux server** (Hetzner, DigitalOcean, Linode…; about $5/month, 1 GB RAM is plenty) and
   [install Docker](https://docs.docker.com/engine/install/).
3. In the registrar's DNS settings, add an **A record** for `@` (and one for `www`) pointing at the server's IP address.
4. On the server:
   ```bash
   git clone <this repo> playbet && cd playbet
   cp .env.example .env
   nano .env            # set DOMAIN, ADMIN_PASSWORD and ODDS_API_KEY
   docker compose up -d --build
   ```
   Caddy gets a free HTTPS certificate automatically. Open `https://yourdomain.com` and log in as the master.

To update later: `git pull && docker compose up -d --build`. All data is kept in the `playbet-data` Docker volume
(back it up with `docker compose cp app:/app/data ./backup`).

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
src/settle.js    result → bet settlement
src/db.js        SQLite schema (built into Node, no native modules)
public/          single-page frontend (no build step)
test/            node:test suite
```
