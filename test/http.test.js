// Smoke test: real HTTP server on a random port, in-memory SQLite.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, cleanupExpired, CODE_ALPHABET } from '../server/app.js';
import { openDb } from '../server/db.js';

let server;
let base;
let db;
let clock = Date.now();

before(async () => {
  db = openDb(':memory:');
  const app = createApp({ db, now: () => clock, createLimit: { max: 12, windowMs: 60_000 } });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

function assertStateShape(s) {
  assert.equal(typeof s.roomCode, 'string');
  assert.ok(Number.isInteger(s.version));
  assert.ok(Array.isArray(s.players) && s.players.length === 2);
  for (const p of s.players) {
    for (const k of ['stack', 'buyIn', 'inPot', 'net', 'rebuys']) assert.ok(Number.isInteger(p[k]), `player.${k}`);
    assert.equal(typeof p.name, 'string');
  }
  for (const k of ['pot', 'handNumber', 'button', 'expiresAt']) assert.ok(Number.isInteger(s[k]), k);
  assert.equal(typeof s.handInProgress, 'boolean');
  assert.ok(Array.isArray(s.log));
  assert.ok(Number.isInteger(s.summary.handsPlayed));
  assert.ok(Number.isInteger(s.settlement.chips));
  assert.deepEqual(Object.keys(s.config).sort(), ['bb', 'chipValue', 'names', 'sb', 'startStacks']);
}

test('health endpoint', async () => {
  const r = await api('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('full flow: create → join → 3 actions → read → undo', async () => {
  const created = await api('POST', '/api/sessions', {
    names: ['An', 'Bình'],
    startStacks: [1000, 1500],
    sb: 5,
    bb: 10,
  });
  assert.equal(created.status, 201);
  const { roomCode, stateToken, state } = created.json;
  assert.match(roomCode, new RegExp(`^[${CODE_ALPHABET}]{6}$`));
  assert.equal(typeof stateToken, 'string');
  assert.ok(stateToken.length >= 32);
  assertStateShape(state);
  assert.deepEqual(state.players.map((p) => p.stack), [1000, 1500]);

  // Join from "the other phone" (lower-case + dash tolerated).
  const joinCode = `${roomCode.slice(0, 3).toLowerCase()}-${roomCode.slice(3)}`;
  const joined = await api('GET', `/api/sessions/${joinCode}`);
  assert.equal(joined.status, 200);
  assertStateShape(joined.json.state);
  assert.equal(joined.json.state.roomCode, roomCode);
  assert.equal(joined.json.state.version, 0);

  const act = (body) => api('POST', `/api/sessions/${roomCode}/actions`, body);
  let r = await act({ type: 'blinds' });
  assert.equal(r.status, 200);
  r = await act({ type: 'bet', player: 0, amount: 95 });
  assert.equal(r.status, 200);
  r = await act({ type: 'call', player: 1, expectedVersion: 2 });
  assert.equal(r.status, 200);
  assertStateShape(r.json.state);
  assert.equal(r.json.state.version, 3);

  const read = await api('GET', `/api/sessions/${roomCode}`);
  const s = read.json.state;
  assert.deepEqual(s.players.map((p) => p.stack), [900, 1400]);
  assert.equal(s.pot, 200);
  assert.equal(s.handInProgress, true);
  assert.equal(s.log.length, 3);
  assert.deepEqual(s.log[2].deltas, [0, -90]);
  assert.equal(s.toCall, null);

  // Polling with the current version → 204, no body.
  const poll = await api('GET', `/api/sessions/${roomCode}?v=3`);
  assert.equal(poll.status, 204);

  const undo = await api('POST', `/api/sessions/${roomCode}/undo`, { expectedVersion: 3 });
  assert.equal(undo.status, 200);
  const u = undo.json.state;
  assert.deepEqual(u.players.map((p) => p.stack), [900, 1490]);
  assert.equal(u.pot, 110);
  assert.deepEqual(u.toCall, { player: 1, amount: 90 });
  assert.equal(u.log.length, 2);
  assert.equal(u.version, 4);
  // Conservation over the wire too.
  assert.equal(u.players[0].stack + u.players[1].stack + u.pot, 2500);
});

test('validation: bad input never changes state', async () => {
  const { json } = await api('POST', '/api/sessions', { startStacks: [500, 500] });
  const code = json.roomCode;
  assert.deepEqual(json.state.config.names, ['Bạn', 'Đối thủ']);
  const bad = [
    { type: 'bet', player: 0, amount: 12.5 },
    { type: 'bet', player: 0, amount: -10 },
    { type: 'bet', player: 0, amount: '50' },
    { type: 'bet', player: 0, amount: 501 },
    { type: 'bet', player: 3, amount: 5 },
    { type: 'fold', player: 0 },
    { type: 'showdown', winner: 0 },
    { type: 'blinds' }, // no blinds configured
    { type: 'nope' },
  ];
  for (const body of bad) {
    const r = await api('POST', `/api/sessions/${code}/actions`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.json.message, 'string');
  }
  const r = await api('POST', `/api/sessions/${code}/actions`, '{not json');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad_json');
  const after = await api('GET', `/api/sessions/${code}`);
  assert.equal(after.json.state.version, 0);
  assert.deepEqual(after.json.state.players.map((p) => p.stack), [500, 500]);

  for (const body of [{ startStacks: [0, 100] }, { startStacks: [100] }, { startStacks: [1.5, 100] }, {}]) {
    const c = await api('POST', '/api/sessions', body);
    assert.equal(c.status, 400, JSON.stringify(body));
  }
  const nothing = await api('POST', `/api/sessions/${code}/undo`, {});
  assert.equal(nothing.status, 400);
});

test('stale expectedVersion → 409 with fresh state', async () => {
  const { json } = await api('POST', '/api/sessions', { startStacks: [100, 100] });
  await api('POST', `/api/sessions/${json.roomCode}/actions`, { type: 'bet', player: 0, amount: 10 });
  const r = await api('POST', `/api/sessions/${json.roomCode}/actions`, {
    type: 'bet',
    player: 1,
    amount: 10,
    expectedVersion: 0,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'stale');
  assert.equal(r.json.state.version, 1);
  assert.equal(r.json.state.pot, 10);
});

test('settings, rebuy and settlement', async () => {
  const { json } = await api('POST', '/api/sessions', { startStacks: [1000, 1000] });
  const code = json.roomCode;
  let r = await api('PATCH', `/api/sessions/${code}/settings`, { names: ['Hà', 'Minh'], sb: 10, bb: 20, chipValue: 1000 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.state.config.names, ['Hà', 'Minh']);
  r = await api('PATCH', `/api/sessions/${code}/settings`, { sb: 30 });
  assert.equal(r.status, 400);
  await api('POST', `/api/sessions/${code}/actions`, { type: 'manual', winner: 1, pot: 600 });
  r = await api('POST', `/api/sessions/${code}/actions`, { type: 'rebuy', player: 0, amount: 300 });
  const s = r.json.state;
  assert.deepEqual(s.players.map((p) => p.stack), [1000, 1300]);
  assert.deepEqual(s.players.map((p) => p.net), [-300, 300]);
  assert.deepEqual(
    { from: s.settlement.from, to: s.settlement.to, chips: s.settlement.chips, value: s.settlement.value },
    { from: 0, to: 1, chips: 300, value: 300_000 },
  );
  assert.equal(s.log.at(-1).type, 'rebuy');
});

test('owner token is required to end a session', async () => {
  const { json } = await api('POST', '/api/sessions', { startStacks: [100, 100] });
  const path = `/api/sessions/${json.roomCode}`;
  assert.equal((await api('DELETE', path, undefined, { 'x-state-token': 'wrong' })).status, 403);
  assert.equal((await api('DELETE', path)).status, 403);
  assert.equal((await api('DELETE', path, undefined, { 'x-state-token': json.stateToken })).status, 204);
  assert.equal((await api('GET', path)).status, 404);
});

test('sessions expire after 24h of inactivity', async () => {
  const { json } = await api('POST', '/api/sessions', { startStacks: [100, 100] });
  const path = `/api/sessions/${json.roomCode}`;
  clock += 23 * 3600_000;
  assert.equal((await api('GET', path)).status, 200);
  clock += 2 * 3600_000;
  assert.equal((await api('GET', path)).status, 404);
  // The cleanup job removes everything idle for > 24h.
  assert.ok(cleanupExpired(db, 24 * 3600_000, clock) >= 1);
  assert.equal(db.getSession(json.roomCode), null);
});

test('create endpoint is rate limited per IP', async () => {
  let last;
  for (let i = 0; i < 13; i++) last = await api('POST', '/api/sessions', { startStacks: [100, 100] });
  assert.equal(last.status, 429);
  assert.equal(last.json.error, 'rate_limited');
});

test('static client is served with security headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const unknown = await api('GET', '/api/nope');
  assert.equal(unknown.status, 404);
});
