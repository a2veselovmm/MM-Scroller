import { getRequestIdentity } from "./optionalAuth.js";
import { getApprovedUsersCollection } from "../firestore.js";

function extractEmailDomain(email) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at >= value.length - 1) return "";
  return value.slice(at + 1);
}

function shouldAutoApprove(identity, domains = []) {
  if (!domains.length) return false;
  const emailDomain = extractEmailDomain(identity?.email);
  const hdDomain = String(identity?.hd || "").trim().toLowerCase();
  return domains.includes(emailDomain) || (hdDomain && domains.includes(hdDomain));
}

async function ensureApproved(identity, config) {
  if (!identity?.uid) {
    const err = new Error("Authentication required.");
    err.status = 401;
    throw err;
  }

  const now = new Date().toISOString();
  const ref = getApprovedUsersCollection().doc(identity.uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;
  const autoApproved = shouldAutoApprove(identity, config.autoApproveDomains);
  const manuallyApproved = data?.approved === true || data?.status === "approved";
  if (autoApproved) {
    await ref.set(
      {
        uid: identity.uid,
        email: identity.email || null,
        hd: identity.hd || null,
        approved: true,
        status: "approved",
        approvalSource: "domain-auto",
        approvedAt: data?.approvedAt || now,
        firstRequestAt: data?.firstRequestAt || now,
        lastRequestAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    return;
  }
  if (manuallyApproved) return;

  await ref.set(
    {
      uid: identity.uid,
      email: identity.email || null,
      hd: identity.hd || null,
      approved: false,
      status: data?.status || "pending",
      firstRequestAt: data?.firstRequestAt || now,
      lastRequestAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  const err = new Error("Account pending approval.");
  err.status = 403;
  throw err;
}

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
      if (config.requireApproval) {
        await ensureApproved(req.identity, config);
      }
      next();
    } catch (err) {
      const status = err.status || 401;
      res.status(status).json({ error: err.message || "Unauthorized." });
    }
  };
}
