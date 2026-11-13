// How the assistant can contact each organization for the person, and whether
// it may right now. Kept apart from the public directory data: staff choices
// live in the private admin store (settings/outreach.json, every change kept).
//
//   settings/outreach.json  { orgs: { <orgId>: { channel: "auto"|"email"|"none", email?, note?, updatedBy, updatedAt } } }
//
// Rules for "auto" (no staff choice):
//   - organizations whose listing says they don't take referrals from others
//     ("no") are never contacted; the person gets their phone number instead;
//   - otherwise email, if the listing's general email is exactly one address;
//   - anything else (no email, several addresses or notes) needs a staff choice.
// Form submission (phase 3) adds a "form" channel for approved form recipes.
import { DATA_BRANCH } from "./gh-store.mjs";
import { outreachLive, outreachTestInbox } from "./actions.mjs";

export const OUTREACH_FILE = "settings/outreach.json";
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const CHANNELS = ["auto", "email", "none"];

export function singleEmail(raw) {
  const s = String(raw || "").trim();
  return EMAIL_RE.test(s) ? s : null;
}

// Pure: the channel for one organization record, given a staff override.
export function channelFor(org, override) {
  const o = override || {};
  if (org.accepts_third_party_referral === "no") return { channel: "none", email: null, why: "Their listing says people should contact them directly." };
  if (o.channel === "none") return { channel: "none", email: null, why: "Staff turned contact off for this organization." };
  if (o.channel === "email") {
    const e = singleEmail(o.email);
    return e ? { channel: "email", email: e, why: "Staff chose this address." } : { channel: "none", email: null, why: "The staff address isn't a valid email." };
  }
  const listed = singleEmail(org.contacts && org.contacts.general_email);
  if (listed) return { channel: "email", email: listed, why: "From the directory listing." };
  if (org.contacts && org.contacts.general_email) return { channel: "none", email: null, why: "The listing has several addresses or notes; staff need to pick one." };
  return { channel: "none", email: null, why: "No email in the listing." };
}

export function createOutreachDirectory({ gh, settings, corpus, env, transportName, ttlMs = 30000 }) {
  let cache = null;

  async function overrides() {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    const cur = await gh.readText(DATA_BRANCH, OUTREACH_FILE).catch(() => null);
    const value = cur ? (JSON.parse(cur.text).orgs || {}) : {};
    cache = { at: Date.now(), value };
    return value;
  }

  // Why outreach can't be offered right now, or null when it can.
  function blocker(site) {
    if (!(site.features && site.features.orgOutreach)) return "Switched off in Admin › Outreach.";
    if (outreachLive(env)) return null;
    if (transportName() === "outbox") return null; // local test outbox: nothing leaves the machine
    return outreachTestInbox(env) ? null : "No demo test inbox: set V360_OUTREACH_TEST_INBOX or add an exact address to V360_EMAIL_ALLOWLIST.";
  }

  // What the conversation needs for one turn.
  async function forTurn() {
    const site = await settings.site().catch(() => ({ features: {} }));
    const why = blocker(site);
    if (why) return { enabled: false, why };
    const ov = await overrides();
    const orgs = {};
    for (const org of corpus.organizations) {
      const c = channelFor(org, ov[org.id]);
      if (c.channel !== "none") orgs[org.id] = { channel: c.channel, email: c.email };
    }
    return { enabled: true, live: outreachLive(env), testInbox: outreachTestInbox(env) || "outreach-test@example.org", replyTo: env.V360_OUTREACH_REPLY_TO || null, orgs };
  }

  // Admin view: every organization with its channel and the reason.
  async function table() {
    const ov = await overrides();
    return corpus.organizations.map((org) => {
      const c = channelFor(org, ov[org.id]);
      return { id: org.id, name: org.name, referral: org.accepts_third_party_referral, listedEmail: org.contacts.general_email || null, override: ov[org.id] || null, ...c };
    });
  }

  async function setOverride(orgId, patch, by) {
    if (!corpus.byId.has(orgId)) { const e = new Error("Unknown organization."); e.status = 404; throw e; }
    const channel = CHANNELS.includes(patch.channel) ? patch.channel : "auto";
    const email = channel === "email" ? singleEmail(patch.email) : null;
    if (channel === "email" && !email) { const e = new Error("Enter one valid email address."); e.status = 400; throw e; }
    await gh.updateJson(DATA_BRANCH, OUTREACH_FILE, (d) => {
      d.orgs = d.orgs || {};
      if (channel === "auto" && !patch.note) delete d.orgs[orgId];
      else d.orgs[orgId] = { channel, ...(email ? { email } : {}), ...(patch.note ? { note: String(patch.note).slice(0, 300) } : {}), updatedBy: by, updatedAt: new Date().toISOString() };
    }, `Outreach contact for ${orgId} changed`, { orgs: {} });
    cache = null;
  }

  async function status() {
    const site = await settings.site().catch(() => ({ features: {} }));
    return { on: !!(site.features && site.features.orgOutreach), live: outreachLive(env), testInbox: outreachTestInbox(env), transport: transportName(), blocker: blocker(site) };
  }

  return { forTurn, table, setOverride, status, invalidate: () => { cache = null; } };
}
