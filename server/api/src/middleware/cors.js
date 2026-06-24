/**
 * @param {import('../config.js').loadConfig extends () => infer C ? C : never} config
 */
export function corsMiddleware(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-MM-Beta-Key"
    );
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  };
}
