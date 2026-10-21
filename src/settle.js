'use strict';

function legResult(leg, event) {
  if (event.voided) return 'void';
  if (!event.completed) return 'pending';
  const { home_score: h, away_score: a } = event;
  if (leg.market === 'h2h') {
    const winner = h > a ? 'home' : h < a ? 'away' : 'draw';
    return leg.outcome === winner ? 'won' : 'lost';
  }
  if (leg.market === 'totals') {
    const goals = h + a;
    if (goals === leg.point) return 'void';
    return (goals > leg.point) === (leg.outcome === 'over') ? 'won' : 'lost';
  }
  return 'pending';
}

// Settles every leg and bet that can be settled. Safe to call repeatedly.
function settleAll(db) {
  let settled = 0;
  db.tx(() => {
    const legs = db.prepare(`
      SELECT l.*, e.completed, e.voided, e.home_score, e.away_score
      FROM bet_legs l JOIN events e ON e.id = l.event_id
      WHERE l.result = 'pending' AND (e.completed = 1 OR e.voided = 1)`).all();
    const setLeg = db.prepare('UPDATE bet_legs SET result = ? WHERE id = ?');
    const touched = new Set();
    for (const leg of legs) {
      const result = legResult(leg, leg);
      if (result !== 'pending') {
        setLeg.run(result, leg.id);
        touched.add(leg.bet_id);
      }
    }

    for (const betId of touched) {
      const bet = db.prepare("SELECT * FROM bets WHERE id = ? AND status = 'open'").get(betId);
      if (!bet) continue;
      const betLegs = db.prepare('SELECT result, price FROM bet_legs WHERE bet_id = ?').all(betId);
      let status;
      let payout = 0;
      if (betLegs.some((l) => l.result === 'lost')) {
        status = 'lost';
      } else if (betLegs.some((l) => l.result === 'pending')) {
        continue;
      } else if (betLegs.every((l) => l.result === 'void')) {
        status = 'void';
        payout = bet.stake;
      } else {
        status = 'won';
        // Void legs drop out of an accumulator (count as 1.00); odds are rounded the same way as at placement.
        const odds = betLegs.every((l) => l.result === 'won') ? bet.total_odds
          : Math.round(betLegs.reduce((acc, l) => acc * (l.result === 'won' ? l.price : 1), 1) * 100) / 100;
        payout = Math.round(bet.stake * odds);
      }
      db.prepare("UPDATE bets SET status = ?, payout = ?, settled_at = datetime('now') WHERE id = ?")
        .run(status, payout, betId);
      if (payout > 0) {
        db.adjustBalance({ userId: bet.user_id, amount: payout, type: status === 'void' ? 'refund' : 'payout', betId });
      }
      settled++;
    }
  });
  return settled;
}

module.exports = { settleAll, legResult };
