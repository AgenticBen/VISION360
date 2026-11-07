// Settings the admin can change without a deploy, kept in the private admin
// data store (Supabase admin_documents on the live site; a local folder in
// dev and tests):
//
//   settings/auth.json  { passwordHash, secret, changedAt }   the admin password
//                        (scrypt hash, never the password) and the key that
//                        signs admin sign-in cookies. Changing the password
//                        makes a new key, which signs everyone out.
//   settings/site.json  { mainFlow, voice: { elevenlabs } }   which workflow
//                        the public home page runs, and the natural-voice switch.
//
// Each server copy caches both for a short while, so a change reaches every
// copy within ttlMs.
import { randomBytes, createHash } from "node:crypto";
import { DATA_BRANCH } from "./gh-store.mjs";
import { hashPassword } from "./auth.mjs";

export const AUTH_FILE = "settings/auth.json";
export const SITE_FILE = "settings/site.json";
export const SITE_DEFAULTS = Object.freeze({ mainFlow: "referral", voice: Object.freeze({ elevenlabs: false }) });
export const MIN_PASSWORD = 8;

export function createSiteSettings({ gh, env = {}, ttlMs = 30000 }) {
  // The admin-data branch is public when it lives on GitHub without Supabase:
  // the password hash must never be written there.
  const privateData = (gh.dataKind || gh.kind) !== "github";
  const cache = new Map();

  async function read(file) {
    const hit = cache.get(file);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const cur = await gh.readText(DATA_BRANCH, file);
    const value = cur ? JSON.parse(cur.text) : null;
    cache.set(file, { at: Date.now(), value });
    return value;
  }

  async function auth() {
    const doc = privateData ? await read(AUTH_FILE) : null;
    if (doc && doc.passwordHash && doc.secret) {
      return { source: "settings", passwordHash: doc.passwordHash, secret: Buffer.from(doc.secret, "base64"), changedAt: doc.changedAt || null };
    }
    if (env.V360_ADMIN_PASSWORD_HASH) {
      const base = env.V360_SESSION_SECRET || env.V360_ADMIN_PASSWORD_HASH;
      return { source: "env", passwordHash: env.V360_ADMIN_PASSWORD_HASH, secret: createHash("sha256").update("v360-admin-session\n" + base).digest(), changedAt: null };
    }
    return { source: null, passwordHash: null, secret: null, changedAt: null };
  }

  async function setPassword(password) {
    if (!privateData) {
      const e = new Error("The admin password can only be saved in private storage (Supabase). It isn't connected here.");
      e.status = 503;
      throw e;
    }
    const pw = String(password || "");
    if (pw.length < MIN_PASSWORD) { const e = new Error(`The new password needs at least ${MIN_PASSWORD} characters.`); e.status = 400; throw e; }
    if (pw.length > 200) { const e = new Error("That password is too long."); e.status = 400; throw e; }
    const doc = { passwordHash: hashPassword(pw), secret: randomBytes(32).toString("base64"), changedAt: new Date().toISOString() };
    await gh.updateJson(DATA_BRANCH, AUTH_FILE, (d) => { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, doc); }, "Admin password changed", {});
    cache.delete(AUTH_FILE);
    return { changedAt: doc.changedAt };
  }

  async function site() {
    const doc = (await read(SITE_FILE)) || {};
    return {
      mainFlow: typeof doc.mainFlow === "string" && doc.mainFlow ? doc.mainFlow : SITE_DEFAULTS.mainFlow,
      voice: { elevenlabs: !!(doc.voice && doc.voice.elevenlabs) },
    };
  }

  async function updateSite(patch) {
    const out = await gh.updateJson(DATA_BRANCH, SITE_FILE, (d) => {
      if (patch.mainFlow !== undefined) d.mainFlow = String(patch.mainFlow);
      if (patch.voice && patch.voice.elevenlabs !== undefined) d.voice = { ...(d.voice || {}), elevenlabs: !!patch.voice.elevenlabs };
      d.updatedAt = new Date().toISOString();
    }, "Site settings changed", {});
    cache.delete(SITE_FILE);
    return out;
  }

  return { privateData, auth, setPassword, site, updateSite, invalidate: () => cache.clear() };
}
