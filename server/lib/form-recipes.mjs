// Form recipes: for one organization's online form, which field gets which of
// the person's details, how to submit, and how to tell it worked. Staff build
// them (with AI help drafting from the form's labels) and approve them; the
// form runner only ever fills a form from an approved recipe.
//
// Kept in the private admin store: outreach/recipes/<orgId>.json
//   { orgId, version, status, url, allowDomains[], fingerprint: { fieldsHash },
//     fields: [{ selector, kind, label, source, required, maxLength, optionMap }],
//     submit: { selector }, success: { urlIncludes | textIncludes | selectorVisible },
//     history: [{ at, by, what }] }
//
// status: draft -> test_approved (runs only against our own test form while
// V360_OUTREACH_LIVE is off) -> live_approved (may fill the real form once
// outreach is live) -> retired.
import { createHash } from "node:crypto";
import { DATA_BRANCH } from "./gh-store.mjs";

export const RECIPE_DIR = "outreach/recipes";
export const STATUSES = ["draft", "test_approved", "live_approved", "retired"];
// The only things a recipe may put into a form: the person's name and contact
// details and fixed referral wording. Never their answers about health, money
// or anything else personal.
export const SOURCES = ["person.fullName", "person.firstName", "person.lastName", "person.phone", "person.email", "person.preferredContact", "referrer.name", "referrer.organization", "note.referral", "org.name"];
const KINDS = ["text", "email", "tel", "textarea", "select", "radio", "checkbox"];
// Fields a recipe may never fill: agreeing to terms or consent is the person's own act.
const CONSENT_LABEL = /\b(agree|terms|consent|privacy policy|i certify|attest|signature|sign here)\b/i;

export const TEST_FORM_ID = "__test-form";
export const TEST_FORM_PATH = "/outreach-test-form/";

export function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

export function validateRecipe(r) {
  const p = [];
  if (!r || typeof r !== "object") return ["The recipe is empty."];
  let u = null;
  try { u = new URL(r.url); } catch { p.push("The form address isn't a valid link."); }
  if (u && u.protocol !== "https:" && !(r.orgId === TEST_FORM_ID && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host))) p.push("The form address must start with https://.");
  if (!Array.isArray(r.fields) || !r.fields.length) p.push("Add at least one field.");
  for (const [i, f] of (r.fields || []).entries()) {
    const at = `Field ${i + 1}${f && f.label ? ` (${f.label})` : ""}`;
    if (!f || typeof f.selector !== "string" || !f.selector.trim()) p.push(`${at}: needs a selector.`);
    if (!KINDS.includes(f && f.kind)) p.push(`${at}: unknown kind "${f && f.kind}".`);
    const src = String((f && f.source) || "");
    if (!SOURCES.includes(src) && !src.startsWith("const:")) p.push(`${at}: "${src}" isn't something a recipe may fill in. Use one of: ${SOURCES.join(", ")}, or const:<fixed text>.`);
    if (f && f.kind === "checkbox" && (CONSENT_LABEL.test(f.label || "") || CONSENT_LABEL.test(f.selector || ""))) p.push(`${at}: ticking terms or consent boxes is the person's own decision, so this form can't be filled automatically. Leave this organization on email.`);
  }
  if (!r.submit || !r.submit.selector) p.push("Say which button submits the form.");
  const s = r.success || {};
  if (!s.urlIncludes && !s.textIncludes && !s.selectorVisible) p.push("Say how to tell the form went through (text on the thank-you page, part of its address, or an element that appears).");
  if (!Array.isArray(r.allowDomains) || !r.allowDomains.length) p.push("List the web addresses the form needs (allowDomains), so the browser can't reach anything else.");
  return p;
}

// What the person agreed to depends on the recipe exactly as it was then.
export function recipeHash(r) {
  const pick = { orgId: r.orgId, version: r.version, url: r.url, allowDomains: r.allowDomains, fingerprint: r.fingerprint || null, fields: r.fields, submit: r.submit, success: r.success };
  return createHash("sha256").update(JSON.stringify(pick)).digest("hex");
}

// Our own practice form, used for every form job while outreach isn't live.
export function testFormRecipe(origin) {
  const base = String(origin || "https://vision360.agenticarc.ai").replace(/\/+$/, "");
  return {
    orgId: TEST_FORM_ID, version: 1, status: "test_approved", builtIn: true,
    url: base + TEST_FORM_PATH, allowDomains: [hostOf(base)],
    fields: [
      { selector: "#full_name", kind: "text", label: "Full name", source: "person.fullName", required: true },
      { selector: "#phone", kind: "tel", label: "Phone", source: "person.phone" },
      { selector: "#email", kind: "email", label: "Email", source: "person.email" },
      { selector: "#preferred", kind: "select", label: "Best way to reach you", source: "person.preferredContact" },
      { selector: "#referrer", kind: "text", label: "Referred by", source: "referrer.organization" },
      { selector: "#intended_org", kind: "text", label: "Organization this was meant for", source: "org.name" },
      { selector: "#note", kind: "textarea", label: "Anything else", source: "note.referral" },
    ],
    submit: { selector: "#submit" },
    success: { selectorVisible: "#done:not([hidden])" },
  };
}

// The values a form job may use, from what the person confirmed.
export function formValues(person, org) {
  const parts = String(person.name || "").trim().split(/\s+/);
  return {
    "person.fullName": person.name || "",
    "person.firstName": parts[0] || "",
    "person.lastName": parts.length > 1 ? parts.slice(1).join(" ") : "",
    "person.phone": person.phone || "",
    "person.email": person.email || "",
    "person.preferredContact": person.phone && person.preferred !== "email" ? "phone" : "email",
    "referrer.name": person.helperName || "Vision 360 CONNECT",
    "referrer.organization": "Vision 360 CONNECT (Lions Services, Inc.)",
    "note.referral": `Referred by Vision 360 CONNECT (Lions Services) at ${person.name}'s request. Based on what they told us, they may be eligible for your services. Please contact them${person.phone ? " by phone at " + person.phone : ""}${person.phone && person.email ? " or" : ""}${person.email ? " by email at " + person.email : ""}.`,
    "org.name": org.name,
  };
}

// The same values with each field's label, for a staff member doing it by hand.
export function staffFields(recipe, values) {
  const out = {};
  for (const f of recipe.fields) {
    const v = f.source.startsWith("const:") ? f.source.slice(6) : values[f.source];
    if (v) out[f.label || f.selector] = v;
  }
  return out;
}

export function createFormRecipes({ gh, corpus, origin }) {
  const file = (orgId) => `${RECIPE_DIR}/${orgId}.json`;
  let cache = null;

  async function get(orgId) {
    if (orgId === TEST_FORM_ID) return testFormRecipe(origin());
    const cur = await gh.readText(DATA_BRANCH, file(orgId)).catch(() => null);
    return cur ? JSON.parse(cur.text) : null;
  }

  // Every organization with a form link, with its recipe if there is one.
  async function list() {
    if (cache && Date.now() - cache.at < 30000) return cache.value;
    const out = [];
    for (const org of corpus.organizations) {
      if (!org.contacts.intake_form_url) continue;
      const r = await get(org.id);
      out.push({ orgId: org.id, name: org.name, formUrl: org.contacts.intake_form_url, recipe: r });
    }
    cache = { at: Date.now(), value: out };
    return out;
  }

  // Approved recipes by organization, for the conversation.
  async function approved() {
    const map = {};
    for (const x of await list()) if (x.recipe && ["test_approved", "live_approved"].includes(x.recipe.status)) map[x.orgId] = x.recipe;
    return map;
  }

  async function save(orgId, draft, by) {
    if (!corpus.byId.has(orgId)) { const e = new Error("Unknown organization."); e.status = 404; throw e; }
    const out = await gh.updateJson(DATA_BRANCH, file(orgId), (d) => {
      const version = (d.version || 0) + 1;
      const keep = { url: draft.url, allowDomains: draft.allowDomains, fingerprint: draft.fingerprint || d.fingerprint || null, fields: draft.fields, submit: draft.submit, success: draft.success };
      Object.keys(d).forEach((k) => { if (k !== "history") delete d[k]; });
      Object.assign(d, { orgId, version, status: "draft", ...keep, history: [...(d.history || []), { at: new Date().toISOString(), by, what: `saved version ${version} as a draft` }].slice(-30) });
    }, `Form recipe for ${orgId} saved`, {});
    cache = null;
    return out;
  }

  async function setStatus(orgId, status, by) {
    if (!STATUSES.includes(status)) { const e = new Error("Unknown status."); e.status = 400; throw e; }
    const r = await get(orgId);
    if (!r) { const e = new Error("There's no recipe for this organization yet."); e.status = 404; throw e; }
    if (status === "test_approved" || status === "live_approved") {
      const problems = validateRecipe(r);
      if (problems.length) { const e = new Error(problems.join(" ")); e.status = 400; throw e; }
      if (!r.fingerprint || !r.fingerprint.fieldsHash) { const e = new Error("Inspect the form first, so a changed page can be noticed."); e.status = 400; throw e; }
      if (status === "live_approved" && r.status !== "test_approved") { const e = new Error("Approve it for testing first, and do a dry run, before approving it for real."); e.status = 400; throw e; }
    }
    await gh.updateJson(DATA_BRANCH, file(orgId), (d) => {
      d.status = status;
      d.history = [...(d.history || []), { at: new Date().toISOString(), by, what: `status ${status}` }].slice(-30);
    }, `Form recipe for ${orgId}: ${status}`, {});
    cache = null;
    return get(orgId);
  }

  async function setFingerprint(orgId, fieldsHash, by) {
    await gh.updateJson(DATA_BRANCH, file(orgId), (d) => {
      d.fingerprint = { fieldsHash, at: new Date().toISOString() };
      // The page is part of what was approved: a new look needs approving again.
      if (d.status === "test_approved" || d.status === "live_approved") d.status = "draft";
      d.history = [...(d.history || []), { at: new Date().toISOString(), by, what: "inspected the form" }].slice(-30);
    }, `Form recipe for ${orgId} inspected`, { orgId, version: 0, status: "draft", fields: [] });
    cache = null;
  }

  return { get, list, approved, save, setStatus, setFingerprint, invalidate: () => { cache = null; } };
}
