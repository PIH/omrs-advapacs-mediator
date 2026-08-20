const crypto = require('crypto');
const logger = require('./logger');

function timingSafeEqualStrings(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Express middleware factory for a shared-secret header check, independent
 * of whatever sits in front of this app (OpenHIM channel auth, a reverse
 * proxy, etc.) -- a backstop so the route itself never trusts a bare request.
 */
function requireSharedSecret({ headerName, envVar, label }) {
  return function verifySharedSecret(req, res, next) {
    const expected = process.env[envVar];
    const provided = req.headers[headerName.toLowerCase()];
    if (!expected || !provided || !timingSafeEqualStrings(provided, expected)) {
      logger.warn(`Rejected ${label} request with invalid ${headerName} header`);
      return res.status(401).json({ status: 'error', message: 'unauthorized' });
    }
    next();
  };
}

module.exports = { requireSharedSecret, timingSafeEqualStrings };
