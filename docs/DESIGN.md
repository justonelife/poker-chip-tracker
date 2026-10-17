# Design spec — Chip Tracker

Produced with the `ui-design:design-screen` flow (grid → hierarchy → type → color →
spacing → responsive → dark mode). Tokens live in `public/css/tokens.css`; this file
explains the decisions behind them.

## 1. Structure (layout grid)

- Single column, content max-width `480px`, centered. Side margin `16px` (`--space-4`).
- Inside the table screen the player area is a **2-column grid** (`1fr 1fr`, gap `12px`):
  player 1 always left, player 2 always right, on every device. Both phones show the
  same orientation so "left/right" means the same thing to both people at the table.
- Keypad is a **4-column grid** (digits ×3 + one column of quick keys).
- Bottom tab bar (Table / History / Summary) is fixed, `56px` + safe-area inset,
  because the thumb lives at the bottom of a phone held in one hand.

Table screen, top → bottom (at 390×844 everything fits without scrolling):

| Zone | Content | Priority |
| --- | --- | --- |
| Top bar (48px) | Room code (tap = copy), sync status | meta |
| Pot card | Hand # · button · blinds, **pot**, per-player "in pot", undo, post blinds / showdown row | secondary |
| Player grid | Name, **stack** (tap to edit), CSS chip stack, in-pot, Fold / All-in | **hero** |
| Bet pad | Amount readout, 4×4 keypad, two "Bet / Call" buttons (one per player) | tertiary |
| Tab bar | Table · History · Summary | nav |

The per-player bet buttons sit directly under the keypad and directly below that
player's column, so the flow "type amount → press your side" stays in the thumb zone.

## 2. Hierarchy

1. Stacks: largest type on screen (`--text-hero`, 700, tabular numerals), full-contrast text.
2. Pot: accent color (brass), one step smaller (`--text-2xl`), on the felt card.
3. Actions: tonal buttons; only the bet buttons are filled (primary). Destructive
   actions (Fold, End session) use the danger tone, never the primary fill.
4. Labels / meta: `--text-sm`, muted color, uppercase tracking only for tiny labels.

Von Restorff: the pot is the only brass element on the table screen, so the eye lands on it
right after the stacks.

## 3. Typography

System font stack (no web fonts → zero network). Modular scale, ratio ≈1.25, base 16px:
`12 / 14 / 16 / 20 / 24 / 32 / hero clamp(34px, 10.5vw, 46px)`.
All numbers use `font-variant-numeric: tabular-nums` so digits do not jump when stacks
change. Line-height 1.1 for numerals, 1.45 for body text.

## 4. Color (dark, felt-adjacent)

| Token | Value | Use | Contrast (vs its surface) |
| --- | --- | --- | --- |
| `--bg` | `#0a1410` | page | — |
| `--surface-1` | `#102019` | cards | — |
| `--surface-2` | `#162a22` | buttons, inputs | — |
| `--felt` | `#0f3a2a` | pot card | — |
| `--text` | `#ecf3ef` | primary text | 16.6:1 on bg, 11.2:1 on felt |
| `--text-muted` | `#a3b8ad` | labels | 6.0:1 (felt) – 8.9:1 (bg) |
| `--accent` | `#e2bd63` | pot, primary button fill | 7.0:1 on felt; button text 10.2:1 |
| `--positive` | `#6fdba6` | gains | 9.9:1 on surface-1 |
| `--negative` | `#ff9a8a` | losses | 8.2:1 on surface-1 |
| `--p1` / `--p2` | `#86c8e8` / `#ecaa84` | player identity (chips, name dot) | 9.2:1 / 8.6:1 |

`test/contrast.test.js` parses `tokens.css` and asserts every text/surface pair
listed there is ≥ 4.5:1, so this table cannot silently rot.

No gradients except the functional chip-stack stripes; no glow; one shadow level.

## 5. Spacing

4px base: `4 8 12 16 20 24 32 40 48`. Cards use `16px` padding, `12px` gaps between
related items, `20–24px` between zones (proximity groups the pot with its actions and
each stack with its own Fold/All-in). Touch targets: min `44px` height, keypad keys `46px`.

## 6. Responsive

- ≤ 360px: hero numerals scale down via `clamp`, keypad gap shrinks to 6px.
- 390–480px: designed size.
- ≥ 768px: content stays 480px wide and centered (a phone-shaped tool on a desk);
  tab bar is constrained to the same width. No horizontal scroll at any width
  (`overflow-wrap:anywhere` on names, `min-width:0` on grid children).
- Short viewports (< 700px tall): the chip-stack visual collapses to save height.

## 7. Dark mode

Dark is the only theme (it is used at a dim table). Elevation is expressed by lighter
surfaces, not shadows. Pure black and pure white are avoided to prevent halation.
`color-scheme: dark` makes native inputs/dialogs match. `prefers-reduced-motion`
disables the stack-change flash.

## Accessibility

- Visible focus ring (`2px` brass outline + offset) on every interactive element.
- `aria-live="polite"` region announces every stack change, including ones made from
  the other phone.
- Buttons have text labels (no icon-only controls); keypad keys have `aria-label`s
  where the glyph is ambiguous (⌫).
