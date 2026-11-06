// The prepared Supabase adapter, against a fake PostgREST.
import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseDocStore, createSplitStore, createAdminStore } from "../server/lib/supabase-store.mjs";
import { createLocalStore, StoreConflict, DATA_BRANCH } from "../server/lib/gh-store.mjs";
import { createRequests } from "../server/lib/requests.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function fakePostgrest() {
  const rows = new Map(); const history = []; const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || "GET"; const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, headers: init.headers });
    const eq = (k) => (u.searchParams.get(k) || "").replace(/^eq\./, "");
    const res = (status, obj) => ({ status, text: async () => (obj === undefined ? "" : JSON.stringify(obj)) });
    if (u.pathname.endsWith("/admin_documents")) {
      const key = eq("branch") + ":" + eq("path");
      if (method === "GET") { const r = rows.get(key); return res(200, r ? [{ body: r.body, sha: r.sha }] : []); }
      if (method === "POST") { const k = body.branch + ":" + body.path; if (rows.has(k)) return res(409, { message: "duplicate key" }); rows.set(k, body); history.push({ ...body, message: init.headers["x-v360-message"] }); return res(201); }
      if (method === "PATCH") { const r = rows.get(key); if (!r || r.sha !== eq("sha")) return res(200, []); Object.assign(r, body); history.push({ ...r, message: init.headers["x-v360-message"] }); return res(200, [r]); }
    }
    if (u.pathname.endsWith("/admin_document_history")) return res(200, history.filter((h) => h.branch === eq("branch") && h.path === eq("path")).reverse().map((h, i) => ({ id: i, sha: h.sha, message: h.message, written_at: new Date().toISOString() })));
    return res(404, { message: "no route" });
  };
  return { fetch, calls, rows };
}

test("Supabase doc store: service key headers, create, conditional update, conflict", async () => {
  const f = fakePostgrest();
  const st = createSupabaseDocStore({ V360_SUPABASE_URL: "https://x.supabase.co/", V360_SUPABASE_SERVICE_KEY: "svc" }, f.fetch);
  assert.equal(await st.readText(DATA_BRANCH, "requests.json"), null);
  assert.equal(f.calls[0].headers.apikey, "svc");
  assert.equal(f.calls[0].path, "/rest/v1/admin_documents");
  const w = await st.writeText(DATA_BRANCH, "requests.json", "{\"requests\":[]}\n", null, "create");
  await assert.rejects(st.writeText(DATA_BRANCH, "requests.json", "{}", null, "again"), StoreConflict);
  await assert.rejects(st.writeText(DATA_BRANCH, "requests.json", "{}", "stale", "x"), StoreConflict);
  await st.writeText(DATA_BRANCH, "requests.json", "{\"requests\":[1]}\n", w.sha, "update");
  assert.equal((await st.readText(DATA_BRANCH, "requests.json")).text, "{\"requests\":[1]}\n");
  assert.deepEqual((await st.listCommits(DATA_BRANCH, "requests.json")).map((c) => c.message), ["update", "create"]);
});

test("split store: requests go to Supabase, published workflows stay in git", async () => {
  const f = fakePostgrest();
  const local = createLocalStore(mkdtempSync(path.join(tmpdir(), "v360-split-")));
  const st = createSplitStore(local, createSupabaseDocStore({ V360_SUPABASE_URL: "https://x.supabase.co", V360_SUPABASE_SERVICE_KEY: "svc" }, f.fetch));
  assert.equal(st.dataKind, "supabase");
  const rq = createRequests(st);
  const r = await rq.create({ kind: "app", body: "Bigger buttons", page_path: "/admin/" });
  await rq.setStatus(r.id, { status: "done", summary: "Buttons are 44px now." });
  assert.ok(f.rows.has("admin-data:requests.json"));
  assert.ok(f.rows.has("admin-data:changelog.json"));
  await st.commitFiles("main", [{ path: "x.json", text: "{}" }], "publish");
  assert.equal((await st.readText("main", "x.json")).text, "{}");
  assert.ok(!f.rows.has("main:x.json"));
});

test("createAdminStore only uses Supabase when both settings are present", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "v360-pick-"));
  assert.equal(createAdminStore({}, { dir }).dataKind, undefined);
  assert.equal(createAdminStore({ V360_SUPABASE_URL: "https://x.supabase.co" }, { dir }).dataKind, undefined);
  assert.equal(createAdminStore({ V360_SUPABASE_URL: "https://x.supabase.co", V360_SUPABASE_SERVICE_KEY: "k" }, { dir }).dataKind, "supabase");
});
