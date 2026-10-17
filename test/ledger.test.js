import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LedgerError,
  applyEvent,
  buildEvent,
  initialState,
  normalizeConfig,
  replay,
  settle,
  summarize,
} from '../server/ledger.js';

const config = normalizeConfig({ startStacks: [1000, 1000], sb: 5, bb: 10 });

// Apply a list of actions the same way the server does: build, then apply.
function play(actions, cfg = config) {
  let state = initialState(cfg);
  const events = [];
  for (const action of actions) {
    const event = buildEvent(action, state, cfg);
    state = applyEvent(state, event);
    events.push(event);
  }
  return { state, events };
}

const stacks = (s) => s.players.map((p) => p.stack);
const total = (s) => s.players[0].stack + s.players[1].stack + s.pot;
const buyIns = (s) => s.players[0].buyIn + s.players[1].buyIn;

test('config: defaults names, validates stacks and blinds', () => {
  assert.deepEqual(config.names, ['Bạn', 'Đối thủ']);
  assert.throws(() => normalizeConfig({ startStacks: [0, 1000] }), LedgerError);
  assert.throws(() => normalizeConfig({ startStacks: [10.5, 1000] }), LedgerError);
  assert.throws(() => normalizeConfig({ startStacks: ['1000', 1000] }), LedgerError);
  assert.throws(() => normalizeConfig({ startStacks: [1000, 1000], sb: 10, bb: 5 }), /small blind/);
  assert.throws(() => normalizeConfig({ startStacks: [1000, 1000], sb: 5 }), /both blinds/);
  assert.throws(() => normalizeConfig({ startStacks: [1000, 1000], names: ['x'.repeat(25), 'b'] }), /24/);
});

test('bet moves chips from stack to pot', () => {
  const { state } = play([{ type: 'bet', player: 0, amount: 200 }]);
  assert.deepEqual(stacks(state), [800, 1000]);
  assert.equal(state.pot, 200);
  assert.equal(state.players[0].inPot, 200);
  assert.deepEqual(state.log[0].deltas, [-200, 0]);
});

test('bet rejects floats, zero, negatives and overdrafts', () => {
  const s = initialState(config);
  for (const amount of [0, -5, 2.5, '100', NaN, Infinity]) {
    assert.throws(() => buildEvent({ type: 'bet', player: 0, amount }, s, config), LedgerError, `amount ${amount}`);
  }
  assert.throws(() => applyEvent(s, { type: 'bet', player: 0, amount: 1001 }), /not enough chips/);
  assert.throws(() => buildEvent({ type: 'bet', player: 2, amount: 10 }, s, config), /player/);
});

test('fold gives the whole pot to the other player and ends the hand', () => {
  const { state } = play([
    { type: 'blinds' },
    { type: 'bet', player: 0, amount: 95 }, // SB raises to 100
    { type: 'fold', player: 1 }, // BB folds
  ]);
  assert.deepEqual(stacks(state), [1010, 990]);
  assert.equal(state.pot, 0);
  assert.equal(state.handsPlayed, 1);
  assert.equal(state.handNumber, 2);
  assert.equal(state.button, 1, 'button moves after each hand');
});

test('fold with an empty pot is rejected', () => {
  assert.throws(() => play([{ type: 'fold', player: 0 }]), /nothing in the pot/);
});

test('showdown: player 1 wins', () => {
  const { state } = play([
    { type: 'bet', player: 0, amount: 300 },
    { type: 'call', player: 1 },
    { type: 'showdown', winner: 0 },
  ]);
  assert.deepEqual(stacks(state), [1300, 700]);
  assert.equal(state.biggestPot, 600);
});

test('showdown: player 1 loses', () => {
  const { state } = play([
    { type: 'bet', player: 0, amount: 250 },
    { type: 'bet', player: 1, amount: 250 },
    { type: 'showdown', winner: 1 },
  ]);
  assert.deepEqual(stacks(state), [750, 1250]);
});

test('showdown: split returns each contribution', () => {
  const { state } = play([
    { type: 'blinds' },
    { type: 'call', player: 0 },
    { type: 'bet', player: 1, amount: 40 },
    { type: 'call', player: 0 },
    { type: 'showdown', winner: 'split' },
  ]);
  assert.deepEqual(stacks(state), [1000, 1000]);
  assert.equal(state.biggestPot, 100);
});

test('showdown refunds the uncalled part of an all-in', () => {
  const cfg = normalizeConfig({ startStacks: [300, 1000] });
  const { state } = play(
    [
      { type: 'bet', player: 1, amount: 500 },
      { type: 'allin', player: 0 }, // can only call 300
      { type: 'showdown', winner: 0 },
    ],
    cfg,
  );
  // P1 wins 600 (300 matched each); 200 uncalled goes back to P2.
  assert.deepEqual(stacks(state), [600, 700]);
  assert.equal(total(state), 1300);
});

test('call is capped at the remaining stack and requires a deficit', () => {
  const cfg = normalizeConfig({ startStacks: [100, 1000] });
  const s = applyEvent(initialState(cfg), { type: 'bet', player: 1, amount: 400 });
  const call = buildEvent({ type: 'call', player: 0 }, s, cfg);
  assert.equal(call.amount, 100);
  assert.throws(() => buildEvent({ type: 'call', player: 1 }, s, cfg), /nothing to call/);
});

test('blinds alternate the button and short stacks post all-in', () => {
  const { state } = play([{ type: 'blinds' }]);
  assert.deepEqual(stacks(state), [995, 990]);
  assert.throws(() => play([{ type: 'blinds' }, { type: 'blinds' }]), /finish the current hand/);
  const cfg = normalizeConfig({ startStacks: [3, 1000], sb: 5, bb: 10 });
  const short = play([{ type: 'blinds' }], cfg).state;
  assert.deepEqual(stacks(short), [0, 990]);
  const noBlinds = normalizeConfig({ startStacks: [100, 100] });
  assert.throws(() => play([{ type: 'blinds' }], noBlinds), /blinds are not set/);
});

test('undo (replay without the last event) restores exact stacks', () => {
  const { events, state: full } = play([
    { type: 'blinds' },
    { type: 'bet', player: 0, amount: 95 },
    { type: 'call', player: 1 },
    { type: 'showdown', winner: 1 },
  ]);
  assert.deepEqual(stacks(full), [900, 1100]);
  const rows = events.map((event, i) => ({ event, seq: i + 1, ts: i }));
  const undone = replay(config, rows.slice(0, -1));
  assert.deepEqual(stacks(undone), [900, 900]);
  assert.equal(undone.pot, 200);
  assert.equal(undone.handsPlayed, 0);
  assert.equal(undone.button, 0, 'button restored by undo');
  const undoneTwice = replay(config, rows.slice(0, -2));
  assert.deepEqual(stacks(undoneTwice), [900, 990]);
  assert.deepEqual(stacks(replay(config, [])), [1000, 1000]);
});

test('rebuy adds to stack and buy-in, only between hands', () => {
  const { state } = play([
    { type: 'bet', player: 0, amount: 1000 },
    { type: 'call', player: 1 },
    { type: 'showdown', winner: 1 },
    { type: 'rebuy', player: 0, amount: 500 },
  ]);
  assert.deepEqual(stacks(state), [500, 2000]);
  assert.equal(state.players[0].buyIn, 1500);
  assert.equal(state.players[0].rebuys, 1);
  assert.throws(
    () => play([{ type: 'bet', player: 0, amount: 10 }, { type: 'rebuy', player: 0, amount: 100 }]),
    /finish the current hand/,
  );
});

test('stack correction is accounted as a top-up / cash-out', () => {
  const { state } = play([{ type: 'adjust', player: 1, stack: 1200 }]);
  assert.deepEqual(stacks(state), [1000, 1200]);
  assert.equal(state.players[1].buyIn, 1200);
  assert.equal(settle(state).chips, 0, 'a correction never changes who owes whom');
  assert.throws(() => play([{ type: 'adjust', player: 1, stack: -1 }]), LedgerError);
  assert.throws(() => play([{ type: 'adjust', player: 1, stack: 1000 }]), /already/);
});

test('manual hand moves half the pot from loser to winner', () => {
  const { state } = play([{ type: 'manual', winner: 1, pot: 300 }]);
  assert.deepEqual(stacks(state), [850, 1150]);
  assert.equal(state.handsPlayed, 1);
  assert.equal(state.biggestPot, 300);
  assert.throws(() => play([{ type: 'manual', winner: 1, pot: 301 }]), /even/);
  assert.throws(() => play([{ type: 'manual', winner: 0, pot: 2002 }]), /not enough chips/);
  const split = play([{ type: 'manual', winner: 'split', pot: 200 }]).state;
  assert.deepEqual(stacks(split), [1000, 1000]);
});

test('settle: who owes whom, including rebuys and chip value', () => {
  const { state } = play([
    { type: 'bet', player: 0, amount: 1000 },
    { type: 'call', player: 1 },
    { type: 'showdown', winner: 1 }, // P2 up 1000
    { type: 'rebuy', player: 0, amount: 1000 },
    { type: 'bet', player: 1, amount: 400 },
    { type: 'call', player: 0 },
    { type: 'showdown', winner: 0 }, // P1 wins back 400
  ]);
  assert.deepEqual(stacks(state), [1400, 1600]);
  const s = settle(state, 2000); // 1 chip = 2,000 (e.g. VND)
  assert.deepEqual(s.nets, [-600, 600]);
  assert.equal(s.from, 0);
  assert.equal(s.to, 1);
  assert.equal(s.chips, 600);
  assert.equal(s.value, 1_200_000);
  assert.ok(Number.isInteger(s.value));
});

test('settle refunds an unfinished pot to its contributors', () => {
  const { state } = play([{ type: 'bet', player: 0, amount: 300 }]);
  const s = settle(state);
  assert.deepEqual(s.nets, [0, 0]);
  assert.equal(s.from, null);
  assert.equal(s.potRefunded, 300);
});

test('chip conservation invariant holds through a long random session', () => {
  // Deterministic pseudo-random sequence (LCG) so failures are reproducible.
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  let state = initialState(config);
  let accepted = 0;
  for (let i = 0; i < 2000; i++) {
    const p = rand(2);
    const choices = [
      { type: 'bet', player: p, amount: 1 + rand(300) },
      { type: 'call', player: p },
      { type: 'allin', player: p },
      { type: 'blinds' },
      { type: 'fold', player: p },
      { type: 'showdown', winner: [0, 1, 'split'][rand(3)] },
      { type: 'manual', winner: p, pot: 2 * (1 + rand(50)) },
    ];
    // Rebuys are the only way chips may enter; keep them rare.
    if (rand(40) === 0) choices.push({ type: 'rebuy', player: p, amount: 500 });
    const action = choices[rand(choices.length)];
    const before = total(state);
    try {
      state = applyEvent(state, buildEvent(action, state, config));
      accepted++;
    } catch (err) {
      assert.ok(err instanceof LedgerError, `unexpected ${err}`);
      assert.notEqual(err.code, 'invariant');
      continue;
    }
    const delta = total(state) - before;
    if (action.type === 'rebuy') assert.equal(delta, action.amount);
    else assert.equal(delta, 0, `chips created/destroyed by ${JSON.stringify(action)}`);
    assert.equal(total(state), buyIns(state));
    assert.ok(state.players.every((pl) => pl.stack >= 0));
    const s = settle(state);
    assert.equal(s.nets[0] + s.nets[1], 0, 'settlement is zero-sum');
  }
  assert.ok(accepted > 500, `only ${accepted} actions accepted`);
  assert.equal(summarize(state).totalBuyIn, buyIns(state));
});

test('replay is deterministic and matches incremental state', () => {
  const { state, events } = play([
    { type: 'blinds' },
    { type: 'call', player: 0 },
    { type: 'fold', player: 1 },
    { type: 'blinds' },
    { type: 'allin', player: 0 },
    { type: 'call', player: 1 },
    { type: 'showdown', winner: 'split' },
  ]);
  const rebuilt = replay(config, events.map((event, i) => ({ event, seq: i + 1, ts: 0 })));
  assert.deepEqual(stacks(rebuilt), stacks(state));
  assert.equal(rebuilt.button, state.button);
  assert.equal(rebuilt.log.length, 7);
});
