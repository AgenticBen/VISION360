// Admin storage (GitHub / local), the request queue and the change log.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalStore, createGithubStore, StoreConflict, DATA_BRANCH } from "../server/lib/gh-store.mjs";
import { createRequests } from "../server/lib/requests.mjs";
import { makeApp, call } from "./helpers.mjs";

const fresh = () => createLocalStore(mkdtempSync(path.join(tmpdir(), "v360-store-")));

test("local store: conditional writes reject a stale sha, updateJson retries cleanly", async () => {
  const st = fresh();
  assert.equal(await st.readText(DATA_BRANCH, "x.json"), null);
  const w = await st.writeText(DATA_BRANCH, "x.json", "{\"n\":1}\n", null, "first");
  await assert.rejects(st.writeText(DATA_BRANCH, "x.json", "{\"n\":2}\n", "wrong-sha", "stale"), StoreConflict);
  await st.writeText(DATA_BRANCH, "x.json", "{\"n\":2}\n", w.sha, "second");
  await st.updateJson(DATA_BRANCH, "x.json", (d) => { d.n += 1; }, "bump", { n: 0 });
  assert.equal(JSON.parse((await st.readText(DATA_BRANCH, "x.json")).text).n, 3);
  assert.equal((await st.listCommits(DATA_BRANCH, "x.json")).length, 3);
});

test("local store: main falls back to the working copy, commits are versioned", async () => {
  const st = fresh();
  const disk = await st.readText("main", "site/data/geography.json");
  assert.ok(disk && disk.text.includes("{"));
  const c1 = await st.commitFiles("main", [{ path: "a.txt", text: "one" }, { path: "b.txt", text: "two" }], "v1");
  await st.commitFiles("main", [{ path: "a.txt", text: "uno" }], "v2");
  assert.equal((await st.readText("main", "a.txt")).text, "uno");
  assert.equal((await st.readText(c1.sha, "a.txt")).text, "one");
  assert.deepEqual((await st.listCommits("main", "a.txt")).map((c) => c.message), ["v2", "v1"]);
});

function fakeGithub() {
  const calls = [];
  const files = new Map([["admin-data:requests.json", { text: "{\"requests\":[]}\n", sha: "s1" }]]);
  let headSha = "c0";
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, body, headers: init.headers });
    const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj) });
    const cm = u.pathname.match(/\/contents\/(.+)$/);
    if (cm && method === "GET") {
      const f = files.get(u.searchParams.get("ref") + ":" + decodeURIComponent(cm[1]));
      return f ? json(200, { encoding: "base64", content: Buffer.from(f.text).toString("base64"), sha: f.sha }) : json(404, { message: "Not Found" });
    }
    if (cm && method === "PUT") {
      const key = body.branch + ":" + decodeURIComponent(cm[1]);
      const f = files.get(key);
      if ((f && f.sha) !== (body.sha || undefined)) return json(409, { message: "sha does not match" });
      const sha = "s" + (calls.length + 1);
      files.set(key, { text: Buffer.from(body.content, "base64").toString(), sha });
      return json(200, { content: { sha }, commit: { sha: "k" + sha } });
    }
    if (u.pathname.endsWith("/git/ref/heads/main")) return json(200, { object: { sha: headSha } });
    if (u.pathname.includes("/git/commits/") && method === "GET") return json(200, { tree: { sha: "t0" } });
    if (u.pathname.endsWith("/git/trees")) return json(201, { sha: "t1" });
    if (u.pathname.endsWith("/git/commits") && method === "POST") return json(201, { sha: "c1" });
    if (u.pathname.endsWith("/git/refs/heads/main") && method === "PATCH") { headSha = body.sha; return json(200, {}); }
    return json(404, { message: "unexpected " + method + " " + u.pathname });
  };
  return { fetch, calls, files };
}

test("GitHub store: token header, stale sha becomes a conflict, multi-file commit in one ref update", async () => {
  const f = fakeGithub();
  const st = createGithubStore({ V360_GITHUB_TOKEN: "test-token", V360_GITHUB_REPO: "o/r" }, f.fetch);
  const cur = await st.readText(DATA_BRANCH, "requests.json");
  assert.equal(cur.sha, "s1");
  assert.equal(f.calls[0].headers.Authorization, "Bearer test-token");
  assert.match(f.calls[0].path, /^\/repos\/o\/r\/contents\/requests\.json$/);
  await assert.rejects(st.writeText(DATA_BRANCH, "requests.json", "{}", "old", "x"), StoreConflict);
  await st.updateJson(DATA_BRANCH, "requests.json", (d) => { d.requests.push({ id: 1 }); }, "add", { requests: [] });
  assert.equal(JSON.parse(f.files.get("admin-data:requests.json").text).requests.length, 1);
  const r = await st.commitFiles("main", [{ path: "site/data/assessment.json", text: "{}" }, { path: "data/corpus.lock.json", text: "{}" }], "Publish v9");
  assert.equal(r.sha, "c1");
  const tree = f.calls.find((c) => c.path.endsWith("/git/trees"));
  assert.deepEqual(tree.body.tree.map((t) => t.path), ["site/data/assessment.json", "data/corpus.lock.json"]);
  assert.equal(tree.body.base_tree, "t0");
  const patch = f.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.body.force, false);
});

test("requests: done needs a summary, team comment reopens, cancelled is frozen, done writes the change log", async () => {
  const rq = createRequests(fresh());
  const r = await rq.create({ kind: "app", body: "Make the dashboard numbers bigger\nPlease", page_path: "/admin/", page_label: "Admin › Dashboard" });
  assert.equal(r.title, "Make the dashboard numbers bigger");
  await assert.rejects(rq.setStatus(r.id, { status: "done" }), /summary/);
  await assert.rejects(rq.setStatus(r.id, { status: "done", summary: "x".repeat(401) }), /400/);
  const done = await rq.setStatus(r.id, { status: "done", summary: "Numbers are now 2rem.", ref: "abc123" });
  assert.equal(done.status, "done");
  assert.ok(done.resolved_at);
  const log = await rq.changelog();
  assert.equal(log[0].title, "Make the dashboard numbers bigger");
  assert.equal(log[0].highlight.page, "/admin/");
  const reopened = await rq.comment(r.id, { author: "team", body: "Bigger still" });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.resolved_at, null);
  const c = await rq.create({ kind: "content", body: "Fix a phone number", page_path: "admin/data" });
  assert.equal(c.page_path, "/admin/data");
  await rq.cancel(c.id);
  await assert.rejects(rq.setStatus(c.id, { status: "in_progress" }), /cancelled/);
  await assert.rejects(rq.create({ kind: "other", body: "x" }), /kind/);
});

test("request API: create, list by page, comment, status, cancel and delete; kill switch blocks writes", async () => {
  const app = await makeApp();
  let r = await call(app, "POST", "/api/requests", { kind: "content", body: "Change the intro wording", page_path: "/admin/workflows/", page_label: "Workflows" });
  assert.equal(r.status, 201);
  const id = r.json.request.id;
  r = await call(app, "GET", "/api/requests?page=" + encodeURIComponent("/admin/workflows/"));
  assert.equal(r.json.requests.length, 1);
  r = await call(app, "POST", `/api/requests/${id}/comment`, { body: "Shorter please" });
  assert.equal(r.json.request.comments[0].author, "team");
  r = await call(app, "POST", `/api/requests/${id}/status`, { status: "done", summary: "Intro shortened." });
  assert.equal(r.status, 200);
  r = await call(app, "GET", "/api/changelog");
  assert.equal(r.json.entries[0].summary, "Intro shortened.");
  r = await call(app, "DELETE", `/api/requests/${id}`);
  assert.equal(r.status, 200);
  r = await call(app, "POST", "/api/requests", { kind: "app", body: "x" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const off = await makeApp({ V360_FLOW_EDITS: "off" });
  r = await call(off, "POST", "/api/requests", { kind: "app", body: "x" });
  assert.equal(r.status, 403);
  r = await call(off, "GET", "/api/requests");
  assert.equal(r.status, 200);
});
