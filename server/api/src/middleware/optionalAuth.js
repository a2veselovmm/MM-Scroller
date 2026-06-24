import { createHash } from "node:crypto";

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ uid: string|null, email: string|null, isAnonymous: boolean, hd?: string }>}
 */
export async function getRequestIdentity(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return { uid: null, email: null, isAnonymous: true };
  }
  try {
    const { getAuth } = await import("firebase-admin/auth");
    const decoded = await getAuth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email || null,
      isAnonymous: false,
      hd: decoded.hd || undefined,
    };
  } catch {
    const err = new Error("Invalid authentication token.");
    err.status = 401;
    throw err;
  }
}

export function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || "mm-scroller";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 16);
}
