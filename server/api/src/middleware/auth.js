import { getRequestIdentity } from "./optionalAuth.js";

/**
 * @param {ReturnType<import('../config.js').loadConfig>} config
 */
export function authMiddleware(config) {
  return async (req, _res, next) => {
    void config;
    try {
      req.identity = await getRequestIdentity(req);
      next();
    } catch (err) {
      next(err);
    }
  };
}
