// Pure chip ledger for a heads-up session.
//
// The session is event-sourced: state is always the result of replaying the
// stored events on top of the session config. That makes undo trivially
// correct (drop the last event, replay) and means the server never stores a
// derived number that could drift from the log.
//
// Invariant (checked after every event):
//   stack[0] + stack[1] + pot === buyIn[0] + buyIn[1]
// Chips only enter the table through buy-ins (start stack, rebuys, and stack
// corrections, which are accounted as top-ups / cash-outs).

export const MAX_CHIPS = 1_000_000_000; // per amount; keeps all sums far below 2^53
export const PLAYERS = [0, 1];

export class LedgerError extends Error {
  constructor(message, code = 'invalid_action') {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const other = (p) => (p === 0 ? 1 : 0);

export function isChipInt(n, { min = 0, max = MAX_CHIPS } = {}) {
  return Number.isSafeInteger(n) && n >= min && n <= max;
}

function requirePlayer(p) {
  if (p !== 0 && p !== 1) throw new LedgerError('player must be 0 or 1');
}

function requireAmount(n, label = 'amount', min = 1) {
  if (!isChipInt(n, { min })) {
    throw new LedgerError(`${label} must be a whole number of chips between ${min} and ${MAX_CHIPS}`);
  }
}

/**
 * Validate and normalise a session config.
 * config = { names: [string, string], startStacks: [int, int], sb, bb, chipValue }
 */
export function normalizeConfig(input = {}) {
  const names = Array.isArray(input.names) ? input.names : [];
  const out = {
    names: PLAYERS.map((p) => cleanName(names[p], p === 0 ? 'Bạn' : 'Đối thủ')),
    startStacks: PLAYERS.map((p) => (Array.isArray(input.startStacks) ? input.startStacks[p] : undefined)),
    sb: input.sb ?? 0,
    bb: input.bb ?? 0,
    chipValue: input.chipValue ?? 0,
  };
  out.startStacks.forEach((s, p) => requireAmount(s, `starting stack for player ${p + 1}`, 1));
  validateBlinds(out.sb, out.bb);
  if (!isChipInt(out.chipValue)) throw new LedgerError('chip value must be a whole number ≥ 0');
  return out;
}

export function validateBlinds(sb, bb) {
  if (!isChipInt(sb) || !isChipInt(bb)) throw new LedgerError('blinds must be whole numbers ≥ 0');
  if ((sb === 0) !== (bb === 0)) throw new LedgerError('set both blinds or neither');
  if (sb > bb) throw new LedgerError('small blind cannot be larger than big blind');
}

export function cleanName(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new LedgerError('names must be text');
  // Strip control characters, collapse whitespace.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return fallback;
  if ([...name].length > 24) throw new LedgerError('names must be at most 24 characters');
  return name;
}

export function initialState(config) {
  return {
    players: PLAYERS.map((p) => ({
      stack: config.startStacks[p],
      buyIn: config.startStacks[p],
      inPot: 0, // contribution to the current hand
      rebuys: 0,
    })),
    pot: 0,
    handNumber: 1, // the hand currently being played (or about to be)
    button: 0, // player who posts the small blind this hand
    blindsPosted: false,
    handsPlayed: 0,
    biggestPot: 0,
    log: [],
  };
}

function clone(state) {
  return {
    ...state,
    players: state.players.map((pl) => ({ ...pl })),
    log: state.log, // append-only; replaced, never mutated in place
  };
}

function put(state, p, amount) {
  const pl = state.players[p];
  if (amount > pl.stack) {
    throw new LedgerError(`not enough chips: stack is ${pl.stack}, tried to put in ${amount}`, 'insufficient_chips');
  }
  pl.stack -= amount;
  pl.inPot += amount;
  state.pot += amount;
}

function endHand(state, potSize) {
  for (const pl of state.players) pl.inPot = 0;
  state.pot = 0;
  state.handsPlayed += 1;
  state.biggestPot = Math.max(state.biggestPot, potSize);
  state.handNumber += 1;
  state.button = other(state.button);
  state.blindsPosted = false;
}

function requireIdle(state, what) {
  if (state.pot > 0) throw new LedgerError(`finish the current hand before ${what}`, 'hand_in_progress');
}

/** Build the canonical event for an incoming action (validates shape only). */
export function buildEvent(action, state, config) {
  if (!action || typeof action !== 'object') throw new LedgerError('action must be an object');
  const { type } = action;
  switch (type) {
    case 'bet':
      requirePlayer(action.player);
      requireAmount(action.amount);
      return { type, player: action.player, amount: action.amount };
    case 'allin':
      // Convenience: resolved to a concrete bet amount so replay is deterministic.
      requirePlayer(action.player);
      if (state.players[action.player].stack < 1) throw new LedgerError('player has no chips left', 'insufficient_chips');
      return { type: 'bet', player: action.player, amount: state.players[action.player].stack, allIn: true };
    case 'call': {
      requirePlayer(action.player);
      const diff = state.players[other(action.player)].inPot - state.players[action.player].inPot;
      if (diff <= 0) throw new LedgerError('nothing to call');
      const amount = Math.min(diff, state.players[action.player].stack);
      if (amount < 1) throw new LedgerError('player has no chips left', 'insufficient_chips');
      return { type: 'bet', player: action.player, amount, call: true };
    }
    case 'blinds': {
      if (!config.sb || !config.bb) throw new LedgerError('blinds are not set for this session');
      requireIdle(state, 'posting blinds');
      const sbP = state.button;
      const bbP = other(sbP);
      // A short stack posts what it has (all-in blind).
      const sb = Math.min(config.sb, state.players[sbP].stack);
      const bb = Math.min(config.bb, state.players[bbP].stack);
      if (sb < 1 || bb < 1) throw new LedgerError('a player has no chips to post a blind', 'insufficient_chips');
      return { type, button: sbP, sb, bb };
    }
    case 'fold':
      requirePlayer(action.player);
      return { type, player: action.player };
    case 'showdown':
      if (action.winner !== 0 && action.winner !== 1 && action.winner !== 'split') {
        throw new LedgerError('winner must be 0, 1 or "split"');
      }
      return { type, winner: action.winner };
    case 'manual':
      if (action.winner !== 0 && action.winner !== 1 && action.winner !== 'split') {
        throw new LedgerError('winner must be 0, 1 or "split"');
      }
      requireAmount(action.pot, 'pot', 2);
      if (action.pot % 2 !== 0) {
        throw new LedgerError('manual pot must be even (each player put in half); use Bet + Fold for uneven pots');
      }
      return { type, winner: action.winner, pot: action.pot };
    case 'rebuy':
      requirePlayer(action.player);
      requireAmount(action.amount);
      return { type, player: action.player, amount: action.amount };
    case 'adjust':
      requirePlayer(action.player);
      requireAmount(action.stack, 'stack', 0);
      return { type, player: action.player, stack: action.stack };
    default:
      throw new LedgerError(`unknown action type "${type}"`);
  }
}

/**
 * Apply one canonical event. Returns a new state; throws LedgerError if the
 * event is not legal in this state. Never mutates the input state.
 */
export function applyEvent(prev, event, meta = {}) {
  const state = clone(prev);
  const before = state.players.map((pl) => pl.stack);
  const handNumber = state.handNumber;
  let potBefore = state.pot;
  let summary = {};

  switch (event.type) {
    case 'bet':
      requirePlayer(event.player);
      requireAmount(event.amount);
      put(state, event.player, event.amount);
      break;

    case 'blinds': {
      requireIdle(state, 'posting blinds');
      requireAmount(event.sb, 'small blind');
      requireAmount(event.bb, 'big blind');
      requirePlayer(event.button);
      put(state, event.button, event.sb);
      put(state, other(event.button), event.bb);
      state.button = event.button;
      state.blindsPosted = true;
      break;
    }

    case 'fold': {
      requirePlayer(event.player);
      if (state.pot < 1) throw new LedgerError('nothing in the pot', 'empty_pot');
      const winner = other(event.player);
      state.players[winner].stack += state.pot;
      summary = { winner, won: state.pot };
      endHand(state, state.pot);
      break;
    }

    case 'showdown': {
      if (state.pot < 1) throw new LedgerError('nothing in the pot', 'empty_pot');
      const [a, b] = state.players;
      // Only matched chips are contested; any uncalled excess goes back.
      const matched = Math.min(a.inPot, b.inPot);
      const refunds = [a.inPot - matched, b.inPot - matched];
      const contested = matched * 2;
      const potSize = state.pot;
      if (event.winner === 'split') {
        // Heads-up contributions are matched, so the split is always even.
        a.stack += matched + refunds[0];
        b.stack += matched + refunds[1];
      } else {
        requirePlayer(event.winner);
        state.players[event.winner].stack += contested;
        a.stack += refunds[0];
        b.stack += refunds[1];
      }
      summary = { contested, refunds };
      endHand(state, potSize);
      break;
    }

    case 'manual': {
      requireIdle(state, 'adding a manual hand');
      requireAmount(event.pot, 'pot', 2);
      if (event.pot % 2 !== 0) throw new LedgerError('manual pot must be even');
      const half = event.pot / 2;
      if (event.winner !== 'split') {
        requirePlayer(event.winner);
        const loser = other(event.winner);
        if (state.players[loser].stack < half) {
          throw new LedgerError(`not enough chips: loser only has ${state.players[loser].stack}`, 'insufficient_chips');
        }
        state.players[loser].stack -= half;
        state.players[event.winner].stack += half;
      }
      endHand(state, event.pot);
      potBefore = event.pot;
      break;
    }

    case 'rebuy': {
      requireIdle(state, 'a rebuy');
      requirePlayer(event.player);
      requireAmount(event.amount);
      const pl = state.players[event.player];
      if (pl.stack + event.amount > MAX_CHIPS) throw new LedgerError('stack would exceed the chip limit');
      pl.stack += event.amount;
      pl.buyIn += event.amount;
      pl.rebuys += 1;
      break;
    }

    case 'adjust': {
      requirePlayer(event.player);
      requireAmount(event.stack, 'stack', 0);
      const pl = state.players[event.player];
      const delta = event.stack - pl.stack;
      if (delta === 0) throw new LedgerError('stack is already that value');
      // A correction is a top-up (delta > 0) or cash-out (delta < 0), so the
      // settlement stays zero-sum and no chips appear out of nowhere.
      pl.buyIn += delta;
      pl.stack = event.stack;
      summary = { delta };
      break;
    }

    default:
      throw new LedgerError(`unknown event type "${event.type}"`);
  }

  assertConserved(state);

  const after = state.players.map((pl) => pl.stack);
  state.log = [
    ...prev.log,
    {
      seq: meta.seq ?? prev.log.length + 1,
      ts: meta.ts ?? null,
      hand: handNumber,
      ...event,
      ...summary,
      potBefore,
      deltas: after.map((s, i) => s - before[i]),
      stacks: after,
      pot: state.pot,
    },
  ];
  return state;
}

export function assertConserved(state) {
  const onTable = state.players[0].stack + state.players[1].stack + state.pot;
  const bought = state.players[0].buyIn + state.players[1].buyIn;
  const potParts = state.players[0].inPot + state.players[1].inPot;
  if (onTable !== bought || potParts !== state.pot || state.players.some((pl) => pl.stack < 0)) {
    // Should be unreachable; refusing the event is safer than storing it.
    throw new LedgerError('chip conservation violated', 'invariant');
  }
}

/** Rebuild state from config + stored events ({ event, seq, ts }). */
export function replay(config, rows) {
  let state = initialState(config);
  for (const row of rows) state = applyEvent(state, row.event, { seq: row.seq, ts: row.ts });
  return state;
}

/**
 * Settlement: who owes whom, from start (incl. rebuys) vs current stacks.
 * An unfinished pot is treated as returned to whoever put the chips in.
 */
export function settle(state, chipValue = 0) {
  const nets = state.players.map((pl) => pl.stack + pl.inPot - pl.buyIn);
  const amount = Math.abs(nets[0]);
  let from = null;
  let to = null;
  if (nets[0] > 0) [from, to] = [1, 0];
  else if (nets[0] < 0) [from, to] = [0, 1];
  return {
    nets,
    from,
    to,
    chips: amount,
    value: chipValue > 0 ? amount * chipValue : null,
    potRefunded: state.pot,
  };
}

export function summarize(state) {
  return {
    handsPlayed: state.handsPlayed,
    biggestPot: state.biggestPot,
    totalBuyIn: state.players[0].buyIn + state.players[1].buyIn,
    rebuys: state.players.map((pl) => pl.rebuys),
  };
}
