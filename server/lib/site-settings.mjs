// Settings the admin can change without a deploy, kept in the private admin
// data store (Supabase admin_documents on the live site; a local folder in
// dev and tests):
//
//   settings/auth.json  { passwordHash, secret, changedAt }   the admin password
//                        (scrypt hash, never the password) and the key that
//                        signs admin sign-in cookies. Changing the password
//                        makes a new key, which signs everyone out.
//   settings/site.json  { mainFlow, assessmentFlow, voice: { elevenlabs }, features: { screenCheck, orgOutreach } }
//                        what is live in each row of the admin Workflows page:
//                        mainFlow runs from Resource Assistant in the site menu
//                        (/demo/); the Vision Assessment item (/assessment/)
//                        opens the full-screen test when features.screenCheck
//                        is on, otherwise the assessmentFlow conversation. Plus
//                        the natural-voice switch.
//
// Each server copy caches both for a short while, so a change reaches every
// copy within ttlMs.
import { randomBytes, createHash } from "node:crypto";
import { DATA_BRANCH } from "./gh-store.mjs";
import { hashPassword } from "./auth.mjs";

export const AUTH_FILE = "settings/auth.json";
export const SITE_FILE = "settings/site.json";
export const SITE_DEFAULTS = Object.freeze({ mainFlow: "referral", assessmentFlow: "vision-assessment", voice: Object.freeze({ elevenlabs: false }), features: Object.freeze({ screenCheck: false, orgOutreach: false }) });
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
      assessmentFlow: typeof doc.assessmentFlow === "string" && doc.assessmentFlow ? doc.assessmentFlow : SITE_DEFAULTS.assessmentFlow,
      voice: { elevenlabs: !!(doc.voice && doc.voice.elevenlabs) },
      // Only an explicit true turns a feature on.
      features: { screenCheck: !!(doc.features && doc.features.screenCheck === true), orgOutreach: !!(doc.features && doc.features.orgOutreach === true) },
    };
  }

  async function updateSite(patch) {
    const out = await gh.updateJson(DATA_BRANCH, SITE_FILE, (d) => {
      if (patch.mainFlow !== undefined) d.mainFlow = String(patch.mainFlow);
      if (patch.assessmentFlow !== undefined) d.assessmentFlow = String(patch.assessmentFlow);
      if (patch.voice && patch.voice.elevenlabs !== undefined) d.voice = { ...(d.voice || {}), elevenlabs: !!patch.voice.elevenlabs };
      if (patch.features && patch.features.screenCheck !== undefined) d.features = { ...(d.features || {}), screenCheck: patch.features.screenCheck === true };
      if (patch.features && patch.features.orgOutreach !== undefined) d.features = { ...(d.features || {}), orgOutreach: patch.features.orgOutreach === true };
      d.updatedAt = new Date().toISOString();
    }, "Site settings changed", {});
    cache.delete(SITE_FILE);
    return out;
  }

  return { privateData, auth, setPassword, site, updateSite, invalidate: () => cache.clear() };
}
