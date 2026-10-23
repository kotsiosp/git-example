'use strict';

// Exotic tote bets and parlays: which bets exist, how a box/banker expands into combinations,
// and how tickets settle against the official dividends.

// Pool codes as the GlobalTote feed names them, with the names used at Nicosia.
const POOLS = {
  EXACTA: { name: 'Forecast', picks: 2, ordered: true },
  QUINELLA: { name: 'Twin', picks: 2, ordered: false },
  SWINGER: { name: 'Omni', picks: 2, ordered: false },
  TRIFECTA: { name: 'Trio', picks: 3, ordered: true },
  SUPERFECTA: { name: 'Tetracast', picks: 4, ordered: true },
};
const MAX_LINES = 500;

class BetError extends Error {}

// Canonical combination key: "6-9-3" in finishing order, or sorted for any-order pools.
function comboKey(pool, numbers) {
  const ns = POOLS[pool].ordered ? numbers : [...numbers].sort((a, b) => a - b);
  return ns.join('-');
}

// The feed writes combinations as "6*9" (or "6|2" for multi-race pools).
const comboFromFeed = (pool, key) => comboKey(pool, String(key).split(/[*|]/).map(Number));

function permutations(items, size) {
  if (size === 0) return [[]];
  const out = [];
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)], size - 1)) out.push([x, ...rest]);
  });
  return out;
}

const uniqueInts = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number))].filter(Number.isInteger);

/**
 * Expands a selection into combination keys.
 *   straight: { positions: [[1, 2], [3]] }  one list of horses per position (any-order pools: 2 lists)
 *   reverse:  { horses: [1, 2] }            Forecast both ways round
 *   box:      { horses: [1, 2, 3] }         every order of the chosen horses
 *   banker:   { banker: 5, with: [1, 2, 3] } banker fixed 1st (anywhere for Twin/Omni), the others fill the rest
 */
function expand(pool, mode, sel = {}) {
  const def = POOLS[pool];
  if (!def) throw new BetError('Unknown bet type');
  let combos;
  if (mode === 'straight') {
    const positions = (sel.positions || []).map(uniqueInts);
    if (positions.length !== def.picks || positions.some((p) => !p.length)) {
      throw new BetError(`Pick at least one horse for each of the ${def.picks} places`);
    }
    combos = positions.reduce((acc, choices) => acc.flatMap((c) => choices.filter((n) => !c.includes(n)).map((n) => [...c, n])), [[]]);
  } else if (mode === 'reverse') {
    const horses = uniqueInts(sel.horses);
    if (pool !== 'EXACTA' || horses.length !== 2) throw new BetError('A reverse forecast needs exactly 2 horses');
    combos = permutations(horses, 2);
  } else if (mode === 'box') {
    const horses = uniqueInts(sel.horses);
    if (horses.length < def.picks) {
      throw new BetError(`A box needs at least ${def.picks} horses`);
    }
    combos = permutations(horses, def.picks);
  } else if (mode === 'banker') {
    const banker = Number(sel.banker);
    const others = uniqueInts(sel.with).filter((n) => n !== banker);
    if (!Number.isInteger(banker) || others.length < def.picks - 1) {
      throw new BetError(`Choose a banker and at least ${def.picks - 1} other horse${def.picks > 2 ? 's' : ''}`);
    }
    combos = permutations(others, def.picks - 1).map((rest) => [banker, ...rest]);
  } else {
    throw new BetError('Unknown way of combining');
  }
  const keys = [...new Set(combos.filter((c) => c.length === def.picks).map((c) => comboKey(pool, c)))];
  if (!keys.length) throw new BetError('That selection makes no valid combinations');
  if (keys.length > MAX_LINES) throw new BetError(`That is ${keys.length} combinations; the most in one bet is ${MAX_LINES}`);
  return keys;
}

const horsesIn = (combo) => combo.split('-').map(Number);

// Settles exotic tickets whose race has a result or was abandoned. Combinations with a withdrawn
// horse are refunded, as is every combination in a pool with no published result.
function settleExotics(db) {
  let settled = 0;
  const tickets = db.prepare(`
    SELECT t.*, r.status AS race_status FROM horse_tickets t JOIN races r ON r.id = t.race_id
    WHERE t.kind = 'exotic' AND t.status = 'open' AND r.status != 'open'`).all();
  for (const t of tickets) {
    const withdrawn = new Set(db.prepare('SELECT number FROM runners WHERE race_id = ? AND withdrawn = 1').all(t.race_id).map((r) => r.number));
    const published = !!db.prepare('SELECT 1 FROM race_pool_results WHERE race_id = ? AND pool = ?').get(t.race_id, t.pool);
    const dividend = db.prepare('SELECT dividend FROM race_dividends WHERE race_id = ? AND pool = ? AND combo = ?');
    const lines = db.prepare('SELECT * FROM horse_ticket_lines WHERE ticket_id = ?').all(t.id);
    let payout = 0;
    let won = 0;
    let voided = 0;
    for (const line of lines) {
      let result;
      let div = null;
      if (t.race_status === 'abandoned' || !published || horsesIn(line.combo).some((n) => withdrawn.has(n))) {
        result = 'void';
        payout += t.unit_stake;
        voided++;
      } else {
        div = dividend.get(t.race_id, t.pool, line.combo)?.dividend ?? null;
        result = div ? 'won' : 'lost';
        if (div) { payout += Math.round(t.unit_stake * div); won++; }
      }
      db.prepare('UPDATE horse_ticket_lines SET result = ?, dividend = ? WHERE id = ?').run(result, div, line.id);
    }
    const status = won ? 'won' : voided === lines.length ? 'void' : 'lost';
    finishTicket(db, t, status, payout, won ? 'payout' : 'refund');
    settled++;
  }
  return settled;
}

// Settles parlay legs as their races finish; a ticket closes when a leg loses or every leg is done.
function settleParlays(db) {
  let settled = 0;
  const legs = db.prepare(`
    SELECT l.*, r.status AS race_status, u.withdrawn, u.win_dividend, u.place_dividend
    FROM horse_parlay_legs l JOIN horse_tickets t ON t.id = l.ticket_id JOIN races r ON r.id = l.race_id
    JOIN runners u ON u.race_id = l.race_id AND u.number = l.runner_no
    WHERE t.status = 'open' AND l.result = 'pending' AND (r.status != 'open' OR u.withdrawn = 1)`).all();
  const touched = new Set();
  for (const l of legs) {
    let result;
    let div = null;
    if (l.race_status === 'abandoned' || l.withdrawn) {
      result = 'void';
    } else {
      div = l.bet_type === 'win' ? l.win_dividend : l.place_dividend;
      result = div ? 'won' : 'lost';
    }
    db.prepare('UPDATE horse_parlay_legs SET result = ?, dividend = ? WHERE id = ?').run(result, div, l.id);
    touched.add(l.ticket_id);
  }
  for (const id of touched) {
    const t = db.prepare("SELECT * FROM horse_tickets WHERE id = ? AND status = 'open'").get(id);
    if (!t) continue;
    const all = db.prepare('SELECT result, dividend FROM horse_parlay_legs WHERE ticket_id = ?').all(id);
    if (all.some((l) => l.result === 'lost')) {
      finishTicket(db, t, 'lost', 0);
    } else if (all.some((l) => l.result === 'pending')) {
      continue;
    } else if (all.every((l) => l.result === 'void')) {
      finishTicket(db, t, 'void', t.stake, 'refund');
    } else {
      const odds = all.reduce((acc, l) => acc * (l.result === 'won' ? l.dividend : 1), 1);
      finishTicket(db, t, 'won', Math.round(t.stake * odds), 'payout');
    }
    settled++;
  }
  return settled;
}

function finishTicket(db, t, status, payout, txType) {
  db.prepare("UPDATE horse_tickets SET status = ?, payout = ?, settled_at = datetime('now') WHERE id = ?").run(status, payout, t.id);
  if (payout > 0) db.adjustBalance({ userId: t.user_id, amount: payout, type: txType, horseTicketId: t.id });
}

function settleTickets(db) {
  return db.tx(() => settleExotics(db) + settleParlays(db));
}

module.exports = { POOLS, MAX_LINES, BetError, expand, comboKey, comboFromFeed, settleTickets };
