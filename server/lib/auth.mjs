// Staff authentication: named accounts, scrypt-hashed passwords, HttpOnly
// session cookies. Every staff route checks the session on the server.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

export const STAFF_COOKIE = "v360_staff";

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const got = scryptSync(String(password), Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function staffCookie(token, secure, maxAgeSec = 8 * 3600) {
  return `${STAFF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearStaffCookie(secure) {
  return `${STAFF_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

// Compare a session bearer token with its stored hash in constant time.
export function tokenMatches(token, storedHash) {
  const a = Buffer.from(tokenHash(token || ""), "hex");
  const b = Buffer.from(String(storedHash || ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
