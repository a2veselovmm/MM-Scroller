import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

let cachedBetaKey = null;

/**
 * @param {ReturnType<import('../config.js').loadConfig>} config
 */
export function betaKeyMiddleware(config) {
  if (!config.requireBetaKey) {
    return (_req, _res, next) => next();
  }
  return async (req, res, next) => {
    try {
      if (!cachedBetaKey) {
        const client = new SecretManagerServiceClient();
        const name = `projects/${config.projectId}/secrets/${config.betaKeySecret}/versions/latest`;
        const [version] = await client.accessSecretVersion({ name });
        cachedBetaKey = version.payload?.data?.toString("utf8") || "";
      }
      const provided = req.headers["x-mm-beta-key"];
      if (!provided || provided !== cachedBetaKey) {
        return res.status(403).json({ error: "Beta access key required." });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
