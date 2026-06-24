import { getJobsCollection, getRateLimitsCollection } from "../firestore.js";
import { hashIp } from "./optionalAuth.js";

function hourKey(d = new Date()) {
  return d.toISOString().slice(0, 13);
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * @param {ReturnType<import('../config.js').loadConfig>} config
 */
export function rateLimitMiddleware(config) {
  return async (req, res, next) => {
    try {
      const identity = req.identity || { uid: null, isAnonymous: true };
      const rateId = identity.uid || `ip:${hashIp(req.ip || req.headers["x-forwarded-for"] || "unknown")}`;
      const limitsRef = getRateLimitsCollection().doc(rateId);
      const hour = hourKey();
      const day = dayKey();

      await getJobsCollection().firestore.runTransaction(async (tx) => {
        const snap = await tx.get(limitsRef);
        const data = snap.exists ? snap.data() : {};
        const hourCount = data.hourKey === hour ? (data.hourCount || 0) : 0;
        const dayCount = data.dayKey === day ? (data.dayCount || 0) : 0;

        const maxHour = identity.uid ? config.jobsPerHour * 3 : config.jobsPerHour;
        const maxDay = identity.uid ? config.jobsPerDay * 3 : config.jobsPerDay;

        if (hourCount >= maxHour) {
          const err = new Error("Hourly job limit exceeded. Try again later.");
          err.status = 429;
          throw err;
        }
        if (dayCount >= maxDay) {
          const err = new Error("Daily job limit exceeded. Try again tomorrow.");
          err.status = 429;
          throw err;
        }

        tx.set(
          limitsRef,
          {
            hourKey: hour,
            hourCount: hourCount + 1,
            dayKey: day,
            dayCount: dayCount + 1,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      });

      next();
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  };
}
