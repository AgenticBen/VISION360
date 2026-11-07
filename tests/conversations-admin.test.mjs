// Admin › Conversations: filters, and permanent delete that needs "DELETE".
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, startSession } from "./helpers.mjs";

test("filters: by workflow, staff status, stage and paging; list includes deleted workflows by stored title", async () => {
  const app = await makeApp();
  const a = await startSession(app), b = await startSession(app), c = await startSession(app);
  // One conversation from a workflow that no longer exists.
  app.store.db.prepare("UPDATE sessions SET flow_id='old-form', flow_title='Old form' WHERE id=?").run(c.id);
  await call(app, "POST", `/api/staff/sessions/${b.id}/status`, { staffStatus: "reviewed" });
  let r = await call(app, "GET", "/api/staff/sessions");
  assert.equal(r.json.total, 3);
  const old = r.json.flows.find((f) => f.id === "old-form");
  assert.deepEqual(old, { id: "old-form", title: "Old form", live: false });
  assert.ok(r.json.flows.some((f) => f.id === "referral" && f.live));
  r = await call(app, "GET", "/api/staff/sessions?flow=referral");
  assert.deepEqual(r.json.sessions.map((s) => s.id).sort(), [a.id, b.id].sort());
  r = await call(app, "GET", "/api/staff/sessions?flow=old-form");
  assert.equal(r.json.sessions[0].flowLive, false);
  r = await call(app, "GET", "/api/staff/sessions?status=reviewed");
  assert.deepEqual(r.json.sessions.map((s) => s.id), [b.id]);
  const phase = r.json.sessions[0].phase;
  r = await call(app, "GET", "/api/staff/sessions?stage=" + phase);
  assert.ok(r.json.total >= 1 && r.json.sessions.every((s) => s.phase === phase));
  r = await call(app, "GET", "/api/staff/sessions?stage=ended");
  assert.equal(r.json.total, 0);
  r = await call(app, "GET", "/api/staff/sessions?limit=2");
  assert.equal(r.json.sessions.length, 2);
  r = await call(app, "GET", "/api/staff/sessions?limit=2&offset=2");
  assert.equal(r.json.sessions.length, 1);
  r = await call(app, "GET", `/api/staff/sessions/${c.id}`);
  assert.equal(r.json.flow.title, "Old form");
  assert.equal(r.json.flow.live, false);
});

test("delete: one or many, only with DELETE, and everything about them goes", async () => {
  const app = await makeApp();
  const a = await startSession(app), b = await startSession(app), keep = await startSession(app);
  let r = await call(app, "POST", "/api/admin/conversations/delete", { ids: [a.id], confirm: "Delete" });
  assert.equal(r.status, 400);
  r = await call(app, "POST", "/api/admin/conversations/delete", { ids: [], confirm: "DELETE" });
  assert.equal(r.status, 400);
  r = await call(app, "POST", "/api/admin/conversations/delete", { ids: ["not-a-uuid"], confirm: "DELETE" });
  assert.equal(r.status, 400);
  r = await call(app, "POST", "/api/admin/conversations/delete", { ids: [a.id], confirm: "DELETE" });
  assert.equal(r.json.deleted, 1);
  r = await call(app, "POST", "/api/admin/conversations/delete", { ids: [b.id, keep.id + ""].slice(0, 1), confirm: "DELETE" });
  assert.equal(r.json.deleted, 1);
  const n = (tbl, id) => app.store.db.prepare(`SELECT COUNT(*) n FROM ${tbl} WHERE session_id=?`).get(id).n;
  assert.equal(n("answer_events", a.id) + n("audit_events", a.id), 0);
  r = await call(app, "GET", "/api/staff/sessions");
  assert.deepEqual(r.json.sessions.map((s) => s.id), [keep.id]);
  // The participant's link stops working.
  r = await call(app, "GET", `/api/session/${a.id}/state`, undefined, { authorization: "Bearer " + a.token });
  assert.equal(r.status, 404);
  r = await call(app, "GET", "/api/changelog");
  assert.ok(r.json.entries.some((e) => e.title === "Conversations deleted" && /1 conversation/.test(e.summary)));
});

test("delete needs admin sign-in", async () => {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "on" });
  const r = await call(app, "POST", "/api/admin/conversations/delete", { ids: [], confirm: "DELETE" });
  assert.equal(r.status, 401);
});
