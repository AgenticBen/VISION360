// Change requests ("Change content" / "Change the app") and the change log.
// Modelled on the CRM's request queue and the night-shift skill, stored as two
// JSON files on the admin-data branch (see gh-store.mjs). Nothing acts on
// submit: a request is a note for the Claude agent, which works through them
// over MCP and replies.
//
// Rules enforced here because a JSON file can't enforce them itself:
//   - "done" needs a short summary (max 400 chars) and gets resolved_at;
//   - any other status has no resolved_at;
//   - a comment from the team reopens a done / needs-you request;
//   - a cancelled request can't change status.
import { randomUUID } from "node:crypto";
import { DATA_BRANCH } from "./gh-store.mjs";

export const REQUEST_KINDS = ["content", "app"];
export const REQUEST_STATUSES = ["open", "in_progress", "needs_ben", "done", "cancelled"];
export const CHANGE_KINDS = ["workflow", "app", "content"];
const REQ_FILE = "requests.json";
const LOG_FILE = "changelog.json";

function bad(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const clean = (s, max) => String(s == null ? "" : s).replace(/\r\n/g, "\n").trim().slice(0, max);

export function createRequests(store) {
  const now = () => new Date().toISOString();

  function find(data, id) {
    const r = data.requests.find((x) => x.id === id);
    if (!r) throw bad("Request not found", 404);
    return r;
  }

  const api = {
    async list({ includeDone = true, kind, status, page } = {}) {
      const cur = await store.readText(DATA_BRANCH, REQ_FILE);
      let rows = cur ? JSON.parse(cur.text).requests : [];
      if (kind) rows = rows.filter((r) => r.kind === kind);
      if (status) rows = rows.filter((r) => r.status === status);
      if (page) rows = rows.filter((r) => r.page_path === page);
      if (!includeDone) rows = rows.filter((r) => r.status !== "done" && r.status !== "cancelled");
      return rows.slice().sort((a, b) => (b.created_at < a.created_at ? -1 : 1));
    },

    async create({ kind, body, page_path, page_label }) {
      if (!REQUEST_KINDS.includes(kind)) throw bad("kind must be content or app");
      const text = clean(body, 4000);
      if (!text) throw bad("Write what you'd like changed.");
      let p = clean(page_path, 300) || "/";
      if (!p.startsWith("/")) p = "/" + p;
      const r = {
        id: randomUUID(), kind, title: text.split("\n")[0].slice(0, 120), body: text,
        page_path: p, page_label: clean(page_label, 200) || p,
        status: "open", comments: [], summary: null, created_at: now(), updated_at: now(), resolved_at: null,
      };
      await store.updateJson(DATA_BRANCH, REQ_FILE, (d) => { d.requests.push(r); }, `Request: ${r.title}`, { requests: [] });
      return r;
    },

    async comment(id, { author, body }) {
      const who = author === "claude" ? "claude" : "team";
      const text = clean(body, 4000);
      if (!text) throw bad("Write a comment first.");
      return store.updateJson(DATA_BRANCH, REQ_FILE, (d) => {
        const r = find(d, id);
        r.comments.push({ author: who, body: text, at: now() });
        if (who === "team" && (r.status === "done" || r.status === "needs_ben")) { r.status = "open"; r.resolved_at = null; }
        r.updated_at = now();
        return r;
      }, `Comment on request: ${id.slice(0, 8)}`, { requests: [] });
    },

    async setStatus(id, { status, summary, ref }) {
      if (!REQUEST_STATUSES.includes(status) || status === "cancelled") throw bad("status must be open, in_progress, needs_ben or done");
      const sum = clean(summary, 1000);
      if (status === "done" && !sum) throw bad("Marking a request done needs a short summary of what changed.");
      if (sum.length > 400) throw bad("Keep the summary to 400 characters or fewer (two sentences).");
      let closed = null;
      const r = await store.updateJson(DATA_BRANCH, REQ_FILE, (d) => {
        const r = find(d, id);
        if (r.status === "cancelled") throw bad("This request was cancelled. Don't make or push this change.", 409);
        r.status = status;
        r.updated_at = now();
        if (status === "done") { r.summary = sum; r.resolved_at = now(); r.ref = clean(ref, 200) || null; closed = r; }
        else { r.resolved_at = null; if (sum) r.comments.push({ author: "claude", body: sum, at: now() }); }
        return r;
      }, `Request ${status}: ${id.slice(0, 8)}`, { requests: [] });
      if (closed) {
        await api.logChange({ title: closed.title, summary: closed.summary, kind: closed.kind === "app" ? "app" : "content", ref: closed.ref, request_id: closed.id, highlight: { page: closed.page_path } });
      }
      return r;
    },

    async cancel(id) {
      return store.updateJson(DATA_BRANCH, REQ_FILE, (d) => {
        const r = find(d, id);
        if (r.status === "done") throw bad("This request is already done.", 409);
        r.status = "cancelled"; r.updated_at = now(); r.resolved_at = null;
        return r;
      }, `Request cancelled: ${id.slice(0, 8)}`, { requests: [] });
    },

    async remove(id) {
      await store.updateJson(DATA_BRANCH, REQ_FILE, (d) => {
        find(d, id);
        d.requests = d.requests.filter((x) => x.id !== id);
      }, `Request deleted: ${id.slice(0, 8)}`, { requests: [] });
      return { ok: true };
    },

    // ------------------------------------------------------- change log
    async changelog({ limit = 200 } = {}) {
      const cur = await store.readText(DATA_BRANCH, LOG_FILE);
      return (cur ? JSON.parse(cur.text).entries : []).slice(0, limit);
    },

    async logChange({ title, summary, kind = "app", ref, request_id, highlight }) {
      const t = clean(title, 160);
      if (!t) throw bad("A change needs a title.");
      const e = {
        id: randomUUID(), at: now(), title: t, summary: clean(summary, 600),
        kind: CHANGE_KINDS.includes(kind) ? kind : "app", ref: clean(ref, 200) || null, request_id: request_id || null,
        highlight: highlight && highlight.page ? { page: clean(highlight.page, 300), target: clean(highlight.target, 120) || null } : null,
      };
      await store.updateJson(DATA_BRANCH, LOG_FILE, (d) => { d.entries.unshift(e); d.entries = d.entries.slice(0, 500); }, `Change log: ${t}`, { entries: [] });
      return e;
    },
  };
  return api;
}
