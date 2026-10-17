// Tiny in-memory fixed-window rate limiter keyed by IP. Good enough for a
// single-instance app; resets on restart (documented in README).

export function createRateLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    /** Record a hit; returns false when the key is over the limit. */
    hit(key = 'unknown') {
      const t = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= max;
    },
  };
}
