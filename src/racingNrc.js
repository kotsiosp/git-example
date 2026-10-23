'use strict';

// Racing NRC feed: race cards, live tote prices and official dividends from the GlobalTote
// database behind racingnrc.com.cy. Data lives under scheduleData/<YYYYMMDD>/<section>/<track>,
// with races keyed R_<n> and runners keyed S_<programme number>.
//
// To stay light on their service it reads whole tracks (not single races), refreshes cards and
// runners only every few minutes, and fetches a race's dividends once, after the result is confirmed.

const DAY_MS = 86400 * 1000;

// The racing day in Cyprus, as the YYYYMMDD key the feed uses.
function localDateKey(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const weekdayOf = (dateKey) => WEEKDAYS[new Date(Date.UTC(+dateKey.slice(0, 4), +dateKey.slice(4, 6) - 1, +dateKey.slice(6, 8))).getUTCDay()];

// Cyprus race names are full entry conditions; keep the first sentence for the card.
function shortName(raceName) {
  if (!raceName) return null;
  const first = raceName.split(/\.\s/)[0].trim();
  return first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
}

const poolOf = (pools, type) => Object.values(pools || {}).find((p) => p && p.poolType === type)
  || pools?.[Object.keys(pools || {}).find((k) => k.split('|')[2] === type)];

// Prices and payoffs come as an object keyed by programme number, or (when the keys are small
// numbers) as an array indexed by it with index 0 unused; `x[String(n)]` reads both.
function priceFor(prices, number) {
  const odds = prices?.odds;
  const p = Array.isArray(odds) ? odds[number] : odds?.[String(number)];
  return typeof p === 'number' && p > 1 ? p : null;
}

const isWithdrawn = (r) => !!(r.scrached || r.scratched || (r.scratchType && r.scratchType !== 'NONE'));

function createNrcProvider(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const base = config.nrcDbUrl.replace(/\/$/, '');
  const cache = new Map();

  async function get(path, maxAgeMs) {
    const hit = cache.get(path);
    if (hit && now() - hit.at < maxAgeMs) return hit.data;
    const res = await fetchImpl(`${base}/scheduleData/${path}.json`);
    if (!res.ok) throw new Error(`Racing NRC ${path}: HTTP ${res.status}`);
    const data = await res.json();
    cache.set(path, { at: now(), data });
    return data;
  }

  const raceNo = (key) => Number(String(key).replace('R_', ''));
  const raceId = (date, track, no) => `${date}~${track}~${String(no).padStart(2, '0')}`;

  return {
    mode: 'nrc',

    async fetchCards() {
      const today = localDateKey(now(), config.nrcTimeZone);
      // Only Cyprus race days are read; on other days nothing is requested at all.
      const dates = [0, 1, 2].map((d) => localDateKey(now() + d * DAY_MS, config.nrcTimeZone))
        .filter((d) => config.nrcRaceDays.includes(weekdayOf(d)));
      const cards = [];
      for (const date of dates) {
        for (const track of config.nrcTracks) {
          // Today's card refreshes every call (status, cancellations); later days every 10 minutes.
          const races = await get(`${date}/raceDetails/${track}`, date === today ? 0 : 10 * 60 * 1000);
          if (!races) continue;
          const open = Object.entries(races).filter(([, r]) => r && !r.cancelled && Date.parse(r.postTime) > now());
          if (!open.length) continue;
          const runners = await get(`${date}/tripDetails/${track}`, 5 * 60 * 1000) || {};
          const prices = date === today ? await get(`${date}/timedDetails/${track}`, 0) || {} : {};
          for (const [key, r] of open) {
            const no = raceNo(key);
            const field = Object.values(runners[key] || {});
            const livePrices = prices[key] || {};
            const win = poolOf(livePrices, 'WIN');
            const place = poolOf(livePrices, 'PLACE');
            const hasPlacePool = Object.keys(r.tenantPools || {}).some((k) => k.split('|')[2] === 'PLACE');
            cards.push({
              id: raceId(date, track, no),
              meeting: r.trackName || track,
              raceNo: no,
              name: shortName(r.raceName),
              postTime: new Date(r.postTime).toISOString(),
              distance: r.distance ? `${r.distance}m` : null,
              // Shown to players as the place terms; settlement always follows the official place payout.
              placesPaid: hasPlacePool ? config.nrcPlacesPaid : 0,
              runners: field
                .map((u) => {
                  const number = Number(u.programNo);
                  return {
                    number,
                    horse: u.horseName,
                    jockey: u.jockeyName || null,
                    trainer: u.trainerName || null,
                    weight: u.carriedWeight ? `${u.carriedWeight}kg` : null,
                    draw: u.barrierPos || null,
                    form: null,
                    withdrawn: isWithdrawn(u),
                    winPrice: priceFor(win, number),
                    placePrice: priceFor(place, number),
                  };
                })
                .filter((u) => Number.isInteger(u.number) && u.horse)
                .sort((a, b) => a.number - b.number),
            });
          }
        }
      }
      return cards;
    },

    // Only races the feed marks as resulted (or cancelled) are looked up, each once.
    async fetchResults(raceIds) {
      const out = [];
      for (const id of raceIds) {
        const [date, track, no] = id.split('~');
        if (!date || !track || !no) continue;
        const races = await get(`${date}/raceDetails/${track}`, 60 * 1000);
        const race = races?.[`R_${Number(no)}`];
        if (!race) continue;
        if (race.cancelled) {
          out.push({ id, abandoned: true, runners: [] });
          continue;
        }
        if (race.status !== 'RESULTED') continue;
        const pools = await get(`${date}/poolDetails/${track}/R_${Number(no)}`, 60 * 1000);
        const win = poolOf(pools, 'WIN');
        if (!win?.resultConfirmed || !win.payoff) continue;
        const place = poolOf(pools, 'PLACE');
        const runners = await get(`${date}/tripDetails/${track}`, 5 * 60 * 1000) || {};
        const order = (race.finishingOrder || []).map(Number);
        const numbers = new Set([...Object.values(runners[`R_${Number(no)}`] || {}).map((u) => Number(u.programNo)),
          ...order, ...Object.keys(win.payoff).map(Number)]);
        const withdrawn = new Set(Object.values(runners[`R_${Number(no)}`] || {}).filter(isWithdrawn).map((u) => Number(u.programNo)));
        out.push({
          id,
          abandoned: false,
          runners: [...numbers].filter(Number.isInteger).map((n) => ({
            number: n,
            withdrawn: withdrawn.has(n),
            position: order.includes(n) ? order.indexOf(n) + 1 : null,
            winDividend: win.payoff[String(n)] ?? null,
            placeDividend: place?.payoff?.[String(n)] ?? null,
          })),
        });
      }
      return out;
    },
  };
}

module.exports = { createNrcProvider, localDateKey, shortName };
