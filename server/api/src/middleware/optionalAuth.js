import { createHash } from "node:crypto";

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ uid: string|null, email: string|null, isAnonymous: boolean, hd?: string }>}
 */
export async function getRequestIdentity(req) {
  void req;
  return { uid: null, email: null, isAnonymous: true };
}

export function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || "mm-scroller";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 16);
}
