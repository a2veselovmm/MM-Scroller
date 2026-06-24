import { getRequestIdentity } from "./optionalAuth.js";

/**
 * @param {ReturnType<import('../config.js').loadConfig>} config
 */
export function authMiddleware(config) {
  return async (req, res, next) => {
    try {
      req.identity = await getRequestIdentity(req);
      if (config.requireAuth && req.identity.isAnonymous) {
        return res.status(401).json({ error: "Authentication required." });
      }
      if (
        config.authAllowedDomain &&
        req.identity.email &&
        !req.identity.email.endsWith(`@${config.authAllowedDomain}`) &&
        req.identity.hd !== config.authAllowedDomain
      ) {
        return res.status(403).json({ error: "Email domain not allowed." });
      }
      next();
    } catch (err) {
      const status = err.status || 401;
      res.status(status).json({ error: err.message || "Unauthorized." });
    }
  };
}
