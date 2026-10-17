// SQLite persistence (better-sqlite3, synchronous). One row per session plus
// an append-only events table; state is derived by replaying events.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'chips.db');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      code        TEXT PRIMARY KEY,
      owner_hash  TEXT NOT NULL,
      config      TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_code ON events(code, id);
    CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
  `);

  const q = {
    insertSession: db.prepare(
      'INSERT INTO sessions (code, owner_hash, config, version, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE code = ?'),
    getVersion: db.prepare('SELECT version, updated_at FROM sessions WHERE code = ?'),
    touch: db.prepare('UPDATE sessions SET version = version + 1, updated_at = ? WHERE code = ?'),
    setConfig: db.prepare('UPDATE sessions SET config = ? WHERE code = ?'),
    events: db.prepare('SELECT id, payload, created_at FROM events WHERE code = ? ORDER BY id'),
    insertEvent: db.prepare('INSERT INTO events (code, payload, created_at) VALUES (?, ?, ?)'),
    lastEvent: db.prepare('SELECT id FROM events WHERE code = ? ORDER BY id DESC LIMIT 1'),
    deleteEvent: db.prepare('DELETE FROM events WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE code = ?'),
    expire: db.prepare('DELETE FROM sessions WHERE updated_at < ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM sessions'),
  };

  return {
    raw: db,
    transaction: (fn) => db.transaction(fn),
    createSession(code, ownerHash, config, now) {
      q.insertSession.run(code, ownerHash, JSON.stringify(config), now, now);
    },
    getSession(code) {
      const row = q.getSession.get(code);
      return row ? { ...row, config: JSON.parse(row.config) } : null;
    },
    getVersion: (code) => q.getVersion.get(code) ?? null,
    events(code) {
      return q.events.all(code).map((r) => ({ id: r.id, ts: r.created_at, event: JSON.parse(r.payload) }));
    },
    appendEvent(code, event, now) {
      q.insertEvent.run(code, JSON.stringify(event), now);
      q.touch.run(now, code);
    },
    popEvent(code, now) {
      const last = q.lastEvent.get(code);
      if (!last) return false;
      q.deleteEvent.run(last.id);
      q.touch.run(now, code);
      return true;
    },
    setConfig(code, config, now) {
      q.setConfig.run(JSON.stringify(config), code);
      q.touch.run(now, code);
    },
    deleteSession: (code) => q.deleteSession.run(code).changes > 0,
    expireBefore: (cutoff) => q.expire.run(cutoff).changes,
    countSessions: () => q.count.get().n,
    close: () => db.close(),
  };
}
