'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const odd = (n) => Number(n).toFixed(2);

  const state = {
    config: null,
    user: null,
    events: [],
    prevPrices: {},
    league: 'all',
    slip: loadSlip(),
    slipMode: 'single',
    stake: '',
    slipCollapsed: false,
    pollTimer: null,
  };

  const OUTCOME_LABEL = { home: '1', draw: 'X', away: '2', over: 'Over', under: 'Under' };

  function pickLabel(sel) {
    if (sel.market === 'h2h') return sel.outcome === 'home' ? sel.home : sel.outcome === 'away' ? sel.away : 'Draw';
    return `${sel.outcome === 'over' ? 'Over' : 'Under'} ${sel.point ?? 2.5} goals`;
  }
  const marketLabel = (m) => (m === 'h2h' ? 'Match result' : 'Total goals');

  function loadSlip() {
    try { return JSON.parse(localStorage.getItem('pb_slip')) || []; } catch { return []; }
  }
  function saveSlip() {
    try { localStorage.setItem('pb_slip', JSON.stringify(state.slip)); } catch { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------- api

  async function api(path, body) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') {
      state.user = null;
      render();
    }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    return data;
  }

  // ---------------------------------------------------------------- ui helpers

  let toastTimer;
  function toast(msg, kind = 'good') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  function modal(html, onSubmit) {
    const wrap = $('#modal');
    const card = $('#modal-card');
    // The card is reused by every dialog: clear what the previous one set up.
    card.className = 'modal-card';
    card.onclick = card.onchange = card.oninput = null;
    card.innerHTML = html;
    wrap.classList.remove('hidden');
    const close = () => wrap.classList.add('hidden');
    wrap.onclick = (e) => { if (e.target === wrap || e.target.dataset.close !== undefined) close(); };
    const form = $('form', wrap);
    if (form) {
      $('input', form)?.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        const errEl = $('.error', form);
        const btn = $('button[type=submit]', form);
        btn.disabled = true;
        try {
          await onSubmit(Object.fromEntries(new FormData(form)));
          close();
        } catch (err) {
          errEl.textContent = err.message;
        } finally {
          btn.disabled = false;
        }
      };
    }
  }

  const when = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const timeOnly = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (iso) => {
    const d = new Date(iso);
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  };
  const sqlDate = (s) => (s ? when(`${s.replace(' ', 'T')}Z`) : '');

  // ---------------------------------------------------------------- routing

  const USER_VIEWS = { matches: 'Football', horses: 'Horses', bets: 'My bets', results: 'Results', history: 'Statement', account: 'Account' };
  const ADMIN_VIEWS = { users: 'Players', allbets: 'All bets', settle: 'Settlement', racing: 'Racing', feed: 'Feeds', results: 'Results', account: 'Account' };

  // The views this user can open, minus any sport the site has switched off.
  function availableViews() {
    const views = { ...(state.user?.role === 'admin' ? ADMIN_VIEWS : USER_VIEWS) };
    if (!state.config.racingMode) { delete views.horses; delete views.racing; }
    if (!state.config.oddsMode) { delete views.matches; delete views.results; delete views.allbets; delete views.settle; }
    return views;
  }

  function currentView() {
    const views = availableViews();
    const v = location.hash.replace(/^#\/?/, '');
    return views[v] ? v : Object.keys(views)[0];
  }

  window.addEventListener('hashchange', () => render());

  async function refreshMe() {
    try {
      const { user } = await api('/me');
      state.user = user;
    } catch {
      state.user = null;
    }
  }

  function renderChrome() {
    const nav = $('#nav');
    const acct = $('#account');
    if (!state.user) {
      nav.classList.add('hidden');
      acct.classList.add('hidden');
      return;
    }
    const views = availableViews();
    const active = currentView();
    nav.innerHTML = Object.entries(views)
      .map(([k, label]) => `<button data-view="${k}" class="${k === active ? 'active' : ''}">${label}</button>`).join('');
    nav.classList.remove('hidden');
    acct.classList.remove('hidden');
    $('#balance').textContent = state.user.role === 'admin'
      ? `Master · ${state.user.username}`
      : `${fmt(state.user.balance)} ${state.config.currency}`;
  }

  $('#nav').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.view;
    if (v) location.hash = `#/${v}`;
  });
  $('.brand').addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
  $('#logout').addEventListener('click', async () => {
    await api('/logout', {}).catch(() => {});
    state.user = null;
    location.hash = '';
    render();
  });

  async function render() {
    clearInterval(state.pollTimer);
    renderChrome();
    const main = $('#view');
    if (!state.user) {
      renderSlip();
      renderParlay();
      return renderLogin(main);
    }
    const view = currentView();
    renderSlip();
    renderParlay();
    const views = {
      matches: renderMatches, bets: renderMyBets, results: renderResults, history: renderHistory, account: renderAccount,
      users: renderUsers, allbets: renderAllBets, settle: renderSettle, feed: renderFeed,
      horses: renderHorses, racing: renderRacingAdmin,
    };
    try {
      await views[view](main);
    } catch (err) {
      if (err.status !== 401) main.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- login

  function renderLogin(main) {
    main.innerHTML = `
      <form class="card login" id="login-form">
        <h1>⚽ ${esc(state.config.siteName)}</h1>
        <p class="muted small">Log in with the account your host gave you.</p>
        <label for="u">Username</label>
        <input id="u" name="username" autocomplete="username" required>
        <label for="p">Password</label>
        <input id="p" name="password" type="password" autocomplete="current-password" required>
        <button class="btn block" type="submit">Log in</button>
        <div class="error" id="login-error"></div>
      </form>`;
    $('#u').focus();
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        const { user } = await api('/login', f);
        state.user = user;
        location.hash = '';
        render();
      } catch (err) {
        $('#login-error').textContent = err.message;
      }
    };
  }

  // ---------------------------------------------------------------- matches

  async function loadEvents() {
    const { events } = await api('/events');
    const prices = {};
    for (const ev of events) {
      for (const [m, outs] of Object.entries(ev.markets)) {
        for (const [o, v] of Object.entries(outs)) prices[`${ev.id}|${m}|${o}`] = v.price;
      }
    }
    state.prevPrices = state.events.length ? Object.fromEntries(
      state.events.flatMap((ev) => Object.entries(ev.markets).flatMap(([m, outs]) =>
        Object.entries(outs).map(([o, v]) => [`${ev.id}|${m}|${o}`, v.price])))) : {};
    state.events = events;
    // Keep the slip's prices honest: flag any that moved since they were added.
    let slipChanged = false;
    for (const s of state.slip) {
      const p = prices[`${s.eventId}|${s.market}|${s.outcome}`];
      if (p === undefined) { s.suspended = true; slipChanged = true; }
      else if (p !== s.price) { s.newPrice = p; slipChanged = true; }
    }
    if (slipChanged) { saveSlip(); renderSlip(); }
  }

  async function renderMatches(main) {
    main.innerHTML = '<div class="empty-state">Loading matches…</div>';
    await loadEvents();
    drawMatches(main);
    state.pollTimer = setInterval(async () => {
      if (currentView() !== 'matches' || document.hidden) return;
      try { await loadEvents(); drawMatches(main); } catch { /* try again next tick */ }
    }, 60000);
  }

  function oddBtn(ev, market, outcome, extraClass = '') {
    const o = ev.markets[market]?.[outcome];
    if (!o) return `<button class="odd empty ${extraClass}" disabled>–</button>`;
    const key = `${ev.id}|${market}|${outcome}`;
    const prev = state.prevPrices[key];
    const move = prev === undefined || prev === o.price ? '' : o.price > prev ? 'up' : 'down';
    const selected = state.slip.some((s) => s.eventId === ev.id && s.market === market && s.outcome === outcome);
    return `<button class="odd ${extraClass} ${selected ? 'selected' : ''} ${move}" data-ev="${esc(ev.id)}" data-m="${market}" data-o="${outcome}"
      title="${esc(pickLabel({ ...ev, market, outcome, point: o.point }))}">${odd(o.price)}</button>`;
  }

  function drawMatches(main) {
    const leagues = [...new Set(state.events.map((e) => e.league))].sort();
    const events = state.events.filter((e) => state.league === 'all' || e.league === state.league);
    let html = `<div class="chips">
      <button class="chip ${state.league === 'all' ? 'active' : ''}" data-league="all">All</button>
      ${leagues.map((l) => `<button class="chip ${state.league === l ? 'active' : ''}" data-league="${esc(l)}">${esc(l)}</button>`).join('')}
    </div>`;
    if (!events.length) {
      html += '<div class="empty-state">No matches open for betting right now. Check back soon.</div>';
    }
    const byDay = new Map();
    for (const ev of events) {
      const day = dayLabel(ev.commenceTime);
      if (!byDay.has(day)) byDay.set(day, new Map());
      const byLeague = byDay.get(day);
      if (!byLeague.has(ev.league)) byLeague.set(ev.league, []);
      byLeague.get(ev.league).push(ev);
    }
    for (const [day, byLeague] of byDay) {
      html += `<h2>${esc(day)}</h2>`;
      for (const [league, evs] of byLeague) {
        html += `<div class="day"><div class="league-head"><span>${esc(league)}</span><span>1</span><span>X</span><span>2</span><span></span><span class="ou">O 2.5</span><span class="ou">U 2.5</span></div>`;
        for (const ev of evs) {
          html += `<div class="match">
            <div class="teams"><div class="time">${timeOnly(ev.commenceTime)}</div>
              <div class="t">${esc(ev.home)}</div><div class="t">${esc(ev.away)}</div></div>
            ${oddBtn(ev, 'h2h', 'home')}${oddBtn(ev, 'h2h', 'draw')}${oddBtn(ev, 'h2h', 'away')}
            <span></span>
            ${oddBtn(ev, 'totals', 'over', 'ou')}${oddBtn(ev, 'totals', 'under', 'ou')}
            <div class="ou-row">${oddBtn(ev, 'totals', 'over').replace('>', '>Over 2.5 · ')}${oddBtn(ev, 'totals', 'under').replace('>', '>Under 2.5 · ')}</div>
          </div>`;
        }
        html += '</div>';
      }
    }
    main.innerHTML = html;
  }

  $('#view').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-league]');
    if (chip) {
      state.league = chip.dataset.league;
      drawMatches($('#view'));
      return;
    }
    const btn = e.target.closest('.odd[data-ev]');
    if (!btn) return;
    const ev = state.events.find((x) => x.id === btn.dataset.ev);
    const { m: market, o: outcome } = btn.dataset;
    const idx = state.slip.findIndex((s) => s.eventId === ev.id && s.market === market && s.outcome === outcome);
    if (idx >= 0) {
      state.slip.splice(idx, 1);
    } else {
      // One pick per market per match: picking "Draw" replaces "Home" in the same match.
      state.slip = state.slip.filter((s) => !(s.eventId === ev.id && s.market === market));
      const o = ev.markets[market][outcome];
      state.slip.push({
        eventId: ev.id, market, outcome, price: o.price, point: o.point,
        home: ev.home, away: ev.away, league: ev.league, commenceTime: ev.commenceTime,
      });
      state.slipCollapsed = false;
    }
    saveSlip();
    drawMatches($('#view'));
    renderSlip();
  });

  // ---------------------------------------------------------------- bet slip

  function slipOdds() {
    return Math.round(state.slip.reduce((acc, s) => acc * (s.newPrice ?? s.price), 1) * 100) / 100;
  }
  function canAcca() {
    return state.slip.length >= 2 && new Set(state.slip.map((s) => s.eventId)).size === state.slip.length;
  }

  function renderSlip() {
    const el = $('#slip');
    const show = state.user?.role === 'user' && state.slip.length > 0;
    el.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-slip', show);
    if (!show) return;
    if (state.slipMode === 'acca' && !canAcca()) state.slipMode = 'single';
    const n = state.slip.length;
    const stake = Number(state.stake) || 0;
    const hasChanges = state.slip.some((s) => s.newPrice !== undefined);
    const suspended = state.slip.some((s) => s.suspended);
    const totalStake = state.slipMode === 'acca' ? stake : stake * n;
    const potential = state.slipMode === 'acca'
      ? stake * slipOdds()
      : state.slip.reduce((acc, s) => acc + stake * (s.newPrice ?? s.price), 0);

    el.classList.toggle('collapsed', state.slipCollapsed);
    el.innerHTML = `
      <div class="slip-head" id="slip-toggle"><h3>Bet slip <span class="count">${n}</span></h3>
        <button class="btn ghost small" id="slip-clear">Clear</button></div>
      <div class="slip-body">
        <div class="tabs">
          <button data-mode="single" class="${state.slipMode === 'single' ? 'active' : ''}">Single${n > 1 ? 's' : ''}</button>
          <button data-mode="acca" class="${state.slipMode === 'acca' ? 'active' : ''}" ${canAcca() ? '' : 'disabled'}
            title="${canAcca() ? '' : 'Needs 2+ selections from different matches'}">Accumulator</button>
        </div>
        ${state.slip.map((s, i) => `
          <div class="sel">
            <div class="pick">${esc(pickLabel(s))}</div>
            <div class="price ${s.newPrice !== undefined ? 'changed' : ''}">${s.suspended ? 'Suspended' : s.newPrice !== undefined ? `${odd(s.price)} → ${odd(s.newPrice)}` : odd(s.price)}</div>
            <div class="meta">${esc(marketLabel(s.market))} · ${esc(s.home)} v ${esc(s.away)}<br>${esc(when(s.commenceTime))}</div>
            <button class="remove" data-remove="${i}">Remove</button>
          </div>`).join('')}
        <label for="stake">Stake ${state.slipMode === 'single' && n > 1 ? 'per bet' : ''} (${esc(state.config.currency)})</label>
        <input id="stake" type="number" inputmode="decimal" min="${state.config.minStake}" max="${state.config.maxStake}" step="0.01" value="${esc(state.stake)}" placeholder="0.00">
        <div class="quick">${[5, 10, 25, 50].map((v) => `<button class="btn ghost small" data-quick="${v}">${v}</button>`).join('')}</div>
        ${state.slipMode === 'acca' ? `<div class="summary"><span>Total odds</span><strong>${odd(slipOdds())}</strong></div>` : ''}
        <div class="summary"><span>Total stake</span><strong>${fmt(totalStake)}</strong></div>
        <div class="summary"><span>Potential return</span><strong class="pos">${fmt(potential)}</strong></div>
        <button class="btn block" id="place" ${stake > 0 && !suspended ? '' : 'disabled'}>
          ${suspended ? 'Remove suspended selections' : hasChanges ? 'Accept new odds & place bet' : 'Place bet'}</button>
        <div class="error" id="slip-error"></div>
      </div>`;
  }

  $('#slip').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.id === 'slip-clear') {
      e.stopPropagation();
      state.slip = [];
      saveSlip();
      renderSlip();
      if (currentView() === 'matches') drawMatches($('#view'));
      return;
    }
    if (t.closest('#slip-toggle')) { state.slipCollapsed = !state.slipCollapsed; renderSlip(); return; }
    if (t.dataset.mode && !t.disabled) { state.slipMode = t.dataset.mode; renderSlip(); return; }
    if (t.dataset.remove !== undefined) {
      state.slip.splice(Number(t.dataset.remove), 1);
      saveSlip();
      renderSlip();
      if (currentView() === 'matches') drawMatches($('#view'));
      return;
    }
    if (t.dataset.quick) { state.stake = t.dataset.quick; renderSlip(); return; }
    if (t.id === 'place') await placeBet(t);
  });
  $('#slip').addEventListener('input', (e) => {
    if (e.target.id !== 'stake') return;
    state.stake = e.target.value;
    const pos = e.target.selectionStart;
    renderSlip();
    const input = $('#stake');
    input.focus();
    try { input.setSelectionRange(pos, pos); } catch { /* number inputs may not support selection */ }
  });

  async function placeBet(btn) {
    // Accepting a price change means betting at the new price.
    for (const s of state.slip) {
      if (s.newPrice !== undefined) { s.price = s.newPrice; delete s.newPrice; }
    }
    btn.disabled = true;
    try {
      const res = await api('/bets', {
        mode: state.slipMode,
        stake: Number(state.stake),
        selections: state.slip.map(({ eventId, market, outcome, price }) => ({ eventId, market, outcome, price })),
      });
      state.user.balance = res.balance;
      state.slip = [];
      saveSlip();
      renderChrome();
      renderSlip();
      toast(res.betIds.length > 1 ? `${res.betIds.length} bets placed` : 'Bet placed — good luck!');
      if (currentView() === 'matches') drawMatches($('#view'));
    } catch (err) {
      if (err.status === 409 && err.data.changed) {
        for (const c of err.data.changed) {
          const s = state.slip.find((x) => x.eventId === c.eventId && x.market === c.market && x.outcome === c.outcome);
          if (s) s.newPrice = c.price;
        }
        saveSlip();
      }
      renderSlip();
      $('#slip-error').textContent = err.message;
    }
  }

  // ---------------------------------------------------------------- bets

  function legResultBadge(l) {
    return `<span class="badge ${l.result}">${l.result === 'pending' ? 'open' : l.result}</span>`;
  }

  function betCard(b, showUser = false) {
    const type = b.legs.length > 1 ? `${b.legs.length}-fold accumulator` : 'Single';
    return `<div class="card bet">
      <div class="bet-top"><div><strong>${esc(type)}</strong> <span class="muted small">#${b.id}${showUser ? ` · ${esc(b.username)}` : ''} · ${esc(sqlDate(b.placedAt))}</span></div>
        <span class="badge ${b.status}">${b.status}</span></div>
      ${b.legs.map((l) => `<div class="leg">
          <div><strong>${esc(pickLabel(l))}</strong> @ ${odd(l.price)}<div class="muted small">${esc(marketLabel(l.market))} · ${esc(l.match)} · ${esc(l.league)} · ${esc(when(l.commenceTime))}</div></div>
          <div class="r">${l.score ? `<span class="muted">${l.score[0]}–${l.score[1]}</span> ` : ''}${b.legs.length > 1 ? legResultBadge(l) : ''}</div>
        </div>`).join('')}
      <div class="bet-foot"><span>Stake <strong>${fmt(b.stake)}</strong></span><span>Odds <strong>${odd(b.totalOdds)}</strong></span>
        ${b.status === 'open' ? `<span>To return <strong>${fmt(b.potentialReturn)}</strong></span>` : `<span>Returned <strong class="${b.payout > 0 ? 'pos' : ''}">${fmt(b.payout)}</strong></span>`}</div>
    </div>`;
  }

  async function renderMyBets(main) {
    const [{ bets: football }, { bets: horses }, { tickets }] = await Promise.all([
      api('/bets'), state.config.racingMode ? api('/horse-bets') : { bets: [] },
      state.config.racingMode ? api('/horse-tickets') : { tickets: [] }]);
    await refreshMe();
    renderChrome();
    // Newest first across both sports; SQLite timestamps sort as text.
    const bets = [...football.map((b) => ({ ...b, sport: 'football' })), ...horses.map((b) => ({ ...b, sport: 'horse' })),
      ...tickets.map((b) => ({ ...b, sport: 'ticket' }))]
      .sort((a, b) => (b.placedAt > a.placedAt ? 1 : b.placedAt < a.placedAt ? -1 : b.id - a.id));
    const card = (b) => (b.sport === 'horse' ? horseBetCard(b) : b.sport === 'ticket' ? ticketCard(b) : betCard(b));
    const open = bets.filter((b) => b.status === 'open');
    const settled = bets.filter((b) => b.status !== 'open');
    main.innerHTML = `<h1>My bets</h1>
      ${!bets.length ? '<div class="empty-state">You haven\'t placed any bets yet.</div>' : ''}
      ${open.length ? `<h2>Open (${open.length})</h2>${open.map(card).join('')}` : ''}
      ${settled.length ? `<h2>Settled</h2>${settled.map(card).join('')}` : ''}`;
  }

  async function renderResults(main) {
    const { events } = await api('/results');
    main.innerHTML = `<h1>Recent results</h1>
      ${events.length ? `<div class="card table-wrap"><table><thead><tr><th>Kick-off</th><th>League</th><th>Match</th><th class="num">Score</th></tr></thead><tbody>
        ${events.map((e) => `<tr><td class="muted">${esc(when(e.commenceTime))}</td><td>${esc(e.league)}</td><td>${esc(e.home)} v ${esc(e.away)}</td>
          <td class="num"><strong>${e.voided ? 'Void' : `${e.score[0]} – ${e.score[1]}`}</strong></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty-state">No results yet.</div>'}`;
  }

  function txTable(txs) {
    if (!txs.length) return '<div class="empty-state">No transactions yet.</div>';
    const label = { credit: 'Credit from host', debit: 'Debit by host', bet: 'Bet placed', payout: 'Winnings', refund: 'Refund (void)' };
    return `<div class="card table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Details</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead><tbody>
      ${txs.map((t) => `<tr><td class="muted">${esc(sqlDate(t.createdAt))}</td><td>${esc(label[t.type] || t.type)}</td>
        <td class="muted">${t.betId ? `Bet #${t.betId}` : ''}${t.horseBetId ? `Horse bet #H${t.horseBetId}` : ''}${t.horseTicketId ? `Horse bet #T${t.horseTicketId}` : ''}${t.note ? esc(t.note) : ''}</td>
        <td class="num ${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</td><td class="num">${fmt(t.balanceAfter)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  async function renderHistory(main) {
    const { transactions } = await api('/transactions');
    main.innerHTML = `<h1>Statement</h1>${txTable(transactions)}`;
  }

  function renderAccount(main) {
    main.innerHTML = `<h1>Account</h1>
      <div class="card narrow">
        <p>Logged in as <strong>${esc(state.user.username)}</strong>${state.user.role === 'admin' ? ' (master account)' : ''}.</p>
        <form id="pw-form">
          <label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" autocomplete="current-password" required>
          <label for="np">New password</label><input id="np" name="newPassword" type="password" autocomplete="new-password" minlength="6" required>
          <button class="btn block" type="submit">Change password</button>
          <div class="error"></div>
        </form>
      </div>`;
    $('#pw-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/me/password', Object.fromEntries(new FormData(e.target)));
        e.target.reset();
        toast('Password changed');
      } catch (err) {
        $('.error', e.target).textContent = err.message;
      }
    };
  }

  // ---------------------------------------------------------------- admin

  async function renderUsers(main) {
    const [{ users }, status] = await Promise.all([api('/admin/users'), api('/admin/status')]);
    main.innerHTML = `
      <div class="stats">
        <div class="card stat"><div class="v">${status.users}</div><div class="k">Players</div></div>
        <div class="card stat"><div class="v">${fmt(status.creditsInCirculation)}</div><div class="k">${esc(state.config.currency)} in balances</div></div>
        <div class="card stat"><div class="v">${status.openBets}</div><div class="k">Open bets</div></div>
        ${state.config.oddsMode ? `<div class="card stat"><div class="v">${status.upcomingEvents}</div><div class="k">Upcoming matches</div></div>` : ''}
      </div>
      <div class="bet-top"><h1>Players</h1><button class="btn" id="new-user">+ Open account</button></div>
      ${users.length ? `<div class="card table-wrap"><table><thead><tr><th>Username</th><th class="num">Balance</th><th class="num">In open bets</th><th class="num">Bets</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr>
          <td><strong>${esc(u.username)}</strong><div class="muted small">since ${esc(sqlDate(u.createdAt))}</div></td>
          <td class="num">${fmt(u.balance)}</td><td class="num">${fmt(u.openStake)}</td><td class="num">${u.betCount}</td>
          <td>${u.active ? '<span class="badge won">active</span>' : '<span class="badge lost">disabled</span>'}</td>
          <td><div class="actions">
            <button class="btn small" data-act="credit" data-id="${u.id}">Credit / debit</button>
            <button class="btn ghost small" data-act="tx" data-id="${u.id}">Statement</button>
            <button class="btn ghost small" data-act="pw" data-id="${u.id}">Set password</button>
            <button class="btn ${u.active ? 'danger' : 'ghost'} small" data-act="active" data-id="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>
          </div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty-state">No players yet. Open the first account.</div>'}`;

    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    $('#new-user').onclick = () => modal(`
      <h3>Open a new account</h3>
      <form>
        <label>Username</label><input name="username" required pattern="[A-Za-z0-9_.\\-]{3,32}" autocomplete="off">
        <label>Password</label><input name="password" required minlength="6" autocomplete="new-password">
        <label>Opening credit (${esc(state.config.currency)})</label><input name="initialCredit" type="number" step="0.01" min="0" value="1000">
        <div class="error"></div>
        <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Create account</button></div>
      </form>`, async (f) => {
      await api('/admin/users', { ...f, initialCredit: Number(f.initialCredit || 0) });
      toast(`Account ${f.username} created`);
      render();
    });

    main.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const u = byId[b.dataset.id];
        if (b.dataset.act === 'credit') {
          modal(`<h3>Credit / debit ${esc(u.username)}</h3><p class="muted small">Current balance: ${fmt(u.balance)}. Use a negative amount to remove credits.</p>
            <form><label>Amount</label><input name="amount" type="number" step="0.01" required>
            <label>Note (optional)</label><input name="note" maxlength="200">
            <div class="error"></div>
            <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Apply</button></div></form>`,
          async (f) => {
            const r = await api(`/admin/users/${u.id}/credit`, { amount: Number(f.amount), note: f.note });
            toast(`${u.username}'s balance is now ${fmt(r.balance)}`);
            render();
          });
        } else if (b.dataset.act === 'pw') {
          modal(`<h3>Set password for ${esc(u.username)}</h3><form><label>New password</label><input name="password" required minlength="6" autocomplete="new-password">
            <div class="error"></div>
            <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`,
          async (f) => {
            await api(`/admin/users/${u.id}/password`, f);
            toast('Password updated');
          });
        } else if (b.dataset.act === 'active') {
          await api(`/admin/users/${u.id}/active`, { active: b.dataset.active === '1' });
          render();
        } else if (b.dataset.act === 'tx') {
          const { transactions } = await api(`/admin/users/${u.id}/transactions`);
          main.innerHTML = `<div class="bet-top"><h1>Statement · ${esc(u.username)}</h1><a class="btn ghost small" href="#/users" id="back">← Players</a></div>${txTable(transactions)}`;
          $('#back').onclick = (e) => { e.preventDefault(); render(); };
        }
      };
    });
  }

  async function renderAllBets(main, status = '') {
    const { bets } = await api(`/admin/bets${status ? `?status=${status}` : ''}`);
    main.innerHTML = `<h1>All bets</h1>
      <div class="chips">${['', 'open', 'won', 'lost', 'void'].map((s) => `<button class="chip ${s === status ? 'active' : ''}" data-status="${s}">${s || 'All'}</button>`).join('')}</div>
      ${bets.length ? bets.map((b) => betCard(b, true)).join('') : '<div class="empty-state">No bets.</div>'}`;
    main.querySelectorAll('[data-status]').forEach((c) => { c.onclick = () => renderAllBets(main, c.dataset.status); });
  }

  async function renderSettle(main) {
    const { events } = await api('/admin/events/pending');
    main.innerHTML = `<h1>Settlement</h1>
      <p class="muted">Bets settle automatically once the results feed reports a final score. Matches below have started but still have open bets —
      use this if a result is late, wrong, or the match was postponed/abandoned (void refunds the stake; in an accumulator that leg counts as odds 1.00).</p>
      ${events.length ? `<div class="card table-wrap"><table><thead><tr><th>Kick-off</th><th>Match</th><th class="num">Open legs</th><th>Settle</th></tr></thead><tbody>
        ${events.map((e) => `<tr><td class="muted">${esc(when(e.commenceTime))}</td><td><strong>${esc(e.home)} v ${esc(e.away)}</strong><div class="muted small">${esc(e.league)}</div></td>
          <td class="num">${e.pendingLegs}</td>
          <td><div class="actions"><button class="btn small" data-result="${esc(e.id)}">Enter result</button><button class="btn danger small" data-void="${esc(e.id)}">Void</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty-state">Nothing waiting — all started matches are settled.</div>'}`;
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    main.querySelectorAll('[data-result]').forEach((b) => {
      b.onclick = () => {
        const e = byId[b.dataset.result];
        modal(`<h3>Final score</h3><p class="muted small">${esc(e.home)} v ${esc(e.away)}</p><form><div class="form-row">
          <div><label>${esc(e.home)}</label><input name="homeScore" type="number" min="0" required></div>
          <div><label>${esc(e.away)}</label><input name="awayScore" type="number" min="0" required></div></div>
          <div class="error"></div>
          <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Settle bets</button></div></form>`,
        async (f) => {
          const r = await api(`/admin/events/${encodeURIComponent(e.id)}/result`, { homeScore: Number(f.homeScore), awayScore: Number(f.awayScore) });
          toast(`Settled ${r.settledBets} bet(s)`);
          render();
        });
      };
    });
    main.querySelectorAll('[data-void]').forEach((b) => {
      b.onclick = () => {
        const e = byId[b.dataset.void];
        modal(`<h3>Void ${esc(e.home)} v ${esc(e.away)}?</h3><p class="muted">All selections on this match become void. Singles are refunded.</p>
          <form><div class="error"></div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Void match</button></div></form>`,
        async () => {
          const r = await api(`/admin/events/${encodeURIComponent(e.id)}/void`, {});
          toast(`Match voided, ${r.settledBets} bet(s) settled`);
          render();
        });
      };
    });
  }

  async function renderFeed(main) {
    const s = await api('/admin/status');
    const football = s.oddsMode ? `
      <h2>Football</h2>
      <div class="stats">
        <div class="card stat"><div class="v">${s.oddsMode === 'live' ? 'Live' : 'Demo'}</div><div class="k">Mode</div></div>
        <div class="card stat"><div class="v">${s.apiRequestsRemaining ?? '—'}</div><div class="k">API credits left</div></div>
        <div class="card stat"><div class="v">${s.upcomingEvents}</div><div class="k">Upcoming matches</div></div>
      </div>
      <div class="card">
        <p>Odds last refreshed: <strong>${s.oddsRefreshedAt ? esc(when(s.oddsRefreshedAt)) : 'never'}</strong><br>
        Results last checked: <strong>${s.scoresRefreshedAt ? esc(when(s.scoresRefreshedAt)) : 'never'}</strong></p>
        <p class="muted small">Leagues: ${s.leagues.map(esc).join(', ')}</p>
        ${s.oddsMode === 'demo' ? '<p class="muted small">Set <code>ODDS_API_KEY</code> on the server to switch to live bookmaker odds from The Odds API.</p>' : ''}
        ${s.lastError ? `<p class="neg small">Last error: ${esc(s.lastError)}</p>` : ''}
        ${s.oddsMode === 'live' ? '<p class="muted small">Refreshing football uses API credits (2 per league).</p>' : ''}
      </div>` : '';
    const horses = s.racingMode ? `
      <h2>Horse racing</h2>
      <div class="card">
        <p>Feed: <strong>${s.racingMode === 'demo' ? 'Demo (simulated races)' : s.racingMode === 'nrc' ? 'Racing NRC (live, Nicosia)' : esc(s.racingMode)}</strong><br>
        Last refreshed: <strong>${s.racingRefreshedAt ? esc(when(s.racingRefreshedAt)) : 'never'}</strong></p>
        ${s.racingMode === 'nrc' ? '<p class="muted small">Read on Cyprus race days only (Wednesday and Sunday).</p>' : ''}
        ${s.racingLastError ? `<p class="neg small">Racing feed error: ${esc(s.racingLastError)}</p>` : ''}
      </div>` : '';
    main.innerHTML = `<h1>Feeds</h1>${horses}${football}
      <p><button class="btn" id="refresh">Refresh now</button></p>`;
    $('#refresh').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('/admin/refresh', {});
        toast(r.errors.length ? `Refreshed with ${r.errors.length} error(s)` : `Refreshed — ${r.settledBets} bet(s) settled`, r.errors.length ? 'bad' : 'good');
      } catch (err) {
        toast(err.message, 'bad');
      }
      render();
    };
  }


  // ---------------------------------------------------------------- horse racing

  const BET_TYPE_LABEL = { win: 'Win', place: 'Place', each_way: 'Each way' };
  const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
  const price = (p) => (p ? odd(p) : '–');
  function startsIn(iso) {
    const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (mins <= 0) return 'Off';
    if (mins < 60) return `${mins} min`;
    return timeOnly(iso);
  }
  const raceTitle = (r) => `${esc(r.meeting)} · Race ${r.raceNo}`;
  const placeTerms = (n) => (n ? `Place pays 1st–${ordinal(n)}` : 'Win only (no place betting)');

  state.horseTab = 'upcoming';
  state.races = [];

  async function renderHorses(main) {
    if (state.horseTab === 'results') {
      const { races } = await api('/races/results');
      return drawHorseResults(main, races);
    }
    main.innerHTML = '<div class="empty-state">Loading races…</div>';
    const prev = Object.fromEntries(state.races.flatMap((r) => r.runners.map((u) => [`${r.id}|${u.number}`, u.winPrice])));
    state.races = (await api('/races')).races;
    drawRaces(main, prev);
    state.pollTimer = setInterval(async () => {
      if (currentView() !== 'horses' || state.horseTab !== 'upcoming' || document.hidden || !$('#modal').classList.contains('hidden')) return;
      try {
        const before = Object.fromEntries(state.races.flatMap((r) => r.runners.map((u) => [`${r.id}|${u.number}`, u.winPrice])));
        state.races = (await api('/races')).races;
        drawRaces(main, before);
      } catch { /* try again next tick */ }
    }, 30000);
  }

  function horseTabs() {
    return `<div class="chips">${['upcoming', 'results'].map((t) =>
      `<button class="chip ${state.horseTab === t ? 'active' : ''}" data-horse-tab="${t}">${t === 'upcoming' ? 'Race cards' : 'Results'}</button>`).join('')}</div>`;
  }

  function drawRaces(main, prev = {}) {
    let html = `${horseTabs()}<p class="muted small">Tote betting, like at the track: prices move as money comes in, and winning bets are paid the official final dividend.</p>`;
    if (!state.races.length) html += '<div class="empty-state">No races open for betting right now.</div>';
    let day = '';
    for (const r of state.races) {
      const d = dayLabel(r.postTime);
      if (d !== day) { html += `<h2>${esc(d)}</h2>`; day = d; }
      html += `<div class="race card">
        <div class="race-head"><div><strong>${raceTitle(r)}</strong> · ${esc(timeOnly(r.postTime))}
          <div class="muted small">${esc(r.name || '')}${r.distance ? ` · ${esc(r.distance)}` : ''} · ${placeTerms(r.placesPaid)}</div></div>
          <div class="race-actions"><span class="countdown">${startsIn(r.postTime)}</span>
            ${r.pools?.length ? `<button class="btn ghost small" data-exotic="${esc(r.id)}">More bets</button>` : ''}</div></div>
        <div class="runner runner-head"><span>#</span><span>Horse / jockey</span><span>Win</span><span>Place</span></div>
        ${r.runners.map((u) => {
          const key = `${r.id}|${u.number}`;
          const move = prev[key] === undefined || prev[key] === u.winPrice ? '' : u.winPrice > prev[key] ? 'up' : 'down';
          return `<div class="runner ${u.withdrawn ? 'withdrawn' : ''}">
            <span class="no">${u.number}</span>
            <div class="horse"><div class="t"><strong>${esc(u.horse)}</strong>${u.withdrawn ? ' <span class="badge void">withdrawn</span>' : ''}</div>
              <div class="muted small">${esc([u.jockey, u.weight, u.draw && `draw ${u.draw}`, u.form && `form ${u.form}`].filter(Boolean).join(' · '))}</div></div>
            ${u.withdrawn ? '<span></span><span></span>' : `
              <button class="odd ${move}" data-race="${esc(r.id)}" data-runner="${u.number}" data-type="win" ${u.winPrice ? '' : 'disabled'}>${price(u.winPrice)}</button>
              <button class="odd" data-race="${esc(r.id)}" data-runner="${u.number}" data-type="place" ${u.placePrice ? '' : 'disabled'}>${price(u.placePrice)}</button>`}
          </div>`;
        }).join('')}
      </div>`;
    }
    main.innerHTML = html;
  }

  function drawHorseResults(main, races) {
    main.innerHTML = `${horseTabs()}${races.length ? races.map((r) => {
      const placed = r.runners.filter((u) => u.position).sort((a, b) => a.position - b.position).slice(0, Math.max(3, r.placesPaid));
      return `<div class="race card">
        <div class="race-head"><div><strong>${raceTitle(r)}</strong> · ${esc(when(r.postTime))}
          <div class="muted small">${esc(r.name || '')}${r.distance ? ` · ${esc(r.distance)}` : ''}</div></div>
          ${r.status === 'abandoned' ? '<span class="badge void">abandoned</span>' : ''}</div>
        ${r.status === 'abandoned' ? '<p class="muted">All bets refunded.</p>' : `<div class="table-wrap"><table>
          <thead><tr><th>Pos</th><th>Horse</th><th class="num">Win div.</th><th class="num">Place div.</th></tr></thead><tbody>
          ${placed.map((u) => `<tr><td>${ordinal(u.position)}</td><td>${u.number}. ${esc(u.horse)} <span class="muted small">${esc(u.jockey || '')}</span></td>
            <td class="num">${u.winDividend ? odd(u.winDividend) : ''}</td><td class="num">${u.placeDividend ? odd(u.placeDividend) : ''}</td></tr>`).join('')}
          </tbody></table></div>
          ${r.dividends?.length ? `<p class="small dividends">${[...r.dividends].sort((a, b) => POOL_ORDER.indexOf(a.pool) - POOL_ORDER.indexOf(b.pool)).map((d) => `<span><span class="muted">${POOL_INFO[d.pool]?.name || esc(d.pool)}</span> ${esc(d.combo)} <strong>${odd(d.dividend)}</strong></span>`).join('')}</p>` : ''}
          ${r.runners.some((u) => u.withdrawn) ? `<p class="muted small">Withdrawn: ${r.runners.filter((u) => u.withdrawn).map((u) => `${u.number}. ${esc(u.horse)}`).join(', ')}</p>` : ''}`}
      </div>`;
    }).join('') : '<div class="empty-state">No race results in the last few days.</div>'}`;
  }

  $('#view').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-horse-tab]');
    if (tab) {
      state.horseTab = tab.dataset.horseTab;
      render();
      return;
    }
    const exotic = e.target.closest('[data-exotic]');
    if (exotic) {
      const race = state.races.find((r) => r.id === exotic.dataset.exotic);
      if (race) openExoticBet(race);
      return;
    }
    const btn = e.target.closest('.odd[data-race]');
    if (!btn || btn.disabled) return;
    const race = state.races.find((r) => r.id === btn.dataset.race);
    const runner = race?.runners.find((u) => u.number === Number(btn.dataset.runner));
    if (race && runner) openHorseBet(race, runner, btn.dataset.type);
  });

  function openHorseBet(race, runner, initialType) {
    let type = initialType;
    const types = race.placesPaid ? ['win', 'place', 'each_way'] : ['win'];
    modal(`
      <h3>${runner.number}. ${esc(runner.horse)}</h3>
      <p class="muted small">${raceTitle(race)} · ${esc(timeOnly(race.postTime))} · ${esc(runner.jockey || '')}<br>${placeTerms(race.placesPaid)}</p>
      <form>
        <div class="tabs" id="hb-types">${types.map((t) => `<button type="button" data-t="${t}">${BET_TYPE_LABEL[t]}</button>`).join('')}</div>
        <label for="hb-stake">Stake (${esc(state.config.currency)})</label>
        <input id="hb-stake" name="stake" type="number" inputmode="decimal" step="0.01" min="${state.config.minStake}" max="${state.config.maxStake}" required>
        <div class="quick">${[5, 10, 25, 50].map((v) => `<button type="button" class="btn ghost small" data-q="${v}">${v}</button>`).join('')}</div>
        <div id="hb-summary"></div>
        <p class="muted small">Tote bet: the price shown is the current guide. If the horse wins or places you're paid the official final dividend, which can be higher or lower. Withdrawn horse or abandoned race = stake refunded.</p>
        <div class="error"></div>
        <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="button" class="btn ghost" id="hb-parlay">Add to parlay</button><button class="btn" type="submit">Place bet</button></div>
      </form>`, async (f) => {
      const res = await api('/horse-bets', { raceId: race.id, runnerNo: runner.number, betType: type, stake: Number(f.stake) });
      state.user.balance = res.balance;
      renderChrome();
      toast(`${BET_TYPE_LABEL[type]} bet on ${runner.horse} placed — good luck!`);
    });
    const stakeEl = $('#hb-stake');
    const update = () => {
      document.querySelectorAll('#hb-types button').forEach((b) => b.classList.toggle('active', b.dataset.t === type));
      $('#hb-parlay').hidden = type === 'each_way';
      const stake = Number(stakeEl.value) || 0;
      const rows = [];
      if (type === 'each_way') {
        rows.push(['Total stake', fmt(stake * 2), '']);
        rows.push(['If it wins (guide)', fmt(stake * (runner.winPrice + runner.placePrice)), 'pos']);
        rows.push(['If it only places (guide)', fmt(stake * runner.placePrice), 'pos']);
      } else {
        const p = type === 'win' ? runner.winPrice : runner.placePrice;
        rows.push([`Current ${type} price`, odd(p), '']);
        rows.push(['Estimated return', fmt(stake * p), 'pos']);
      }
      $('#hb-summary').innerHTML = rows.map(([k, v, c]) => `<div class="summary"><span>${k}</span><strong class="${c}">${v}</strong></div>`).join('');
    };
    $('#hb-types').onclick = (e) => { if (e.target.dataset.t) { type = e.target.dataset.t; update(); } };
    $('#hb-parlay').onclick = () => {
      addParlayLeg(race, runner, type === 'place' ? 'place' : 'win');
      $('#modal').classList.add('hidden');
    };
    document.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => { stakeEl.value = b.dataset.q; update(); }; });
    stakeEl.oninput = update;
    update();
  }

  function horseBetCard(b, showUser = false) {
    const outcome = b.status === 'void'
      ? (b.raceStatus === 'abandoned' ? 'Race abandoned — refunded' : 'Withdrawn — refunded')
      : b.position ? `Finished ${ordinal(b.position)}${b.dividend ? ` · dividend ${odd(b.dividend)}` : ''}` : '';
    return `<div class="card bet">
      <div class="bet-top"><div><strong>🐎 ${BET_TYPE_LABEL[b.betType]}</strong> <span class="muted small">#H${b.id}${showUser ? ` · ${esc(b.username)}` : ''} · ${esc(sqlDate(b.placedAt))}</span></div>
        <span class="badge ${b.status}">${b.status}</span></div>
      <div class="leg"><div><strong>${b.runnerNo}. ${esc(b.horse)}</strong>
        <div class="muted small">${esc(b.meeting)} · Race ${b.raceNo}${b.raceName ? ` · ${esc(b.raceName)}` : ''} · ${esc(when(b.postTime))}</div></div>
        <div class="r muted">${esc(outcome)}</div></div>
      <div class="bet-foot"><span>Stake <strong>${fmt(b.stake)}</strong></span>
        ${b.priceAtBet ? `<span>Price when placed <strong>${odd(b.priceAtBet)}</strong></span>` : ''}
        ${b.status === 'open' ? '<span>Pays the final dividend</span>' : `<span>Returned <strong class="${b.payout > 0 ? 'pos' : ''}">${fmt(b.payout)}</strong></span>`}</div>
    </div>`;
  }


  // ---------------------------------------------------------------- exotic bets

  const POOL_INFO = {
    EXACTA: { name: 'Forecast', picks: 2, ordered: true, about: 'Pick 1st and 2nd in the right order.' },
    QUINELLA: { name: 'Twin', picks: 2, ordered: false, about: 'Pick the first two, in any order.' },
    SWINGER: { name: 'Omni', picks: 2, ordered: false, about: 'Pick two horses that both finish in the top 3, in any order.' },
    TRIFECTA: { name: 'Trio', picks: 3, ordered: true, about: 'Pick 1st, 2nd and 3rd in the right order.' },
    SUPERFECTA: { name: 'Tetracast', picks: 4, ordered: true, about: 'Pick the first four in the right order.' },
  };
  const POOL_ORDER = ['EXACTA', 'QUINELLA', 'SWINGER', 'TRIFECTA', 'SUPERFECTA'];
  const MODE_LABEL = { straight: 'Straight', reverse: 'Reverse', box: 'Box', banker: 'Banker' };
  const POSITION_LABEL = ['1st', '2nd', '3rd', '4th'];

  function permutations(items, size) {
    if (size === 0) return [[]];
    return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)], size - 1).map((rest) => [x, ...rest]));
  }

  // Mirrors the server's expansion, to show the number of combinations and the cost before betting.
  function countCombos(pool, mode, sel) {
    const info = POOL_INFO[pool];
    let combos = [];
    if (mode === 'straight') {
      if (sel.positions.some((p) => !p.length)) return 0;
      combos = sel.positions.reduce((acc, ch) => acc.flatMap((c) => ch.filter((n) => !c.includes(n)).map((n) => [...c, n])), [[]]);
    } else if (mode === 'reverse') {
      combos = sel.horses.length === 2 ? permutations(sel.horses, 2) : [];
    } else if (mode === 'box') {
      combos = sel.horses.length >= info.picks ? permutations(sel.horses, info.picks) : [];
    } else if (mode === 'banker') {
      const others = sel.with.filter((n) => n !== sel.banker);
      combos = sel.banker && others.length >= info.picks - 1 ? permutations(others, info.picks - 1).map((r) => [sel.banker, ...r]) : [];
    }
    const key = (c) => (info.ordered ? c : [...c].sort((a, b) => a - b)).join('-');
    return new Set(combos.filter((c) => c.length === info.picks).map(key)).size;
  }

  function openExoticBet(race) {
    const pools = POOL_ORDER.filter((p) => race.pools.includes(p));
    const runners = race.runners.filter((u) => !u.withdrawn);
    const st = { pool: pools[0], mode: 'straight', pos: [], picks: new Set(), banker: null, unit: '1' };
    const modesFor = (p) => (p === 'EXACTA' ? ['straight', 'reverse', 'box', 'banker'] : ['straight', 'box', 'banker']);
    const resetPicks = () => { st.pos = Array.from({ length: POOL_INFO[st.pool].picks }, () => new Set()); st.picks = new Set(); st.banker = null; };
    resetPicks();

    // What the player picked, in the shape the server expects.
    const selection = () => {
      const info = POOL_INFO[st.pool];
      const picks = [...st.picks];
      if (st.mode === 'straight' && info.ordered) return { positions: st.pos.map((s) => [...s]) };
      if (st.mode === 'straight') return { positions: picks.length === 2 ? [[picks[0]], [picks[1]]] : [[], []] };
      if (st.mode === 'banker') return { banker: st.banker, with: picks };
      return { horses: picks };
    };
    const countSel = () => {
      const sel = selection();
      return countCombos(st.pool, st.mode, { positions: sel.positions || [], horses: sel.horses || [], banker: sel.banker, with: sel.with || [] });
    };

    modal(`<h3>More bets · ${raceTitle(race)}</h3>
      <p class="muted small">${esc(timeOnly(race.postTime))} · paid at the official dividend · combinations with a withdrawn horse are refunded</p>
      <form><div id="ex-body"></div><div class="error"></div>
        <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit" id="ex-submit">Place bet</button></div>
      </form>`, async () => {
      const res = await api('/horse-tickets', { kind: 'exotic', raceId: race.id, pool: st.pool, mode: st.mode, selections: selection(), unitStake: Number(st.unit) });
      state.user.balance = res.balance;
      renderChrome();
      toast(`${POOL_INFO[st.pool].name} placed — good luck!`);
    });
    $('#modal-card').classList.add('wide');

    const draw = () => {
      const info = POOL_INFO[st.pool];
      const cols = st.mode === 'straight' && info.ordered ? POSITION_LABEL.slice(0, info.picks)
        : st.mode === 'banker' ? ['Banker', 'With'] : [st.mode === 'box' ? 'Box' : 'Pick 2'];
      const cell = (u, c, i) => {
        if (st.mode === 'straight' && info.ordered) return `<input type="checkbox" data-pos="${i}" data-n="${u.number}" ${st.pos[i].has(u.number) ? 'checked' : ''} aria-label="${c} ${esc(u.horse)}">`;
        if (st.mode === 'banker' && c === 'Banker') return `<input type="radio" name="banker" data-banker="${u.number}" ${st.banker === u.number ? 'checked' : ''} aria-label="Banker ${esc(u.horse)}">`;
        return `<input type="checkbox" data-pick="${u.number}" ${st.picks.has(u.number) && st.banker !== u.number ? 'checked' : ''} ${st.mode === 'banker' && st.banker === u.number ? 'disabled' : ''} aria-label="${c} ${esc(u.horse)}">`;
      };
      const n = countSel();
      const unit = Number(st.unit) || 0;
      const hint = st.mode === 'straight' ? (info.ordered ? 'Tick one or more horses for each place.' : 'Tick exactly 2 horses.')
        : st.mode === 'reverse' ? 'Tick 2 horses: you get both orders (2 bets).'
          : st.mode === 'box' ? `Tick ${info.picks} or more horses: every order is covered.`
            : `Pick a banker${info.ordered ? ' to finish 1st' : ''}, then tick the horses to go with it.`;
      $('#ex-body').innerHTML = `
        <div class="tabs pools">${pools.map((p) => `<button type="button" data-pool="${p}" class="${p === st.pool ? 'active' : ''}">${POOL_INFO[p].name}</button>`).join('')}</div>
        <p class="small">${info.about}</p>
        <div class="chips">${modesFor(st.pool).map((m) => `<button type="button" class="chip ${m === st.mode ? 'active' : ''}" data-mode="${m}">${MODE_LABEL[m]}</button>`).join('')}</div>
        <p class="muted small">${hint}</p>
        <div class="table-wrap pick-grid"><table><thead><tr><th>Horse</th>${cols.map((c) => `<th class="c">${c}</th>`).join('')}</tr></thead><tbody>
          ${runners.map((u) => `<tr><td><strong>${u.number}.</strong> ${esc(u.horse)} <span class="muted small">${u.winPrice ? odd(u.winPrice) : ''}</span></td>
            ${cols.map((c, i) => `<td class="c">${cell(u, c, i)}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        <label for="ex-unit">Stake per combination (${esc(state.config.currency)})</label>
        <input id="ex-unit" type="number" inputmode="decimal" min="1" step="0.01" value="${esc(st.unit)}">
        <div class="summary"><span>Combinations</span><strong>${n}</strong></div>
        <div class="summary"><span>Total cost</span><strong>${fmt(n * unit)}</strong></div>`;
      $('#ex-submit').disabled = !n || unit < 1;
    };

    const body = () => $('#ex-body');
    $('#modal-card').onclick = (e) => {
      const t = e.target;
      if (!body()?.contains(t)) return;
      if (t.dataset.pool) { st.pool = t.dataset.pool; if (!modesFor(st.pool).includes(st.mode)) st.mode = 'straight'; resetPicks(); draw(); }
      else if (t.dataset.mode) { st.mode = t.dataset.mode; resetPicks(); draw(); }
    };
    $('#modal-card').onchange = (e) => {
      const t = e.target;
      if (t.dataset.pos) { const s = st.pos[Number(t.dataset.pos)]; const n = Number(t.dataset.n); t.checked ? s.add(n) : s.delete(n); }
      else if (t.dataset.banker) { st.banker = Number(t.dataset.banker); st.picks.delete(st.banker); }
      else if (t.dataset.pick) { const n = Number(t.dataset.pick); t.checked ? st.picks.add(n) : st.picks.delete(n); }
      else return;
      draw();
    };
    $('#modal-card').oninput = (e) => {
      if (e.target.id !== 'ex-unit') return;
      st.unit = e.target.value;
      const n = countSel();
      const unit = Number(st.unit) || 0;
      body().querySelectorAll('.summary strong')[1].textContent = fmt(n * unit);
      $('#ex-submit').disabled = !n || unit < 1;
    };
    draw();
  }

  // ---------------------------------------------------------------- parlays

  state.parlay = (() => { try { return JSON.parse(localStorage.getItem('pb_parlay')) || []; } catch { return []; } })();
  state.parlayStake = '';
  const saveParlay = () => { try { localStorage.setItem('pb_parlay', JSON.stringify(state.parlay)); } catch { /* storage unavailable */ } };

  function addParlayLeg(race, runner, betType) {
    // One horse per race: picking another horse in the same race replaces it.
    state.parlay = state.parlay.filter((l) => l.raceId !== race.id);
    state.parlay.push({ raceId: race.id, raceNo: race.raceNo, meeting: race.meeting, postTime: race.postTime,
      runnerNo: runner.number, horse: runner.horse, betType, price: betType === 'win' ? runner.winPrice : runner.placePrice });
    state.parlay.sort((a, b) => (a.postTime < b.postTime ? -1 : 1));
    saveParlay();
    renderParlay();
    toast(`${runner.horse} added to your parlay`);
  }

  function renderParlay() {
    const el = $('#parlay');
    // Legs whose race has started can no longer be bet.
    state.parlay = state.parlay.filter((l) => Date.parse(l.postTime) > Date.now());
    const show = state.user?.role === 'user' && state.parlay.length > 0 && currentView() === 'horses';
    el.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-parlay', show);
    if (!show) return;
    const stake = Number(state.parlayStake) || 0;
    const guide = state.parlay.reduce((acc, l) => acc * (l.price || 1), 1);
    el.innerHTML = `
      <div class="slip-head"><h3>Parlay <span class="count">${state.parlay.length}</span></h3>
        <button class="btn ghost small" id="parlay-clear">Clear</button></div>
      <p class="muted small">One horse in each race. Winnings roll on to the next leg; a withdrawn horse counts as 1.00, a loser ends the parlay.</p>
      ${state.parlay.map((l, i) => `<div class="sel">
        <div class="pick">${l.runnerNo}. ${esc(l.horse)}</div><div class="price">${l.price ? odd(l.price) : '–'}</div>
        <div class="meta">${BET_TYPE_LABEL[l.betType]} · ${esc(l.meeting)} race ${l.raceNo} · ${esc(timeOnly(l.postTime))}</div>
        <button class="remove" data-parlay-remove="${i}">Remove</button></div>`).join('')}
      ${state.parlay.length < 2 ? '<p class="muted small">Add a horse from another race to make a parlay.</p>' : ''}
      <label for="parlay-stake">Stake (${esc(state.config.currency)})</label>
      <input id="parlay-stake" type="number" inputmode="decimal" min="${state.config.minStake}" step="0.01" value="${esc(state.parlayStake)}" placeholder="0.00">
      <div class="quick">${[5, 10, 25, 50].map((v) => `<button class="btn ghost small" data-parlay-quick="${v}">${v}</button>`).join('')}</div>
      <div class="summary"><span>Prices multiplied (guide)</span><strong>${odd(guide)}</strong></div>
      <div class="summary"><span>Estimated return</span><strong class="pos">${fmt(stake * guide)}</strong></div>
      <button class="btn block" id="parlay-place" ${stake > 0 && state.parlay.length >= 2 ? '' : 'disabled'}>Place parlay</button>
      <p class="muted small">Paid at the official dividends, which can differ from the prices shown.</p>
      <div class="error" id="parlay-error"></div>`;
  }

  $('#parlay').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.id === 'parlay-clear') { state.parlay = []; saveParlay(); renderParlay(); return; }
    if (t.dataset.parlayRemove !== undefined) { state.parlay.splice(Number(t.dataset.parlayRemove), 1); saveParlay(); renderParlay(); return; }
    if (t.dataset.parlayQuick) { state.parlayStake = t.dataset.parlayQuick; renderParlay(); return; }
    if (t.id !== 'parlay-place') return;
    t.disabled = true;
    try {
      const res = await api('/horse-tickets', { kind: 'parlay', stake: Number(state.parlayStake),
        legs: state.parlay.map(({ raceId, runnerNo, betType }) => ({ raceId, runnerNo, betType })) });
      state.user.balance = res.balance;
      state.parlay = [];
      saveParlay();
      renderChrome();
      renderParlay();
      toast('Parlay placed — good luck!');
    } catch (err) {
      renderParlay();
      $('#parlay-error').textContent = err.message;
    }
  });
  $('#parlay').addEventListener('input', (e) => {
    if (e.target.id !== 'parlay-stake') return;
    state.parlayStake = e.target.value;
    const stake = Number(state.parlayStake) || 0;
    const guide = state.parlay.reduce((acc, l) => acc * (l.price || 1), 1);
    $('#parlay').querySelectorAll('.summary strong')[1].textContent = fmt(stake * guide);
    $('#parlay-place').disabled = !(stake > 0 && state.parlay.length >= 2);
  });

  function ticketCard(t, showUser = false) {
    const head = t.kind === 'parlay' ? `${t.legs.length}-race parlay` : `${t.poolName} · ${MODE_LABEL[t.mode] || ''}`;
    const name = (n) => (t.horses?.[n] ? `${n}. ${esc(t.horses[n])}` : String(n));
    let body;
    if (t.kind === 'parlay') {
      body = t.legs.map((l) => `<div class="leg"><div><strong>${l.runnerNo}. ${esc(l.horse)}</strong> · ${BET_TYPE_LABEL[l.betType]}
          <div class="muted small">${esc(l.meeting)} race ${l.raceNo} · ${esc(when(l.postTime))}${l.priceAtBet ? ` · price when placed ${odd(l.priceAtBet)}` : ''}</div></div>
        <div class="r">${l.position ? `<span class="muted">${ordinal(l.position)}</span> ` : ''}${l.dividend ? `<span class="muted">${odd(l.dividend)}</span> ` : ''}<span class="badge ${l.result}">${l.result === 'pending' ? 'open' : l.result}</span></div></div>`).join('');
    } else {
      const shown = t.combos.length <= 6 ? t.combos : t.combos.filter((c) => c.result === 'won');
      body = `<div class="leg"><div><div class="muted small">${esc(t.meeting)} · Race ${t.raceNo} · ${esc(when(t.postTime))}</div>
          ${shown.map((c) => `<div>${c.combo.split('-').map((n) => name(Number(n))).join(' → ')}${c.result !== 'pending' ? ` <span class="badge ${c.result}">${c.result}</span>` : ''}${c.dividend ? ` <span class="muted">${odd(c.dividend)}</span>` : ''}</div>`).join('')}
          ${t.combos.length > shown.length ? `<div class="muted small">${t.combos.length} combinations${shown.length ? `, ${shown.length} won` : ''}</div>` : ''}</div></div>`;
    }
    return `<div class="card bet">
      <div class="bet-top"><div><strong>🐎 ${esc(head)}</strong> <span class="muted small">#T${t.id}${showUser ? ` · ${esc(t.username)}` : ''} · ${esc(sqlDate(t.placedAt))}</span></div>
        <span class="badge ${t.status}">${t.status}</span></div>
      ${body}
      <div class="bet-foot">${t.kind === 'exotic' ? `<span>${t.lines} × <strong>${fmt(t.unitStake)}</strong></span>` : ''}<span>Stake <strong>${fmt(t.stake)}</strong></span>
        ${t.status === 'open' ? '<span>Pays the official dividend</span>' : `<span>Returned <strong class="${t.payout > 0 ? 'pos' : ''}">${fmt(t.payout)}</strong></span>`}</div>
    </div>`;
  }

  async function renderRacingAdmin(main) {
    const [{ pending, upcoming }, { bets }, { tickets }] = await Promise.all([api('/admin/races'),
      api('/admin/horse-bets?status=open'), api('/admin/horse-tickets?status=open')]);
    const all = [...pending, ...upcoming];
    main.innerHTML = `<h1>Racing</h1>
      <p class="muted">Results and dividends normally arrive from the racing feed and bets settle by themselves. Use this page when a result is late or wrong, a horse is withdrawn, or a race is abandoned.</p>
      <h2>Awaiting result (${pending.length})</h2>
      ${pending.length ? `<div class="card table-wrap"><table><thead><tr><th>Off</th><th>Race</th><th class="num">Open bets</th><th></th></tr></thead><tbody>
        ${pending.map((r) => `<tr><td class="muted">${esc(when(r.postTime))}</td><td><strong>${raceTitle(r)}</strong><div class="muted small">${esc(r.name || '')}</div></td>
          <td class="num">${r.openBets}</td><td><div class="actions"><button class="btn small" data-result="${esc(r.id)}">Enter result</button>
          <button class="btn danger small" data-abandon="${esc(r.id)}">Abandon</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty-state">Nothing waiting for a result.</div>'}
      <h2>Upcoming</h2>
      ${upcoming.length ? `<div class="card table-wrap"><table><thead><tr><th>Off</th><th>Race</th><th class="num">Open bets</th><th></th></tr></thead><tbody>
        ${upcoming.map((r) => `<tr><td class="muted">${esc(when(r.postTime))}</td><td><strong>${raceTitle(r)}</strong><div class="muted small">${esc(r.name || '')} · ${r.runners.length} runners</div></td>
          <td class="num">${r.openBets}</td><td><div class="actions"><button class="btn ghost small" data-withdraw="${esc(r.id)}">Withdraw a horse</button>
          <button class="btn danger small" data-abandon="${esc(r.id)}">Abandon</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty-state">No upcoming races.</div>'}
      <h2>Open horse bets (${bets.length + tickets.length})</h2>
      ${bets.length + tickets.length ? [...bets.map((b) => horseBetCard(b, true)), ...tickets.map((t) => ticketCard(t, true))].join('')
    : '<div class="empty-state">No open horse bets.</div>'}`;

    const byId = Object.fromEntries(all.map((r) => [r.id, r]));
    const done = (r) => { toast(`${r.settledBets} bet(s) settled`); render(); };
    main.querySelectorAll('[data-abandon]').forEach((b) => {
      b.onclick = () => {
        const r = byId[b.dataset.abandon];
        modal(`<h3>Abandon ${raceTitle(r)}?</h3><p class="muted">Every bet on this race is refunded.</p>
          <form><div class="error"></div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Abandon race</button></div></form>`,
        async () => done(await api(`/admin/races/${encodeURIComponent(r.id)}/abandon`, {})));
      };
    });
    main.querySelectorAll('[data-withdraw]').forEach((b) => {
      b.onclick = () => {
        const r = byId[b.dataset.withdraw];
        modal(`<h3>Withdraw a horse · ${raceTitle(r)}</h3><p class="muted small">Bets on the withdrawn horse are refunded straight away.</p>
          <form><label>Horse</label><select name="no">${r.runners.filter((u) => !u.withdrawn).map((u) => `<option value="${u.number}">${u.number}. ${esc(u.horse)}</option>`).join('')}</select>
          <div class="error"></div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Withdraw</button></div></form>`,
        async (f) => done(await api(`/admin/races/${encodeURIComponent(r.id)}/runners/${f.no}/withdraw`, {})));
      };
    });
    main.querySelectorAll('[data-result]').forEach((b) => {
      b.onclick = () => {
        const r = byId[b.dataset.result];
        const runners = r.runners.filter((u) => !u.withdrawn);
        modal(`<h3>Result · ${raceTitle(r)}</h3>
          <p class="muted small">Enter the finishing positions you know, the official win dividend for the winner and place dividends for the placed horses (${placeTerms(r.placesPaid).toLowerCase()}). Dividends are per 1 credit, stake included.</p>
          <form><div class="table-wrap"><table><thead><tr><th>Horse</th><th>Pos</th><th>Win div.</th><th>Place div.</th></tr></thead><tbody>
          ${runners.map((u) => `<tr><td>${u.number}. ${esc(u.horse)}</td>
            <td><input name="pos_${u.number}" type="number" min="1" class="mini"></td>
            <td><input name="win_${u.number}" type="number" step="0.01" min="1" class="mini"></td>
            <td><input name="place_${u.number}" type="number" step="0.01" min="1" class="mini" ${r.placesPaid ? '' : 'disabled'}></td></tr>`).join('')}
          </tbody></table></div>
          ${r.pools?.length ? `<p class="muted small">Other bets: enter each winning combination in finishing order (e.g. 6-9-3) and its dividend. A bet type left empty is refunded.</p>
            <div class="table-wrap"><table><thead><tr><th>Bet</th><th>Combination</th><th>Dividend</th></tr></thead><tbody>
            ${r.pools.flatMap((p) => Array.from({ length: p === 'SWINGER' ? 3 : 1 }, (_, i) => `<tr><td>${POOL_INFO[p].name}</td>
              <td><input name="combo_${p}_${i}" class="mini" placeholder="${Array.from({ length: POOL_INFO[p].picks }, (__, k) => k + 1).join('-')}"></td>
              <td><input name="div_${p}_${i}" type="number" step="0.01" min="1" class="mini"></td></tr>`)).join('')}
            </tbody></table></div>` : ''}
          <div class="error"></div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save result &amp; settle</button></div></form>`,
        async (f) => done(await api(`/admin/races/${encodeURIComponent(r.id)}/result`, {
          runners: runners.map((u) => ({ number: u.number, position: f[`pos_${u.number}`], winDividend: f[`win_${u.number}`], placeDividend: f[`place_${u.number}`] })),
          pools: Object.fromEntries((r.pools || []).map((p) => [p, Object.fromEntries(Array.from({ length: p === 'SWINGER' ? 3 : 1 }, (_, i) => [f[`combo_${p}_${i}`], f[`div_${p}_${i}`]])
            .filter(([c, d]) => c && d))])),
        })));
      };
    });
  }

  // ---------------------------------------------------------------- boot

  (async () => {
    state.config = await api('/config');
    document.title = state.config.siteName;
    $('#site-name').textContent = state.config.siteName;
    if (!state.config.oddsMode && state.config.racingMode) $('.brand-ball').textContent = '🐎';
    const demo = [state.config.oddsMode === 'demo' && 'football odds', state.config.racingMode === 'demo' && 'horse races'].filter(Boolean);
    $('#demo-banner').textContent = `Demo data: ${demo.join(' and ')} are simulated until a live feed is connected.`;
    $('#demo-banner').classList.toggle('hidden', !demo.length);
    await refreshMe();
    render();
  })();
})();
