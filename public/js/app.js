// Chip Tracker client: hash router, 2s polling, rendering and input handling.
// The server owns all chip math; this file only renders server state and
// sends actions (with expectedVersion, so two phones can't double-apply).

import { request } from './api.js';
import { clock, describe, fmt, parseChips, signed } from './format.js';

const POLL_MS = 2000;
const MAX_BACKOFF_MS = 15000;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const CHIP_COLUMNS = 3;
const CHIPS_PER_COLUMN = 8;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const app = {
  code: null,
  state: null,
  amount: '',
  busy: false,
  tab: 'table',
  pollTimer: null,
  pollFails: 0,
  rebuyPlayer: 0,
  prefetched: null,
};

// ---------------------------------------------------------------- storage

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: non-essential */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const ownerToken = (code) => store.get(`chip.owner.${code}`, null);

function rememberRoom(state) {
  const list = store.get('chip.recent', []).filter((r) => r.code !== state.roomCode);
  list.unshift({ code: state.roomCode, names: state.config.names, at: Date.now() });
  store.set('chip.recent', list.slice(0, 5));
}

function forgetRoom(code) {
  store.set('chip.recent', store.get('chip.recent', []).filter((r) => r.code !== code));
  store.remove(`chip.owner.${code}`);
}

// ---------------------------------------------------------------- feedback

let toastTimer = null;

function toast(text, { error = false, undoVersion = null } = {}) {
  const el = $('#toast');
  $('#toast-text').textContent = text;
  el.classList.toggle('is-error', error);
  const action = $('#toast-action');
  action.hidden = undoVersion === null;
  action.dataset.version = undoVersion ?? '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, undoVersion !== null ? 6000 : 3500);
}

function announce(text) {
  const live = $('#live');
  live.textContent = '';
  // Next frame so screen readers notice a repeated message.
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

function setSync(stateName) {
  const el = $('#sync');
  el.dataset.state = stateName;
  $('#sync-text').textContent = { ok: 'Live', busy: 'Saving…', offline: 'Offline' }[stateName];
}

function confirmDialog(title, text, okLabel) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

// ---------------------------------------------------------------- routing

function parseRoute() {
  // Shared links look like /r/CODE; normalise them to the hash route.
  const deep = location.pathname.match(/^\/r\/([A-Za-z0-9-]+)\/?$/);
  if (deep) history.replaceState(null, '', `/#/r/${deep[1].replace(/-/g, '').toUpperCase()}`);
  const m = location.hash.match(/^#\/r\/([A-Za-z0-9]+)(?:\/(history|summary))?$/);
  if (m) return { view: 'room', code: m[1].toUpperCase(), tab: m[2] || 'table' };
  return { view: 'home' };
}

async function route() {
  const r = parseRoute();
  if (r.view === 'home') {
    exitRoom();
    showHome();
    return;
  }
  if (r.code !== app.code) {
    const ok = await enterRoom(r.code);
    if (!ok) return;
  }
  setTab(r.tab);
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function showHome() {
  $('#view-room').hidden = true;
  $('#view-home').hidden = false;
  document.title = 'Chip Tracker';
  renderRecent();
}

async function enterRoom(code) {
  exitRoom();
  if (!CODE_RE.test(code)) {
    go('#/');
    showJoinError('That is not a valid room code.');
    return false;
  }
  app.code = code;
  app.amount = '';
  $('#view-home').hidden = true;
  $('#view-room').hidden = false;
  $('#room-code').textContent = code;
  $('#tab-table').href = `#/r/${code}`;
  $('#tab-history').href = `#/r/${code}/history`;
  $('#tab-summary').href = `#/r/${code}/summary`;
  setSync('busy');
  try {
    const data = app.prefetched?.roomCode === code ? { state: app.prefetched } : await request('GET', `/api/sessions/${code}`);
    app.prefetched = null;
    if (app.code !== code) return false;
    applyState(data.state);
    rememberRoom(data.state);
    setSync('ok');
    schedulePoll();
    return true;
  } catch (err) {
    if (err.status === 404) {
      roomGone(code);
    } else {
      // Keep the room open and keep retrying; the poller handles backoff.
      setSync('offline');
      toast(err.message, { error: true });
      app.pollFails = 1;
      schedulePoll(POLL_MS * 2);
    }
    return err.status !== 404;
  }
}

function exitRoom() {
  clearTimeout(app.pollTimer);
  app.code = null;
  app.state = null;
  app.pollFails = 0;
  $$('dialog[open]').forEach((d) => d.close());
}

function roomGone(code = app.code) {
  forgetRoom(code);
  exitRoom();
  go('#/');
  showJoinError('That room has ended or expired (rooms close after 24 hours without activity).');
}

function setTab(tab) {
  // Unsaved settings edits are dropped when leaving Summary, so the form
  // goes back to mirroring the live config.
  if (tab !== 'summary') delete $('#settings-form').dataset.dirty;
  app.tab = tab;
  for (const name of ['table', 'history', 'summary']) {
    $(`#panel-${name}`).hidden = name !== tab;
    $(`#tab-${name}`).setAttribute('aria-selected', String(name === tab));
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- sync

function schedulePoll(delay = POLL_MS) {
  clearTimeout(app.pollTimer);
  app.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  const code = app.code;
  if (!code || document.hidden) return; // resumed by visibilitychange
  if (app.busy) {
    schedulePoll();
    return;
  }
  try {
    const v = app.state ? `?v=${app.state.version}` : '';
    const data = await request('GET', `/api/sessions/${code}${v}`);
    if (app.code !== code) return;
    if (app.busy) {
      // Our own mutation is in flight; its response is authoritative.
      schedulePoll();
      return;
    }
    app.pollFails = 0;
    setSync('ok');
    if (data?.state) applyState(data.state, { remote: true });
  } catch (err) {
    if (app.code !== code) return;
    if (err.status === 404) {
      roomGone(code);
      return;
    }
    app.pollFails += 1;
    setSync('offline');
  }
  schedulePoll(app.pollFails ? Math.min(POLL_MS * 2 ** app.pollFails, MAX_BACKOFF_MS) : POLL_MS);
}

function applyState(next, { remote = false } = {}) {
  const prev = app.state;
  if (prev && prev.roomCode === next.roomCode && next.version < prev.version) return; // out-of-order
  app.state = next;
  if (prev && prev.roomCode === next.roomCode && prev.version !== next.version) {
    const changed = next.players.some((p, i) => p.stack !== prev.players[i].stack) || next.pot !== prev.pot;
    flashStacks(prev, next);
    if (changed) {
      const names = next.config.names;
      const last = next.log.length > prev.log.length ? `${describe(next.log.at(-1), names)}. ` : '';
      announce(`${last}${names[0]} ${fmt(next.players[0].stack)}, ${names[1]} ${fmt(next.players[1].stack)}, pot ${fmt(next.pot)}.`);
    }
    if (remote && next.log.length > prev.log.length) {
      toast(`Other phone: ${describe(next.log.at(-1), next.config.names)}`);
    } else if (remote && next.log.length < prev.log.length) {
      toast('Other phone undid the last action.');
    }
  }
  render();
}

/** Send a mutation. Returns the new state, or null if it failed. */
async function send(path, body, method = 'POST') {
  if (app.busy || !app.state) return null;
  app.busy = true;
  setSync('busy');
  renderTable();
  try {
    const data = await request(method, `/api/sessions/${app.code}${path}`, {
      ...body,
      expectedVersion: app.state.version,
    });
    applyState(data.state);
    setSync('ok');
    return data.state;
  } catch (err) {
    if (err.status === 409 && err.body?.state) {
      setSync('ok');
      applyState(err.body.state);
      toast('The other phone just changed the table. Check it and try again.', { error: true });
    } else if (err.status === 404) {
      roomGone();
    } else {
      if (err.status === 0) setSync('offline');
      else setSync('ok');
      toast(err.status === 0 ? 'No connection — nothing was saved.' : err.message, { error: true });
    }
    return null;
  } finally {
    app.busy = false;
    render();
  }
}

async function act(action) {
  const state = await send('/actions', action);
  if (state) toast(describe(state.log.at(-1), state.config.names), { undoVersion: state.version });
  return state;
}

async function undo() {
  const last = app.state?.log.at(-1);
  if (!last) return;
  const state = await send('/undo', {});
  if (state) toast(`Undone: ${describe(last, state.config.names)}`);
}

// ---------------------------------------------------------------- render

function render() {
  if (!app.state) return;
  document.title = `${app.state.roomCode} · Chip Tracker`;
  const { names } = app.state.config;
  $$('[data-name]').forEach((el) => {
    el.textContent = names[Number(el.dataset.name)];
  });
  renderTable();
  renderHistory();
  renderSummary();
}

function amountValue() {
  return app.amount ? Number(app.amount) : 0;
}

/** Label + action for a player's bet button given the typed amount. */
function betFor(p) {
  const s = app.state;
  const amount = amountValue();
  const stack = s.players[p].stack;
  const owes = s.toCall && s.toCall.player === p ? s.toCall.amount : 0;
  if (amount === 0) {
    if (owes) return { label: `Call ${fmt(owes)}`, action: { type: 'call', player: p } };
    return { label: stack ? 'Bet' : 'No chips', action: null };
  }
  if (amount > stack) return { label: `Has ${fmt(stack)}`, action: null };
  if (owes && amount === owes) return { label: `Call ${fmt(amount)}`, action: { type: 'call', player: p } };
  if (amount === stack) return { label: `All-in ${fmt(amount)}`, action: { type: 'allin', player: p } };
  return { label: `Bet ${fmt(amount)}`, action: { type: 'bet', player: p, amount } };
}

function renderTable() {
  const s = app.state;
  if (!s) return;
  const { names, sb, bb } = s.config;
  const hasBlinds = sb > 0 && bb > 0;
  const live = s.pot > 0;

  $('#hand-meta').textContent = `Hand ${s.handNumber}${hasBlinds ? ` · Blinds ${fmt(sb)}/${fmt(bb)}` : ''}`;
  $('#pot').textContent = fmt(s.pot);
  $('#undo-btn').disabled = app.busy || s.log.length === 0;

  const detail = $('#pot-detail');
  if (live) {
    // Per-player contributions are on the player cards; here only what's owed.
    detail.textContent = s.toCall
      ? `${names[s.toCall.player]} to call ${fmt(s.toCall.amount)}`
      : 'Bets are even — showdown or keep betting';
  } else {
    const last = s.log.at(-1);
    detail.textContent = last && ['fold', 'showdown', 'manual'].includes(last.type)
      ? `Last hand: ${describe(last, names)}`
      : '';
  }

  $('#pot-idle').hidden = live;
  $('#pot-live').hidden = !live;
  const blindsBtn = $('#blinds-btn');
  blindsBtn.hidden = !hasBlinds;
  blindsBtn.disabled = app.busy;
  blindsBtn.textContent = `Post blinds · ${names[s.button]} ${fmt(sb)} / ${names[1 - s.button]} ${fmt(bb)}`;
  $('#idle-hint').hidden = hasBlinds;
  $$('#pot-live [data-showdown]').forEach((b) => {
    b.disabled = app.busy;
  });

  const total = s.summary.totalBuyIn || 1;
  s.players.forEach((pl, p) => {
    const card = $(`.player[data-player="${p}"]`);
    const stackBtn = $('[data-role="stack"]', card);
    stackBtn.textContent = fmt(pl.stack);
    stackBtn.style.setProperty('--len', String(Math.max(4, stackBtn.textContent.length)));
    stackBtn.setAttribute('aria-label', `${names[p]}: ${fmt(pl.stack)} chips. Tap to correct.`);
    $('[data-role="dealer"]', card).hidden = !hasBlinds || s.button !== p;
    card.classList.toggle('is-behind', Boolean(s.toCall && s.toCall.player === p));

    const meta = $('[data-role="inpot"]', card);
    if (live) {
      const strong = document.createElement('strong');
      strong.textContent = fmt(pl.inPot);
      meta.replaceChildren(pl.stack === 0 ? 'All-in · ' : 'In pot ', strong);
    } else {
      const span = document.createElement('span');
      span.className = pl.net > 0 ? 'delta-up' : pl.net < 0 ? 'delta-down' : 'delta-zero';
      span.textContent = signed(pl.net);
      meta.replaceChildren('Net ', span);
    }

    $('[data-act="fold"]', card).disabled = app.busy || !live;
    $('[data-act="allin"]', card).disabled = app.busy || pl.stack === 0;

    // Chip columns show this player's share of every chip bought in.
    const n = pl.stack > 0 ? Math.max(1, Math.round((pl.stack / total) * CHIP_COLUMNS * CHIPS_PER_COLUMN)) : 0;
    $$('.chips i', card).forEach((col, i) => {
      const h = Math.min(Math.max(n - i * CHIPS_PER_COLUMN, 0), CHIPS_PER_COLUMN);
      col.style.setProperty('--n', String(h));
    });

    const bet = betFor(p);
    const btn = $(`[data-bet="${p}"]`);
    $('[data-role="bet-label"]', btn).textContent = bet.label;
    btn.disabled = app.busy || !bet.action;
  });

  const amountEl = $('#amount');
  amountEl.textContent = fmt(amountValue());
  amountEl.classList.toggle('is-empty', !app.amount);
  const step = bb > 0 ? bb : 100;
  $('#quick-bb').textContent = `+${fmt(step)}`;
  $('#quick-bb').setAttribute('aria-label', bb > 0 ? `Add one big blind (${fmt(step)})` : `Add ${fmt(step)}`);
  $('[data-quick="half"]').disabled = s.pot < 2;
  $('[data-quick="pot"]').disabled = s.pot < 1;
}

function flashStacks(prev, next) {
  next.players.forEach((pl, p) => {
    const diff = pl.stack - prev.players[p].stack;
    if (!diff) return;
    const el = $(`.player[data-player="${p}"] [data-role="stack"]`);
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth; // restart the animation
    el.classList.add(diff > 0 ? 'flash-up' : 'flash-down');
  });
}

function deltaSpan(name, d) {
  const span = document.createElement('span');
  span.className = d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : 'delta-zero';
  span.textContent = d === 0 ? name : `${name} ${signed(d)}`;
  return span;
}

function renderHistory() {
  const s = app.state;
  const { names } = s.config;
  const list = $('#history-list');
  const items = [];
  let hand = null;
  const entries = [...s.log].reverse();
  entries.forEach((e, i) => {
    if (e.hand !== hand) {
      hand = e.hand;
      const head = document.createElement('li');
      head.className = 'history-hand';
      head.textContent = `Hand ${hand}`;
      items.push(head);
    }
    const li = document.createElement('li');
    li.className = `history-item${i === 0 ? ' is-latest' : ''}`;
    const desc = document.createElement('span');
    desc.className = 'history-desc';
    desc.textContent = describe(e, names);
    const time = document.createElement('time');
    time.className = 'history-time';
    time.textContent = clock(e.ts);
    if (e.ts) time.dateTime = new Date(e.ts).toISOString();
    const deltas = document.createElement('span');
    deltas.className = 'history-deltas';
    const moved = [0, 1].filter((p) => e.deltas[p] !== 0);
    if (moved.length) deltas.append(...moved.map((p) => deltaSpan(names[p], e.deltas[p])));
    else deltas.append(deltaSpan('No change', 0));
    const stacks = document.createElement('span');
    stacks.className = 'history-stacks';
    stacks.textContent = `${fmt(e.stacks[0])} · ${fmt(e.stacks[1])}`;
    stacks.title = 'Stacks after this action';
    li.append(desc, time, deltas, stacks);
    items.push(li);
  });
  list.replaceChildren(...items);
  $('#history-empty').hidden = s.log.length > 0;

  const undoBtn = $('#history-undo');
  undoBtn.hidden = s.log.length === 0;
  undoBtn.disabled = app.busy;
  if (s.log.length) $('#history-undo-text').textContent = describe(s.log.at(-1), names);
  $('#manual-btn').disabled = s.handInProgress;
  $('#manual-btn').title = s.handInProgress ? 'Finish the current hand first' : '';
}

function renderSummary() {
  const s = app.state;
  const { names, chipValue } = s.config;
  const st = s.settlement;

  const line = $('#settle-line');
  if (st.from === null) {
    line.textContent = 'All square — nobody owes anything.';
  } else {
    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = `${fmt(st.chips)} chips`;
    line.replaceChildren(`${names[st.from]} owes ${names[st.to]} `, amt);
  }
  const money = $('#settle-money');
  money.hidden = st.value === null || st.from === null;
  money.textContent = st.value !== null ? `= ${fmt(st.value)} at ${fmt(chipValue)} per chip` : '';
  const note = $('#settle-note');
  note.hidden = st.potRefunded === 0;
  note.textContent = `A hand is in progress: the ${fmt(st.potRefunded)} in the pot is counted back to whoever put it in.`;
  const cv = $('#chip-value');
  if (document.activeElement !== cv) cv.value = chipValue ? String(chipValue) : '';

  $('#stat-hands').textContent = fmt(s.summary.handsPlayed);
  $('#stat-biggest').textContent = fmt(s.summary.biggestPot);
  $('#stat-total').textContent = fmt(s.summary.totalBuyIn);

  const rows = s.players.map((pl, p) => {
    const li = document.createElement('li');
    li.className = 'net-row';
    li.dataset.player = String(p);
    const name = document.createElement('span');
    name.className = 'net-name';
    name.textContent = names[p];
    const value = document.createElement('span');
    value.className = `net-value ${pl.net > 0 ? 'delta-up' : pl.net < 0 ? 'delta-down' : 'delta-zero'}`;
    value.textContent = signed(pl.net);
    const detail = document.createElement('span');
    detail.className = 'net-detail';
    const topups = pl.rebuys ? ` (${pl.rebuys} top-up${pl.rebuys > 1 ? 's' : ''})` : '';
    detail.textContent = `Stack ${fmt(pl.stack)} · In ${fmt(pl.buyIn)}${topups}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-tonal btn-sm';
    btn.textContent = 'Top up';
    btn.dataset.rebuy = String(p);
    btn.disabled = s.handInProgress || app.busy;
    btn.title = s.handInProgress ? 'Finish the current hand first' : '';
    btn.setAttribute('aria-label', `Top up ${names[p]}`);
    li.append(name, value, detail, btn);
    return li;
  });
  $('#net-list').replaceChildren(...rows);

  const form = $('#settings-form');
  if (!form.dataset.dirty) {
    $('#s-name0').value = names[0];
    $('#s-name1').value = names[1];
    $('#s-sb').value = s.config.sb ? String(s.config.sb) : '';
    $('#s-bb').value = s.config.bb ? String(s.config.bb) : '';
  }

  $('#share-code').textContent = s.roomCode;
  $('#expiry').textContent = `Closes ${new Date(s.expiresAt).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })} unless there is new activity.`;
  $('#end-btn').hidden = !ownerToken(s.roomCode);
}

function renderRecent() {
  const list = store.get('chip.recent', []);
  $('#recent').hidden = list.length === 0;
  $('#recent-list').replaceChildren(
    ...list.map((r) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'recent-item';
      a.href = `#/r/${r.code}`;
      const code = document.createElement('span');
      code.className = 'recent-code';
      code.textContent = r.code;
      const names = document.createElement('span');
      names.className = 'recent-names';
      names.textContent = `${r.names[0]} vs ${r.names[1]}`;
      a.append(code, names);
      li.append(a);
      return li;
    }),
  );
}

function showJoinError(text) {
  $('#join-error').textContent = text;
}

// ---------------------------------------------------------------- input

function pressKey(key) {
  if (key === 'back') app.amount = app.amount.slice(0, -1);
  else if (!app.amount && (key === '0' || key === '00')) return;
  else if ((app.amount + key).length <= 10) app.amount += key;
  renderTable();
}

function pressQuick(kind) {
  const s = app.state;
  if (kind === 'clear') app.amount = '';
  else if (kind === 'bb') app.amount = String(Math.min(amountValue() + (s.config.bb || 100), 9_999_999_999));
  else if (kind === 'half') app.amount = String(Math.floor(s.pot / 2));
  else if (kind === 'pot') app.amount = String(s.pot);
  if (app.amount === '0') app.amount = '';
  renderTable();
}

function fieldError(input, errorEl, message) {
  input?.setAttribute('aria-invalid', 'true');
  errorEl.textContent = message;
  input?.focus();
}

function clearErrors(form) {
  $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
  $$('.form-error', form).forEach((el) => {
    el.textContent = '';
  });
}

/** Optional blinds: both empty → 0/0. Returns {sb, bb} or {error, input}. */
function readBlinds(sbInput, bbInput) {
  const sbText = sbInput.value.trim();
  const bbText = bbInput.value.trim();
  if (!sbText && !bbText) return { sb: 0, bb: 0 };
  const sb = parseChips(sbText);
  const bb = parseChips(bbText);
  if (!(sb > 0)) return { error: 'Small blind must be a whole number above 0 (or leave both empty).', input: sbInput };
  if (!(bb > 0)) return { error: 'Big blind must be a whole number above 0 (or leave both empty).', input: bbInput };
  if (sb > bb) return { error: 'Small blind can’t be bigger than the big blind.', input: sbInput };
  return { sb, bb };
}

async function onCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  clearErrors(form);
  const err = $('#create-error');
  const stacks = [$('#c-stack0'), $('#c-stack1')];
  const values = stacks.map((i) => parseChips(i.value));
  for (const [i, v] of values.entries()) {
    if (!(v > 0) || v > 1_000_000_000) return fieldError(stacks[i], err, 'Starting stacks must be whole numbers above 0.');
  }
  const blinds = readBlinds($('#c-sb'), $('#c-bb'));
  if (blinds.error) return fieldError(blinds.input, err, blinds.error);
  const submit = $('#create-submit');
  submit.disabled = true;
  try {
    const data = await request('POST', '/api/sessions', {
      names: [$('#c-name0').value, $('#c-name1').value],
      startStacks: values,
      sb: blinds.sb,
      bb: blinds.bb,
    });
    store.set(`chip.owner.${data.roomCode}`, data.stateToken);
    app.prefetched = data.state;
    go(`#/r/${data.roomCode}`);
    toast(`Room ${data.roomCode} is ready. Share the code with the other player.`);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    submit.disabled = false;
  }
}

async function onJoin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  clearErrors(form);
  const input = $('#j-code');
  const code = input.value.toUpperCase().replace(/[\s-]/g, '');
  if (!CODE_RE.test(code)) {
    return fieldError(input, $('#join-error'), 'Room codes are 6 letters and digits, like ABC234.');
  }
  const submit = $('#join-submit');
  submit.disabled = true;
  try {
    const data = await request('GET', `/api/sessions/${code}`);
    app.prefetched = data.state;
    input.value = '';
    go(`#/r/${code}`);
  } catch (e) {
    fieldError(input, $('#join-error'), e.status === 404 ? 'No room with that code. It may have expired.' : e.message);
  } finally {
    submit.disabled = false;
  }
}

function openStackEdit(p) {
  if (app.busy || !app.state) return;
  const card = $(`.player[data-player="${p}"]`);
  const form = $('[data-role="stack-edit"]', card);
  $('[data-role="stack"]', card).hidden = true;
  form.hidden = false;
  const input = $('input', form);
  input.value = String(app.state.players[p].stack);
  input.removeAttribute('aria-invalid');
  input.focus();
  input.select();
}

function closeStackEdit(p, { focus = true } = {}) {
  const card = $(`.player[data-player="${p}"]`);
  $('[data-role="stack-edit"]', card).hidden = true;
  const btn = $('[data-role="stack"]', card);
  btn.hidden = false;
  if (focus) btn.focus();
}

async function submitStackEdit(p) {
  const card = $(`.player[data-player="${p}"]`);
  const input = $('[data-role="stack-edit"] input', card);
  const value = parseChips(input.value);
  if (!(value >= 0) || value > 1_000_000_000) {
    input.setAttribute('aria-invalid', 'true');
    toast('Enter a whole number of chips.', { error: true });
    return;
  }
  if (value === app.state.players[p].stack) {
    closeStackEdit(p);
    return;
  }
  const ok = await act({ type: 'adjust', player: p, stack: value });
  if (ok) closeStackEdit(p);
}

async function copyLink() {
  const code = app.state?.roomCode ?? app.code;
  const url = `${location.origin}/r/${code}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Chip Tracker room', text: `Join my chip tracker room: ${code}`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(`Join link copied. Room code: ${code}`);
  } catch {
    toast(`Room code: ${code} — share it with the other player.`);
  }
}

function bind() {
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && app.code) poll();
  });

  $('#create-form').addEventListener('submit', onCreate);
  $('#join-form').addEventListener('submit', onJoin);
  $('#create-form').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

  $('#room-code-btn').addEventListener('click', copyLink);
  $('#copy-link').addEventListener('click', copyLink);
  $('#undo-btn').addEventListener('click', undo);
  $('#history-undo').addEventListener('click', undo);
  $('#blinds-btn').addEventListener('click', () => act({ type: 'blinds' }));

  $('#toast-action').addEventListener('click', (e) => {
    $('#toast').hidden = true;
    // Only undo if the table is still exactly as it was when the toast appeared.
    if (app.state && String(app.state.version) === e.currentTarget.dataset.version) undo();
    else toast('The table has changed since then — use History to undo.', { error: true });
  });

  $('#pot-live').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-showdown]');
    if (!btn) return;
    const w = btn.dataset.showdown;
    act({ type: 'showdown', winner: w === 'split' ? 'split' : Number(w) });
  });

  $('#keypad').addEventListener('click', (e) => {
    const key = e.target.closest('button');
    if (!key || !app.state) return;
    if (key.dataset.key) pressKey(key.dataset.key);
    else if (key.dataset.quick) pressQuick(key.dataset.quick);
  });

  $$('[data-bet]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const bet = betFor(Number(btn.dataset.bet));
      if (!bet.action) return;
      const ok = await act(bet.action);
      if (ok) {
        app.amount = '';
        renderTable();
      }
    });
  });

  $$('.player').forEach((card) => {
    const p = Number(card.dataset.player);
    $('[data-act="fold"]', card).addEventListener('click', () => act({ type: 'fold', player: p }));
    $('[data-act="allin"]', card).addEventListener('click', () => act({ type: 'allin', player: p }));
    $('[data-role="stack"]', card).addEventListener('click', () => openStackEdit(p));
    $('[data-role="stack-cancel"]', card).addEventListener('click', () => closeStackEdit(p));
    const form = $('[data-role="stack-edit"]', card);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitStackEdit(p);
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeStackEdit(p);
      }
    });
  });

  // Physical keyboard on desktop: digits, Backspace, Escape drive the bet pad.
  document.addEventListener('keydown', (e) => {
    if (!app.state || app.tab !== 'table' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, dialog, textarea')) return;
    if (/^[0-9]$/.test(e.key)) pressKey(e.key);
    else if (e.key === 'Backspace') pressKey('back');
    else if (e.key === 'Escape') pressQuick('clear');
    else return;
    e.preventDefault();
  });

  // Dialogs
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  $('#manual-btn').addEventListener('click', () => {
    const form = $('#manual-form');
    form.reset();
    clearErrors(form);
    $('#dlg-manual').showModal();
    $('#manual-pot').focus();
  });
  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const input = $('#manual-pot');
    const pot = parseChips(input.value);
    if (!(pot >= 2)) return fieldError(input, $('#manual-error'), 'Enter the total pot (at least 2 chips).');
    if (pot % 2) return fieldError(input, $('#manual-error'), 'Pot must be even — each player put in half.');
    const w = new FormData(form).get('winner');
    const ok = await act({ type: 'manual', winner: w === 'split' ? 'split' : Number(w), pot });
    if (ok) $('#dlg-manual').close();
  });

  $('#net-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rebuy]');
    if (!btn) return;
    app.rebuyPlayer = Number(btn.dataset.rebuy);
    const form = $('#rebuy-form');
    form.reset();
    clearErrors(form);
    $('#rebuy-name').textContent = app.state.config.names[app.rebuyPlayer];
    $('#rebuy-amount').value = String(app.state.config.startStacks[app.rebuyPlayer]);
    $('#dlg-rebuy').showModal();
    $('#rebuy-amount').select();
  });
  $('#rebuy-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(e.currentTarget);
    const input = $('#rebuy-amount');
    const amount = parseChips(input.value);
    if (!(amount > 0)) return fieldError(input, $('#rebuy-error'), 'Enter a whole number of chips above 0.');
    const ok = await act({ type: 'rebuy', player: app.rebuyPlayer, amount });
    if (ok) $('#dlg-rebuy').close();
  });

  $('#chip-value-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chip-value');
    const raw = input.value.trim();
    const value = raw === '' ? 0 : parseChips(raw);
    if (!(value >= 0)) {
      input.setAttribute('aria-invalid', 'true');
      toast('Chip value must be a whole number.', { error: true });
      return;
    }
    input.removeAttribute('aria-invalid');
    input.blur();
    if (await send('/settings', { chipValue: value }, 'PATCH')) toast(value ? `1 chip = ${fmt(value)}` : 'Showing chips only');
  });

  const settings = $('#settings-form');
  settings.addEventListener('input', (e) => {
    settings.dataset.dirty = '1';
    e.target.removeAttribute('aria-invalid');
  });
  settings.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(settings);
    const blinds = readBlinds($('#s-sb'), $('#s-bb'));
    if (blinds.error) return fieldError(blinds.input, $('#settings-error'), blinds.error);
    const state = await send(
      '/settings',
      { names: [$('#s-name0').value, $('#s-name1').value], sb: blinds.sb, bb: blinds.bb },
      'PATCH',
    );
    if (state) {
      delete settings.dataset.dirty;
      renderSummary();
      toast('Settings saved');
    }
  });

  $('#leave-btn').addEventListener('click', () => go('#/'));
  $('#end-btn').addEventListener('click', async () => {
    const code = app.state.roomCode;
    const ok = await confirmDialog(
      'End this session?',
      'The room and its history are deleted for both phones. Settle up first.',
      'End session',
    );
    if (!ok) return;
    try {
      await request('DELETE', `/api/sessions/${code}`, undefined, { 'x-state-token': ownerToken(code) });
      forgetRoom(code);
      go('#/');
      toast('Session ended.');
    } catch (e) {
      toast(e.message, { error: true });
    }
  });
}

bind();
route();
