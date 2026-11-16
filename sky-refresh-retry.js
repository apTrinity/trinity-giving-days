// Retry wrapper for the proactive SKY token refresh.
//
// Retries ONLY when the server could not reach Blackbaud at all (timeout connecting, network unreachable, DNS
// failure, connection refused). In those cases the request never arrived, so the single-use refresh token has not
// been spent and trying again is safe.
//
// It does NOT retry: invalid_grant or any other answer from Blackbaud (a person must fix that, so it alerts at once),
// or a request timeout after connecting (the request may have reached Blackbaud and spent the refresh token).

const CONNECTION_CODES = new Set(['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND']);
const CONNECTION_MESSAGE = /\b(ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b/;

function isConnectionError(err) {
  if (!err || err.response) return false; // Blackbaud answered: not a connection problem
  const codes = [err.code];
  if (Array.isArray(err.errors)) err.errors.forEach(e => codes.push(e && e.code));
  if (codes.some(c => CONNECTION_CODES.has(c))) return true;
  return CONNECTION_MESSAGE.test(String(err.message || ''));
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// refresh: async function that renews the token. Resolves on success; throws on failure.
// Throws the LAST error if every attempt fails, or the first non-connection error immediately.
async function refreshWithRetry(refresh, { attempts = 3, delayMs = 60 * 1000, sleep = defaultSleep, log = console } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await refresh();
      if (attempt > 1) log.log(`Proactive token refresh recovered on attempt ${attempt} of ${attempts}.`);
      return result;
    } catch (err) {
      lastErr = err;
      if (!isConnectionError(err) || attempt === attempts) throw err;
      log.error(`Proactive token refresh attempt ${attempt} of ${attempts} could not reach Blackbaud (${err.message}); retrying in ${Math.round(delayMs / 1000)} s.`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { refreshWithRetry, isConnectionError };
