// Entry point: open the database, start the HTTP server and the cleanup job.

import { createApp, cleanupExpired, SESSION_TTL_MS } from './app.js';
import { openDb } from './db.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const CLEANUP_EVERY_MS = 10 * 60 * 1000;

const db = openDb(DATA_DIR);
const app = createApp({ db });

const removed = cleanupExpired(db);
if (removed) console.log(`cleanup: removed ${removed} expired session(s)`);
const timer = setInterval(() => {
  const n = cleanupExpired(db, SESSION_TTL_MS);
  if (n) console.log(`cleanup: removed ${n} expired session(s)`);
}, CLEANUP_EVERY_MS);
timer.unref();

const server = app.listen(PORT, () => {
  console.log(`chip tracker listening on :${PORT} (data: ${DATA_DIR})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
