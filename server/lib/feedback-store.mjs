// Feedback people leave at the end of a conversation, kept apart from the
// conversations themselves (deleting a conversation keeps its feedback).
//
//   Live (Supabase configured): the public.feedback table, through the REST API
//   with the server key (supabase/migrations/20261108000500_feedback.sql).
//   Local dev and tests: a feedback table in the local SQLite file.
//
// One row per conversation. Sending text and then a rating updates the same
// row; a skip is a row with skipped = true, so the response rate can be shown.
import { randomUUID } from "node:crypto";
import { supabaseConfigured } from "./supabase-sessions.mjs";

export const MAX_FEEDBACK = 4000;
const TOOLS = ["assistant", "assessment", "form"];
const MODES = ["spoken", "typed", "spoken_edited"];

// Checks and tidies what a person sent. Throws { status: 400 } on bad input.
export function cleanFeedback(body) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const out = {};
  if (body.text !== undefined && body.text !== null) {
    const t = String(body.text).replace(/\r\n/g, "\n").trim();
    if (t.length > MAX_FEEDBACK) bad(`Feedback can be up to ${MAX_FEEDBACK} characters.`);
    out.text = t || null;
  }
  if (body.rating !== undefined && body.rating !== null) {
    const r = Number(body.rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) bad("The rating must be a whole number from 1 to 5.");
    out.rating = r;
  }
  if (body.mode !== undefined && body.mode !== null) {
    if (!MODES.includes(body.mode)) bad("Unknown feedback mode.");
    out.mode = body.mode;
  }
  if (out.text === undefined && out.rating === undefined) bad("Send some feedback or a rating, or skip.");
  return out;
}

function sqliteBackend(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE, flow_id TEXT, flow_title TEXT, tool TEXT NOT NULL,
    mode TEXT, text TEXT, rating INTEGER, skipped INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at DESC);`);
  const q = (sql) => db.prepare(sql);
  const out = (r) => r && { ...r, skipped: !!r.skipped };
  return {
    kind: "sqlite",
    async upsert(row) {
      const now = new Date().toISOString();
      const cur = q("SELECT * FROM feedback WHERE session_id=?").get(row.session_id);
      if (!cur) {
        q(`INSERT INTO feedback (id, created_at, updated_at, session_id, flow_id, flow_title, tool, mode, text, rating, skipped)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), now, now, row.session_id, row.flow_id ?? null, row.flow_title ?? null, row.tool,
          row.mode ?? null, row.text ?? null, row.rating ?? null, row.skipped ? 1 : 0);
      } else {
        const next = { ...cur, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) };
        q(`UPDATE feedback SET updated_at=?, mode=?, text=?, rating=?, skipped=? WHERE session_id=?`)
          .run(now, next.mode ?? null, next.text ?? null, next.rating ?? null, next.skipped ? 1 : 0, row.session_id);
      }
      return out(q("SELECT * FROM feedback WHERE session_id=?").get(row.session_id));
    },
    async list({ tool, from, to, rating, q: text, limit = 50, offset = 0, includeSkipped = false } = {}) {
      const where = [], args = [];
      if (!includeSkipped) where.push("skipped=0");
      if (tool) { where.push("tool=?"); args.push(tool); }
      if (from) { where.push("created_at>=?"); args.push(from); }
      if (to) { where.push("created_at<?"); args.push(to); }
      if (rating) { where.push("rating=?"); args.push(Number(rating)); }
      if (text) { where.push("LOWER(COALESCE(text,'')) LIKE ?"); args.push("%" + String(text).toLowerCase() + "%"); }
      const w = where.length ? " WHERE " + where.join(" AND ") : "";
      const total = q(`SELECT COUNT(*) AS n FROM feedback${w}`).get(...args).n;
      const items = q(`SELECT * FROM feedback${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(out);
      return { items, total };
    },
    async remove(ids) {
      let n = 0;
      for (const id of ids) n += Number(q("DELETE FROM feedback WHERE id=?").run(id).changes || 0);
      return n;
    },
    async rows(since) {
      return q("SELECT tool, rating, skipped, text FROM feedback WHERE created_at>=?").all(since).map(out);
    },
  };
}

function supabaseBackend(env, fetchImpl) {
  const base = String(env.V360_SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1";
  const key = env.V360_SUPABASE_SERVICE_KEY;
  const headers = (extra = {}) => ({ apikey: key, ...(/^eyJ/.test(String(key)) ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...extra });
  async function req(method, url, body, extra) {
    const res = await fetchImpl(base + url, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status >= 400) {
      const e = new Error(`Supabase ${method} /feedback failed (${res.status}): ${(json && json.message) || text.slice(0, 160)}`);
      e.status = 502;
      throw e;
    }
    return { json, res };
  }
  const enc = encodeURIComponent;
  return {
    kind: "supabase",
    async upsert(row) {
      const body = { ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)), updated_at: new Date().toISOString() };
      const { json } = await req("POST", "/feedback?on_conflict=session_id", body, { Prefer: "resolution=merge-duplicates,return=representation" });
      return Array.isArray(json) ? json[0] : json;
    },
    async list({ tool, from, to, rating, q: text, limit = 50, offset = 0, includeSkipped = false } = {}) {
      const f = [];
      if (!includeSkipped) f.push("skipped=eq.false");
      if (tool) f.push("tool=eq." + enc(tool));
      if (from) f.push("created_at=gte." + enc(from));
      if (to) f.push("created_at=lt." + enc(to));
      if (rating) f.push("rating=eq." + Number(rating));
      if (text) f.push("text=ilike." + enc("*" + String(text).replace(/[*,()]/g, " ") + "*"));
      const { json, res } = await req("GET", `/feedback?select=*&order=created_at.desc&limit=${limit}&offset=${offset}${f.length ? "&" + f.join("&") : ""}`, undefined, { Prefer: "count=exact" });
      const range = res.headers && res.headers.get ? res.headers.get("content-range") : null;
      const total = range && /\/(\d+)$/.test(range) ? Number(range.match(/\/(\d+)$/)[1]) : (json || []).length;
      return { items: json || [], total };
    },
    async remove(ids) {
      if (!ids.length) return 0;
      const { json } = await req("DELETE", `/feedback?id=in.(${ids.map(enc).join(",")})`, undefined, { Prefer: "return=representation" });
      return (json || []).length;
    },
    async rows(since) {
      const { json } = await req("GET", `/feedback?select=tool,rating,skipped,text&created_at=gte.${enc(since)}&limit=10000`);
      return json || [];
    },
  };
}

export function createFeedbackStore({ env = {}, store, fetch: fetchImpl = globalThis.fetch } = {}) {
  const b = supabaseConfigured(env) ? supabaseBackend(env, fetchImpl) : sqliteBackend(store.db);
  return {
    kind: b.kind,
    TOOLS,
    upsert: b.upsert,
    list: b.list,
    remove: b.remove,
    // Last 30 days: how many left feedback, the average rating, and the share
    // of finished conversations that answered rather than skipped.
    async stats(days = 30) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = await b.rows(since);
      const answered = rows.filter((r) => !r.skipped && (r.text || r.rating));
      const rated = answered.filter((r) => r.rating);
      return {
        days,
        items: answered.length,
        skipped: rows.filter((r) => r.skipped).length,
        responseRate: rows.length ? answered.length / rows.length : null,
        averageRating: rated.length ? Math.round((rated.reduce((n, r) => n + Number(r.rating), 0) / rated.length) * 10) / 10 : null,
      };
    },
  };
}
