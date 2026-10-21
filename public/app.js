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
    $('#modal-card').innerHTML = html;
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

  const USER_VIEWS = { matches: 'Matches', bets: 'My bets', results: 'Results', history: 'Statement', account: 'Account' };
  const ADMIN_VIEWS = { users: 'Players', allbets: 'All bets', settle: 'Settlement', feed: 'Odds feed', results: 'Results', account: 'Account' };

  function currentView() {
    const views = state.user?.role === 'admin' ? ADMIN_VIEWS : USER_VIEWS;
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
    const views = state.user.role === 'admin' ? ADMIN_VIEWS : USER_VIEWS;
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
      return renderLogin(main);
    }
    const view = currentView();
    renderSlip();
    const views = {
      matches: renderMatches, bets: renderMyBets, results: renderResults, history: renderHistory, account: renderAccount,
      users: renderUsers, allbets: renderAllBets, settle: renderSettle, feed: renderFeed,
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
    const { bets } = await api('/bets');
    await refreshMe();
    renderChrome();
    const open = bets.filter((b) => b.status === 'open');
    const settled = bets.filter((b) => b.status !== 'open');
    main.innerHTML = `<h1>My bets</h1>
      ${!bets.length ? '<div class="empty-state">You haven\'t placed any bets yet.</div>' : ''}
      ${open.length ? `<h2>Open (${open.length})</h2>${open.map((b) => betCard(b)).join('')}` : ''}
      ${settled.length ? `<h2>Settled</h2>${settled.map((b) => betCard(b)).join('')}` : ''}`;
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
        <td class="muted">${t.betId ? `Bet #${t.betId}` : ''}${t.note ? esc(t.note) : ''}</td>
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
        <div class="card stat"><div class="v">${status.upcomingEvents}</div><div class="k">Upcoming matches</div></div>
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
    main.innerHTML = `<h1>Odds feed</h1>
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
        <button class="btn" id="refresh">Refresh odds &amp; results now</button>
        ${s.oddsMode === 'live' ? '<p class="muted small">Each refresh uses API credits (2 per league for odds).</p>' : ''}
      </div>`;
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

  // ---------------------------------------------------------------- boot

  (async () => {
    state.config = await api('/config');
    document.title = state.config.siteName;
    $('#site-name').textContent = state.config.siteName;
    $('#demo-banner').classList.toggle('hidden', state.config.oddsMode !== 'demo');
    await refreshMe();
    render();
  })();
})();
