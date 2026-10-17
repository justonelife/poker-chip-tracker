// Express app factory. Kept separate from index.js so tests can mount the app
// on a random port with an in-memory database.

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LedgerError,
  applyEvent,
  buildEvent,
  cleanName,
  isChipInt,
  normalizeConfig,
  replay,
  settle,
  summarize,
  validateBlinds,
} from './ledger.js';
import { createRateLimiter } from './rate-limit.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// No 0/O, 1/I/L — codes are read aloud across a table.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

function newCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function createApp({
  db,
  now = () => Date.now(),
  ttlMs = SESSION_TTL_MS,
  createLimit = { max: 10, windowMs: 10 * 60 * 1000 },
  lookupLimit = { max: 60, windowMs: 10 * 60 * 1000 },
} = {}) {
  const app = express();
  const createLimiter = createRateLimiter(createLimit);
  // Counts lookups of unknown room codes, to make code guessing slow.
  const missLimiter = createRateLimiter(lookupLimit);

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of us
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use(express.json({ limit: '8kb' }));

  // ---- helpers -----------------------------------------------------------

  function loadSession(rawCode, req) {
    const code = normalizeCode(rawCode);
    const session = code ? db.getSession(code) : null;
    if (!session || session.updated_at < now() - ttlMs) {
      if (session) db.deleteSession(code);
      if (!missLimiter.hit(req.ip)) throw new HttpError(429, 'rate_limited', 'Too many unknown room codes. Try again later.');
      throw new HttpError(404, 'not_found', 'Room not found or expired.');
    }
    return session;
  }

  function stateOf(session) {
    return replay(
      session.config,
      db.events(session.code).map((r, i) => ({ event: r.event, seq: i + 1, ts: r.ts })),
    );
  }

  function view(session, state = stateOf(session)) {
    const { config } = session;
    const settlement = settle(state, config.chipValue);
    const [a, b] = state.players;
    let toCall = null;
    if (a.inPot !== b.inPot) {
      const behind = a.inPot < b.inPot ? 0 : 1;
      toCall = {
        player: behind,
        amount: Math.min(Math.abs(a.inPot - b.inPot), state.players[behind].stack),
      };
    }
    return {
      roomCode: session.code,
      version: session.version,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      expiresAt: session.updated_at + ttlMs,
      config,
      players: state.players.map((pl, i) => ({
        name: config.names[i],
        stack: pl.stack,
        buyIn: pl.buyIn,
        inPot: pl.inPot,
        rebuys: pl.rebuys,
        net: settlement.nets[i],
      })),
      pot: state.pot,
      handNumber: state.handNumber,
      handInProgress: state.pot > 0,
      button: state.button,
      blindsPosted: state.blindsPosted,
      toCall,
      summary: summarize(state),
      settlement,
      log: state.log,
    };
  }

  function checkVersion(session, expected) {
    if (expected === undefined || expected === null) return;
    if (!Number.isSafeInteger(expected)) throw new HttpError(400, 'invalid_version', 'expectedVersion must be an integer');
    if (expected !== session.version) {
      throw new HttpError(409, 'stale', 'The table changed on another device. Review and try again.', {
        state: view(session),
      });
    }
  }

  // Run a mutation atomically: re-read inside the transaction so concurrent
  // requests from two phones can never interleave.
  function mutate(req, fn) {
    const run = db.transaction(() => {
      const session = loadSession(req.params.code, req);
      checkVersion(session, req.body?.expectedVersion);
      fn(session);
      return view(db.getSession(session.code));
    });
    return run();
  }

  // ---- routes ------------------------------------------------------------

  app.get('/health', (req, res) => {
    db.countSessions(); // proves the database is reachable
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  app.post('/api/sessions', (req, res) => {
    if (!createLimiter.hit(req.ip)) {
      throw new HttpError(429, 'rate_limited', 'Too many sessions created from this network. Try again in a few minutes.');
    }
    const body = req.body ?? {};
    const config = normalizeConfig({
      names: body.names,
      startStacks: body.startStacks,
      sb: body.sb,
      bb: body.bb,
      chipValue: body.chipValue,
    });
    const stateToken = crypto.randomBytes(24).toString('base64url');
    const t = now();
    let code;
    for (let attempt = 0; attempt < 10 && !code; attempt++) {
      const candidate = newCode();
      try {
        db.createSession(candidate, sha256(stateToken), config, t);
        code = candidate;
      } catch (err) {
        if (!String(err.code).startsWith('SQLITE_CONSTRAINT')) throw err;
      }
    }
    if (!code) throw new HttpError(503, 'busy', 'Could not allocate a room code. Try again.');
    res.status(201).json({ roomCode: code, stateToken, state: view(db.getSession(code)) });
  });

  // Join / read / poll. With ?v=<version>, answers 204 if nothing changed.
  app.get('/api/sessions/:code', (req, res) => {
    const session = loadSession(req.params.code, req);
    res.set('Cache-Control', 'no-store');
    if (req.query.v !== undefined && Number(req.query.v) === session.version) {
      res.status(204).end();
      return;
    }
    res.json({ state: view(session) });
  });

  app.post('/api/sessions/:code/actions', (req, res) => {
    const state = mutate(req, (session) => {
      const current = stateOf(session);
      const event = buildEvent(req.body, current, session.config);
      applyEvent(current, event); // throws if illegal; nothing stored
      db.appendEvent(session.code, event, now());
    });
    res.json({ state });
  });

  app.post('/api/sessions/:code/undo', (req, res) => {
    const state = mutate(req, (session) => {
      if (!db.popEvent(session.code, now())) throw new HttpError(400, 'nothing_to_undo', 'Nothing to undo.');
    });
    res.json({ state });
  });

  app.patch('/api/sessions/:code/settings', (req, res) => {
    const state = mutate(req, (session) => {
      const body = req.body ?? {};
      const config = { ...session.config, names: [...session.config.names] };
      if (body.names !== undefined) {
        if (!Array.isArray(body.names) || body.names.length !== 2) throw new LedgerError('names must be a list of two');
        config.names = body.names.map((n, i) => cleanName(n, session.config.names[i]));
      }
      if (body.sb !== undefined || body.bb !== undefined) {
        const sb = body.sb ?? config.sb;
        const bb = body.bb ?? config.bb;
        validateBlinds(sb, bb);
        Object.assign(config, { sb, bb });
      }
      if (body.chipValue !== undefined) {
        if (!isChipInt(body.chipValue)) throw new LedgerError('chip value must be a whole number ≥ 0');
        config.chipValue = body.chipValue;
      }
      db.setConfig(session.code, config, now());
    });
    res.json({ state });
  });

  // Owner only: end the session for everyone.
  app.delete('/api/sessions/:code', (req, res) => {
    const session = loadSession(req.params.code, req);
    const token = req.get('x-state-token') ?? '';
    const given = Buffer.from(sha256(token));
    const expected = Buffer.from(session.owner_hash);
    if (!token || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new HttpError(403, 'forbidden', 'Only the device that created this room can end it.');
    }
    db.deleteSession(session.code);
    res.status(204).end();
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Unknown API route.' });
  });

  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ['html'],
      setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
    }),
  );
  // Client-side routes (#/r/CODE uses the hash, but serve index for deep links too).
  app.get(/^\/r\/[A-Za-z0-9-]+$/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // ---- errors ------------------------------------------------------------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    } else if (err instanceof LedgerError) {
      const status = err.code === 'invariant' ? 500 : 400;
      res.status(status).json({ error: err.code, message: err.message });
    } else if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'bad_json', message: 'Request body is not valid JSON.' });
    } else if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large', message: 'Request body too large.' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
    }
  });

  return app;
}

/** Delete sessions idle for longer than the TTL. Returns the number removed. */
export function cleanupExpired(db, ttlMs = SESSION_TTL_MS, now = Date.now()) {
  return db.expireBefore(now - ttlMs);
}
