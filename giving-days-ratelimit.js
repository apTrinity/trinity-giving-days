// Small in-memory limits for the public Giving Days routes (no extra package, one server instance).
// clientId: who is asking. Prefers the address header set by the host's own edge (a caller cannot choose it), then the
// first X-Forwarded-For value, then the socket address.

const clientId = req => {
  const h = req.headers || {};
  const pick = v => String(v || '').split(',')[0].trim();
  return pick(h['cf-connecting-ip']) || pick(h['true-client-ip']) || pick(h['x-forwarded-for']) || String(req.ip || '');
};

// limiter(max, windowMs): middleware that answers 429 once one client has made more than `max` requests in a window.
function limiter(max, windowMs, message) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k); }, Math.max(60000, windowMs)).unref();
  return (req, res, next) => {
    const id = clientId(req), now = Date.now();
    const h = hits.get(id);
    if (!h || now - h.start > windowMs) { hits.set(id, { n: 1, start: now }); return next(); }
    if (++h.n > max) { res.set('Retry-After', String(Math.ceil((h.start + windowMs - now) / 1000))); return res.status(429).json({ error: message || 'Too many requests. Please wait a moment and try again.' }); }
    next();
  };
}

module.exports = { clientId, limiter };
