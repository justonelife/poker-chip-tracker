// Formatting helpers shared by the views. Pure functions, no DOM.

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MINUS = '−';

export const fmt = (n) => nf.format(n);

/** "+1,200", "−300", "0" */
export function signed(n) {
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `${MINUS}${fmt(-n)}`;
  return '0';
}

export function clock(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Parse a whole, non-negative chip amount typed by a person. NaN if invalid. */
export function parseChips(value) {
  const text = String(value ?? '').trim().replace(/[,\s]/g, '');
  if (!/^\d{1,10}$/.test(text)) return NaN;
  return Number(text);
}

/** One-line, human description of a log entry. */
export function describe(e, names) {
  const n = (p) => names[p] ?? `Player ${p + 1}`;
  switch (e.type) {
    case 'bet':
      if (e.allIn) return `${n(e.player)} is all-in for ${fmt(e.amount)}`;
      if (e.call) return `${n(e.player)} calls ${fmt(e.amount)}`;
      return `${n(e.player)} bets ${fmt(e.amount)}`;
    case 'blinds':
      return `Blinds: ${n(e.button)} ${fmt(e.sb)}, ${n(1 - e.button)} ${fmt(e.bb)}`;
    case 'fold':
      return `${n(e.player)} folds · ${n(e.winner)} takes ${fmt(e.won)}`;
    case 'showdown': {
      if (e.winner === 'split') return `Split pot of ${fmt(e.potBefore)}`;
      let text = `${n(e.winner)} wins ${fmt(e.contested)} at showdown`;
      const back = (e.refunds ?? []).findIndex((r) => r > 0);
      if (back !== -1) text += ` (${fmt(e.refunds[back])} uncalled back to ${n(back)})`;
      return text;
    }
    case 'manual':
      return e.winner === 'split'
        ? `Added hand: split pot of ${fmt(e.pot)}`
        : `Added hand: ${n(e.winner)} wins pot of ${fmt(e.pot)}`;
    case 'rebuy':
      return `${n(e.player)} tops up ${fmt(e.amount)}`;
    case 'adjust':
      return `${n(e.player)} stack corrected to ${fmt(e.stack)} (${signed(e.delta)})`;
    default:
      return e.type;
  }
}
