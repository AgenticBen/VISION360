// Conversations kept in a shared database: two server copies, each with its
// own SQLite cache, serve the same conversation (Supabase in production).
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/lib/api.mjs";
import { openStore } from "../server/lib/store.mjs";
import { createSupabaseSessions } from "../server/lib/supabase-sessions.mjs";
import { call } from "./helpers.mjs";

function fakeRemote() {
  const rows = new Map();
  return {
    rows,
    kind: "fake",
    async get(id) { const r = rows.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; },
    async versions({ since, due } = {}) {
      return [...rows.values()].filter((r) => due ? r.next_action_at && r.next_action_at <= new Date().toISOString() : r.bundle.session.created_at >= since).map((r) => ({ id: r.bundle.session.id, version: r.version }));
    },
    async put(bundle, expected) {
      const id = bundle.session.id;
      const cur = rows.get(id);
      if (expected === null && cur) return false;
      if (expected !== null && expected !== undefined && (!cur || cur.version !== expected)) return false;
      const due = (bundle.rows.actions || []).filter((a) => a.status === "queued" || a.status === "retrying").map((a) => a.next_attempt_at).sort()[0] || null;
      rows.set(id, JSON.parse(JSON.stringify({ version: bundle.session.version, next_action_at: due, bundle })));
      return true;
    },
    async purge() { return 0; },
  };
}

let n = 0;
async function copy(remote) {
  const tmp = process.env.TMPDIR || "/tmp";
  return createApp({ store: openStore(":memory:"), sessionRemote: remote, env: { V360_ADMIN_SIGNIN: "off", V360_OUTBOX_DIR: tmp + "/v360-outbox", V360_ADMIN_STORE_DIR: `${tmp}/v360-durable-${process.pid}-${++n}` } });
}
const turn = (app, s, text) => call(app, "POST", `/api/session/${s.id}/turn`, { text, clientTurnId: "c" + Math.random() }, { authorization: "Bearer " + s.token });

test("a conversation started on one server copy continues on another", async () => {
  const remote = fakeRemote();
  const a = await copy(remote), b = await copy(remote);
  const r = await call(a, "POST", "/api/session", { noticeAccepted: true, mode: "text" });
  assert.equal(r.status, 201);
  const s = { id: r.json.sessionId, token: r.json.token };
  assert.ok(remote.rows.has(s.id), "saved to the database on start");
  const t1 = await turn(b, s, "Sam");
  assert.equal(t1.status, 200, JSON.stringify(t1.json));
  const t2 = await turn(a, s, "I can't read the newspaper any more");
  assert.equal(t2.status, 200, JSON.stringify(t2.json));
  const st = await call(b, "GET", `/api/session/${s.id}/state`, undefined, { authorization: "Bearer " + s.token });
  assert.equal(st.status, 200);
  assert.equal(remote.rows.get(s.id).version, a.store.getSession(s.id).version);
  // The other copy's admin list sees it too.
  const list = await call(b, "GET", "/api/staff/sessions");
  assert.ok(list.json.sessions.some((x) => x.id === s.id));
  const health = await call(b, "GET", "/api/health");
  assert.equal(health.json.stores.sessions, "supabase");
});

test("a turn saved elsewhere since this copy loaded is refused with 409", async () => {
  const remote = fakeRemote();
  const a = await copy(remote);
  const r = await call(a, "POST", "/api/session", { noticeAccepted: true, mode: "text" });
  const id = r.json.sessionId;
  // Simulate another copy saving a newer version behind this one's back.
  const row = remote.rows.get(id);
  const realGet = remote.get;
  remote.get = async () => null; // this copy can't see the newer version when loading
  row.version += 5;
  const t = await turn(a, { id, token: r.json.token }, "Sam");
  remote.get = realGet;
  assert.equal(t.status, 409);
});

test("Supabase adapter: guarded update and new-row insert", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    if (init.method === "PATCH") return new Response(url.includes("version=eq.3") ? "[]" : "[{}]", { status: 200 });
    if (init.method === "POST") return new Response("", { status: 201 });
    return new Response("[]", { status: 200 });
  };
  const remote = createSupabaseSessions({ V360_SUPABASE_URL: "https://x.supabase.co", V360_SUPABASE_SERVICE_KEY: "sb_secret_abc" }, fetch);
  const bundle = { session: { id: "11111111-1111-1111-1111-111111111111", version: 4, created_at: "t", updated_at: "t", expires_at: "t", status: "active", staff_status: "pending" }, rows: { actions: [], staff_reviews: [] } };
  assert.equal(await remote.put(bundle, 3), false);
  assert.equal(await remote.put(bundle, 2), true);
  assert.equal(await remote.put(bundle, null), true);
  assert.match(calls[0].url, /session_bundles\?id=eq\.1111.*&version=eq\.3/);
  assert.equal(calls[0].headers.apikey, "sb_secret_abc");
  assert.equal(calls[0].headers.Authorization, undefined);
});
