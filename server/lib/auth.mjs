// Staff authentication: named accounts, scrypt-hashed passwords, HttpOnly
// session cookies. Every staff route checks the session on the server.
import { scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } from "node:crypto";

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

// Signed staff sessions: the cookie carries the username and expiry plus an
// HMAC, so every server copy can check it without shared session storage.
// The signing secret is V360_SESSION_SECRET, or else derived from server-only
// values (the staff password hash), so it never reaches the browser.
export function sessionSecret(env) {
  const base = env.V360_SESSION_SECRET || env.V360_STAFF_PASSWORD_HASH || "";
  return base ? createHash("sha256").update("v360-staff-session\n" + base).digest() : null;
}
export function signSession(secret, username, hours = 8) {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  const body = `v1.${Buffer.from(username).toString("base64url")}.${exp}`;
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
}
export function verifySession(secret, value) {
  if (!secret || !String(value || "").startsWith("v1.")) return null;
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  const body = parts.slice(0, 3).join(".");
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(parts[3], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (Number(parts[2]) * 1000 < Date.now()) return null;
  return Buffer.from(parts[1], "base64url").toString("utf8");
}

// Compare a session bearer token with its stored hash in constant time.
export function tokenMatches(token, storedHash) {
  const a = Buffer.from(tokenHash(token || ""), "hex");
  const b = Buffer.from(String(storedHash || ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
