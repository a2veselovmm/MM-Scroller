import express from "express";
import { loadConfig } from "./config.js";
import { corsMiddleware } from "./middleware/cors.js";
import { authMiddleware } from "./middleware/auth.js";
import { betaKeyMiddleware } from "./middleware/betaKey.js";
import { createJobsRouter } from "./routes/jobs.js";
import { LIMITS } from "../shared/constants.js";

const config = loadConfig();
const app = express();

app.set("trust proxy", true);
app.use(corsMiddleware(config));

// Binary job uploads must be parsed before express.json (project JSON uses application/json).
app.use((req, res, next) => {
  if (req.method === "PUT" && /\/api\/jobs\/[^/]+\/upload\//.test(req.path)) {
    return express.raw({ type: "*/*", limit: LIMITS.maxProxyUploadBytes })(req, res, next);
  }
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(authMiddleware(config));
app.use(betaKeyMiddleware(config));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "mm-scroller-api" });
});

app.use("/api/jobs", createJobsRouter(config));

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: status < 500 ? err.message : "Internal server error.",
  });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`MM-Scroller API listening on :${config.port}`);
});
