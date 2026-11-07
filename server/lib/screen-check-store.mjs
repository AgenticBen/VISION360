// Where screen-check results are kept: the private Supabase tables
// (screen_checks, screen_check_steps, screen_check_reviews) on the live site;
// in memory on a local server or in tests. Results are kept until staff
// delete them. Nothing here ever reaches the public repository.
//
// Both stores have the same async methods:
//   createCheck(row) getCheck(id) updateCheck(id, patch)
//   latestByCode(code) byCode(code) listChecks({ limit })
//   steps(id) putStep(id, setting, step)
//   addReview(id, review) reviews(id) reviewsSince(iso)
//   remove(ids) -> number removed
import { supabaseConfigured } from "./supabase-sessions.mjs";

const CHECK_COLS = ["id", "code", "token_hash", "created_at", "updated_at", "finished_at", "status", "assessment_session_id", "previous_check_id", "device", "goal", "age_range", "zip", "settings", "contact", "consent_contact", "wants_call", "staff_status"];
const STEP_COLS = ["check_id", "setting", "trials", "measured_limit", "recommended_value", "unit", "tries", "duration_ms", "flags"];
const pick = (o, cols) => Object.fromEntries(cols.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

export function createMemoryCheckStore() {
  const checks = new Map();
  const steps = new Map(); // id -> Map(setting -> step)
  const reviews = new Map(); // id -> [review]
  let reviewId = 0;
  const now = () => new Date().toISOString();
  return {
    kind: "memory",
    async createCheck(row) { const r = { status: "started", staff_status: "needs_review", device: {}, settings: {}, consent_contact: false, wants_call: false, created_at: now(), updated_at: now(), ...pick(row, CHECK_COLS) }; checks.set(r.id, r); return clone(r); },
    async getCheck(id) { return clone(checks.get(id) || null); },
    async updateCheck(id, patch) { const r = checks.get(id); if (!r) return null; Object.assign(r, pick(patch, CHECK_COLS), { updated_at: now() }); return clone(r); },
    async byCode(code) { return clone([...checks.values()].filter((c) => c.code === code).sort((a, b) => a.created_at < b.created_at ? -1 : 1)); },
    async latestByCode(code) { const all = await this.byCode(code); return all.length ? all[all.length - 1] : null; },
    async listChecks({ limit = 500 } = {}) {
      return clone([...checks.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit).map((c) => ({ ...c, steps: [...(steps.get(c.id) || new Map()).values()].map((s) => ({ setting: s.setting, recommended_value: s.recommended_value, measured_limit: s.measured_limit, flags: s.flags })) })));
    },
    async steps(id) { return clone([...(steps.get(id) || new Map()).values()]); },
    async putStep(id, setting, step) {
      if (!steps.has(id)) steps.set(id, new Map());
      const s = { check_id: id, setting, trials: [], tries: 0, flags: [], created_at: now(), ...pick(step, STEP_COLS) };
      steps.get(id).set(setting, s);
      return clone(s);
    },
    async addReview(id, review) { const r = { id: ++reviewId, check_id: id, created_at: now(), ...review }; if (!reviews.has(id)) reviews.set(id, []); reviews.get(id).push(r); return clone(r); },
    async reviews(id) { return clone((reviews.get(id) || []).slice().reverse()); },
    async reviewsSince(iso) { return clone([...reviews.values()].flat().filter((r) => r.created_at >= iso).map((r) => ({ check_id: r.check_id, review_ms: r.review_ms, created_at: r.created_at }))); },
    async remove(ids) { let n = 0; for (const id of ids) { if (checks.delete(id)) n++; steps.delete(id); reviews.delete(id); for (const c of checks.values()) if (c.previous_check_id === id) c.previous_check_id = null; } return n; },
  };
}

export function createSupabaseCheckStore(env, fetchImpl = globalThis.fetch) {
  const base = String(env.V360_SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1";
  const key = env.V360_SUPABASE_SERVICE_KEY;
  const headers = (extra = {}) => ({ apikey: key, ...(/^eyJ/.test(String(key)) ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...extra });
  async function req(method, url, body, extra) {
    const res = await fetchImpl(base + url, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status >= 400) {
      const e = new Error(`Supabase ${method} ${url.split("?")[0]} failed (${res.status}): ${(json && json.message) || text.slice(0, 160)}`);
      e.status = 502;
      throw e;
    }
    return json;
  }
  const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
  const enc = encodeURIComponent;
  return {
    kind: "supabase",
    async createCheck(row) { return one(await req("POST", "/screen_checks", pick(row, CHECK_COLS), { Prefer: "return=representation" })); },
    async getCheck(id) { return one(await req("GET", `/screen_checks?id=eq.${enc(id)}&select=*`)); },
    async updateCheck(id, patch) { return one(await req("PATCH", `/screen_checks?id=eq.${enc(id)}`, { ...pick(patch, CHECK_COLS), updated_at: new Date().toISOString() }, { Prefer: "return=representation" })); },
    async byCode(code) { return (await req("GET", `/screen_checks?code=eq.${enc(code)}&select=*&order=created_at.asc`)) || []; },
    async latestByCode(code) { return one(await req("GET", `/screen_checks?code=eq.${enc(code)}&select=*&order=created_at.desc&limit=1`)); },
    async listChecks({ limit = 500 } = {}) {
      return (await req("GET", `/screen_checks?select=*,steps:screen_check_steps(setting,recommended_value,measured_limit,flags)&order=created_at.desc&limit=${Math.min(1000, limit)}`)) || [];
    },
    async steps(id) { return (await req("GET", `/screen_check_steps?check_id=eq.${enc(id)}&select=*&order=created_at.asc`)) || []; },
    async putStep(id, setting, step) {
      return one(await req("POST", "/screen_check_steps?on_conflict=check_id,setting", { ...pick(step, STEP_COLS), check_id: id, setting }, { Prefer: "resolution=merge-duplicates,return=representation" }));
    },
    async addReview(id, review) { return one(await req("POST", "/screen_check_reviews", { ...review, check_id: id }, { Prefer: "return=representation" })); },
    async reviews(id) { return (await req("GET", `/screen_check_reviews?check_id=eq.${enc(id)}&select=*&order=created_at.desc`)) || []; },
    async reviewsSince(iso) { return (await req("GET", `/screen_check_reviews?created_at=gte.${enc(iso)}&select=check_id,review_ms,created_at&limit=5000`)) || []; },
    async remove(ids) {
      if (!ids.length) return 0;
      const rows = await req("DELETE", `/screen_checks?id=in.(${ids.map(enc).join(",")})`, undefined, { Prefer: "return=representation" });
      return Array.isArray(rows) ? rows.length : 0;
    },
  };
}

export function createCheckStore(env, opts = {}) {
  if (opts.checkStore) return opts.checkStore;
  return supabaseConfigured(env) ? createSupabaseCheckStore(env, opts.supabaseFetch) : createMemoryCheckStore();
}
