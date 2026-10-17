# Chip Tracker — heads-up poker chip ledger

A small web app for two people playing heads-up poker in real life, with real
chips or none at all. Both players open the same room on their own phones; every bet,
fold, showdown, top-up and correction updates both screens. At the end, the app tells you who owes whom.

- **Table**: two large stack readouts (tap one to correct it), the pot, a bet keypad,
  and per-player Bet / Call / All-in / Fold buttons. Showdown: P1 wins / Split / P2 wins.
  Optional blinds with an alternating dealer button.
- **History**: every action, newest first, grouped by hand, with time, per-player
  chip deltas and both stacks after the action. Undo last action. Add a forgotten hand
  manually (pot + winner).
- **Summary**: hands played, biggest pot, chips in play, net per player, top-ups
  (rebuys), and **Settle up** ("Bình owes An 350 chips"), optionally converted to
  money with a whole-number value per chip.
- **Rooms**: a 6-character code (no 0/O/1/I/L, so you can read it out at the table), a join link,
  live sync by polling every 2s, and persistence in SQLite. A room is deleted after 24h with no activity.

Mobile-first (designed at 390px, one-handed), dark theme, no build step, no
external requests at runtime. Design rationale: [`docs/DESIGN.md`](docs/DESIGN.md).

## Run locally

Requires **Node 22+** (better-sqlite3 13 dropped Node 20).

```bash
npm ci
npm start            # http://localhost:3000
npm run dev          # same, restarts on file changes
npm test             # all tests (see below)
```

| Env var    | Default  | Meaning                                         |
| ---------- | -------- | ----------------------------------------------- |
| `PORT`     | `3000`   | HTTP port                                       |
| `DATA_DIR` | `./data` | Folder for `chips.db` (created if missing)      |

To try it with two "phones", open the app in two browser windows (or on a phone on
the same Wi-Fi via `http://<your-LAN-IP>:3000`). Create a room in one window and join
it from the other with the code.

## How the chip math works

The server is **event-sourced**. A room stores its config (names, starting stacks,
blinds, chip value) plus an append-only list of events. The current state is always
computed by replaying those events (`server/ledger.js`, a pure module with no I/O).

- **Undo** deletes the last event and replays. Stacks are recomputed from the log,
  not adjusted in reverse, so undo can't drift.
- **Invariant**, checked after every event:
  `stack₁ + stack₂ + pot = buyIn₁ + buyIn₂`. Chips only enter through buy-ins:
  the starting stacks, **top-ups** (rebuys), and **stack corrections**. A correction
  (tapping a stack and typing the real count) counts as a top-up or cash-out for that
  player, so it never changes who owes whom. To move chips between players, record a
  hand instead.
- **Showdown** awards only *matched* chips. If one player bet more than the other could
  call, the uncalled part goes back to them. **Split** returns each player's
  contribution.
- **Fold** gives the whole pot to the other player.
- **Settle** = `stack + chips in current pot − buy-in` per player (an unfinished pot
  is counted back to whoever put it in). This always sums to zero.
- Every amount is a JS safe integer between 1 and 1,000,000,000. Floats, strings,
  negatives and overdrafts are rejected with `400` and nothing is stored.

## API

All bodies and responses are JSON. Errors look like
`{ "error": "<code>", "message": "<human text>" }`.

| Method & path | Body | Result |
| --- | --- | --- |
| `GET /health` | — | `200 {ok:true, uptime}` (also touches the DB) |
| `POST /api/sessions` | `{names?:[s,s], startStacks:[int,int], sb?, bb?, chipValue?}` | `201 {roomCode, stateToken, state}` |
| `GET /api/sessions/:code` | — | `200 {state}`. This is how a second phone joins. Code is case-insensitive; dashes and spaces are ignored. |
| `GET /api/sessions/:code?v=N` | — | `204` if the room is still at version `N`, else `200 {state}` (the polling call) |
| `POST /api/sessions/:code/actions` | action (below) + optional `expectedVersion` | `200 {state}` |
| `POST /api/sessions/:code/undo` | optional `expectedVersion` | `200 {state}`; `400 nothing_to_undo` |
| `PATCH /api/sessions/:code/settings` | `{names?, sb?, bb?, chipValue?, expectedVersion?}` | `200 {state}` |
| `DELETE /api/sessions/:code` | header `X-State-Token: <stateToken>` | `204`; `403` without the creator's token |

Actions (`player` is `0` or `1`):

| `type` | Fields | Effect |
| --- | --- | --- |
| `bet` | `player, amount` | stack → pot |
| `call` | `player` | puts in the difference (capped at the player's stack) |
| `allin` | `player` | puts in the player's whole stack |
| `blinds` | — | button posts SB, other posts BB (short stacks post what they have). Only between hands. |
| `fold` | `player` | pot → other player; hand ends, button moves |
| `showdown` | `winner: 0 \| 1 \| "split"` | matched pot → winner (uncalled excess refunded); hand ends |
| `manual` | `winner, pot` (even) | records a forgotten hand: loser pays `pot/2` to winner. Only between hands. |
| `rebuy` | `player, amount` | top-up: adds to stack and buy-in. Only between hands. |
| `adjust` | `player, stack` | sets the stack; the difference is booked to that player's buy-in |

`expectedVersion`: the version the client last saw. If the other phone changed the
room in the meantime, the server answers `409 {error:"stale", state}` and does nothing.
The client shows the fresh state and asks the player to check it and try again, so a double tap
from two phones can't apply the same bet twice.

`state` shape (abridged):

```json
{
  "roomCode": "K7M2QX", "version": 3, "createdAt": 0, "updatedAt": 0, "expiresAt": 0,
  "config": { "names": ["Bạn", "Đối thủ"], "startStacks": [1000, 1000], "sb": 5, "bb": 10, "chipValue": 0 },
  "players": [{ "name": "Bạn", "stack": 900, "buyIn": 1000, "inPot": 100, "rebuys": 0, "net": 0 }, "…"],
  "pot": 200, "handNumber": 1, "handInProgress": true, "button": 0, "blindsPosted": true,
  "toCall": null,
  "summary": { "handsPlayed": 0, "biggestPot": 0, "totalBuyIn": 2000, "rebuys": [0, 0] },
  "settlement": { "nets": [0, 0], "from": null, "to": null, "chips": 0, "value": null, "potRefunded": 200 },
  "log": [{ "seq": 1, "ts": 0, "hand": 1, "type": "blinds", "deltas": [-5, -10], "stacks": [995, 990], "pot": 15, "…": "…" }]
}
```

### Security model

There are no accounts. Anyone with the room code can play in that room. The
`stateToken` returned when a room is created only lets that device **end** the room;
the server stores just its SHA-256 hash. Other protections:

- `POST /api/sessions`: 10 rooms per IP per 10 minutes (in-memory).
- Lookups of unknown room codes: 60 per IP per 10 minutes (makes guessing codes slow;
  31⁶ ≈ 887M possible codes).
- Bodies are limited to 8 KB and every field is validated on the server.
- CSP `default-src 'self'` with no inline scripts or styles, plus `nosniff`, `DENY`
  framing and `no-referrer`.

## Tests

`npm test` runs `node --test` over `test/*.test.js` (39 tests, about 185 `assert` calls):

| File | What it covers |
| --- | --- |
| `ledger.test.js` | Unit tests of the pure ledger: bet, call cap, all-in, blinds and button rotation, fold, showdown win/lose/split, uncalled all-in refund, undo by replay (including the button), rebuy, stack correction, manual hand, settle with rebuys and chip value, an unfinished pot at settle time, and a **2,000-step seeded random session** asserting chip conservation and zero-sum settlement after every accepted action. |
| `http.test.js` | Real HTTP server on a random port, in-memory SQLite: create → join (code typed lower-case with a dash) → 3 actions → read → `204` poll → undo with exact stack checks and JSON shape checks. Also: rejected bad input (floats, negatives, strings, overdrafts, bad JSON) leaves state unchanged, `409` on a stale version, settings/rebuy/settlement, owner-only delete, 24h expiry plus the cleanup job, create rate limit, and static files with CSP. |
| `dom.test.js` | jsdom parse of `public/index.html` with no browser: unique ids, every `#id` used by `app.js` exists, key elements on each screen, no inline script/style (CSP), no external URLs, every form is `novalidate` (JS validates), accessible names on buttons, labelled inputs, tabs that point to real panels, and every CSS `var(--x)` defined in the tokens. |
| `contrast.test.js` | Parses `tokens.css` and checks every annotated text/background pair has WCAG contrast ≥ 4.5:1 (lowest is 6.0:1). |

During development the client was also driven end-to-end in headless Chromium at
390×844 (two tabs as two phones): create form → blinds → keypad bet → call → showdown
→ undo from the toast → fold → stack correction → history → manual hand → top-up →
settle with chip value → join from a second tab → live update within one poll → `409`
handling → end session, which sends the other phone home. That script uses a local
Chrome and is not part of `npm test`.

## Deploy on Render

1. Push this folder to a Git repo.
2. Render dashboard → **New → Blueprint** → choose the repo. `render.yaml` sets up a
   Node web service: build `npm ci`, start `npm start`, health check `/health`,
   `NODE_VERSION=22`, `DATA_DIR=/tmp/chip-data`. Render provides `PORT`.

## Known limitations

- **Ephemeral storage on Render free tier.** `/tmp/chip-data` is wiped on every
  deploy, restart, or spin-down after idling, which ends any open rooms. Attach a
  persistent disk and point `DATA_DIR` at it if that matters.
- **Single instance.** Rate limits are in memory and SQLite is a local file, so don't
  scale horizontally.
- **Polling, not push.** The other phone sees a change within about 2s. Polling pauses while
  the tab is hidden and resumes when it is shown again.
- **Anyone with the code can act** in a room, including undoing the other phone's
  last action (the history makes this visible). There is no per-player identity.
- **No poker rules engine.** It tracks chips and doesn't enforce min-raises, betting
  rounds or turn order. Bets are tracked per hand, not per street.
- **Manual hands assume equal contributions** (pot must be even). For uneven pots,
  replay the hand with Bet + Fold on the table.
- **A downward stack correction counts as a cash-out**, so a player's "In" figure can
  drop (even below zero) after large corrections. Settlement stays correct.
- Undo only goes back one event at a time, and the server keeps no record of undone events.
