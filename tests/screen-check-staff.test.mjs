// Screen checks, staff side: the list and its filters, one result, the
// review and case note, retake history, delete with DELETE, and sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call } from "./helpers.mjs";
import { createSupabaseCheckStore } from "../server/lib/screen-check-store.mjs";

const bearer = (t) => ({ authorization: "Bearer " + t });
async function appOn(env) {
  const app = await makeApp(env);
  await call(app, "PUT", "/api/admin/settings", { features: { screenCheck: true } });
  return app;
}
// Takes a full check; `see` is the smallest word size (px) the person reads.
async function takeCheck(app, { see = 24, code, contact = true } = {}) {
  const s = (await call(app, "POST", "/api/check/start", { device: { type: "computer", os: "windows", screenW: 1920, screenH: 1080 }, code })).json;
  for (const setting of s.plan) {
    let r = await call(app, "POST", `/api/check/${s.id}/step`, { setting }, bearer(s.token));
    while (!r.json.done) {
      const p = r.json.prompt;
      const trial = setting === "speech_rate" ? { answer: "keep" } : setting === "magnification" ? (p.px >= see ? { answer: p.word } : { cant_tell: true }) : setting === "cursor" ? (p.kind === "find_pointer" ? { answer: p.size === "xl" ? "found" : "lost" } : { answer: "left" }) : { answer: "left" };
      r = await call(app, "POST", `/api/check/${s.id}/trial`, { setting, trial }, bearer(s.token));
    }
  }
  await call(app, "POST", `/api/check/${s.id}/details`, { goal: "Read the news" }, bearer(s.token));
  await call(app, "POST", `/api/check/${s.id}/finish`, contact ? { consent: true, wants_call: true, contact: { first_name: "Pat", phone: "704-555-0100" } } : { consent: false }, bearer(s.token));
  return s;
}

test("staff list: filters, counts, and nothing private in the list", async () => {
  const app = await appOn();
  const a = await takeCheck(app, { see: 72 });            // needs very large text: attention
  await takeCheck(app, { see: 14, contact: false });
  const unfinished = (await call(app, "POST", "/api/check/start", { device: { type: "phone", os: "ios" } })).json;
  let r = await call(app, "GET", "/api/admin/checks");
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 3);
  assert.equal(r.json.counts.needs_review, 2);
  assert.equal(r.json.counts.unfinished, 1);
  assert.equal(r.json.counts.call, 1);
  assert.ok(!JSON.stringify(r.json).includes("704-555"), "no phone numbers in the list");
  assert.ok(!JSON.stringify(r.json).includes("token"), "no tokens in the list");
  r = await call(app, "GET", "/api/admin/checks?filter=low");
  assert.deepEqual(r.json.checks.map((c) => c.id), [a.id]);
  r = await call(app, "GET", "/api/admin/checks?filter=unfinished");
  assert.deepEqual(r.json.checks.map((c) => c.id), [unfinished.id]);
  r = await call(app, "GET", "/api/admin/checks?filter=call");
  assert.equal(r.json.checks.length, 1);
});

test("one result: details, review with accept/edit/reject, case note", async () => {
  const app = await appOn();
  const s = await takeCheck(app, { see: 24 });
  let r = await call(app, "GET", `/api/admin/checks/${s.id}`);
  assert.equal(r.status, 200);
  assert.ok(!("token_hash" in r.json.check));
  assert.equal(r.json.check.contact.phone, "704-555-0100", "staff see contact given with permission");
  assert.deepEqual(r.json.steps.map((x) => x.setting), ["speech_rate", "magnification", "contrast", "cursor", "bold"]);
  assert.match(r.json.case_note, /not reviewed yet/);
  assert.match(r.json.case_note, /Goal: Read the news/);
  assert.match(r.json.case_note, /Windows computer, screen 1920×1080/);
  const bad = await call(app, "POST", `/api/admin/checks/${s.id}/review`, { decisions: { contrast: { decision: "edit" } } });
  assert.equal(bad.status, 400, "an edit needs a new value");
  const nope = await call(app, "POST", `/api/admin/checks/${s.id}/review`, { decisions: { contrast: { decision: "maybe" } } });
  assert.equal(nope.status, 400);
  r = await call(app, "POST", `/api/admin/checks/${s.id}/review`, {
    decisions: { magnification: { decision: "accept" }, contrast: { decision: "edit", value: "Dark, light text on black" }, bold: { decision: "reject" } },
    next_steps: "Bring to Lion's Den for ZoomText at 2x", notes: "Prefers mornings", review_ms: 240000,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.staff_status, "reviewed");
  assert.match(r.json.case_note, /Text size 200%.* — accepted/);
  assert.match(r.json.case_note, /changed to: Dark, light text on black/);
  assert.match(r.json.case_note, /Text weight: regular — not recommended/);
  assert.match(r.json.case_note, /Next steps: Bring to Lion's Den/);
  assert.match(r.json.case_note, /reviewed by admin/);
  assert.match(r.json.case_note, /asked for a call/);
  r = await call(app, "GET", `/api/admin/checks/${s.id}`);
  assert.equal(r.json.reviews.length, 1);
  assert.equal(r.json.reviews[0].review_ms, 240000);
  assert.equal((await call(app, "GET", "/api/admin/checks?filter=needs_review")).json.checks.length, 0);
});

test("a retake shows the earlier check beside it", async () => {
  const app = await appOn();
  const first = await takeCheck(app, { see: 14 });
  const second = await takeCheck(app, { see: 34, code: first.code });
  const r = await call(app, "GET", `/api/admin/checks/${second.id}`);
  assert.equal(r.json.check.previous_check_id, first.id);
  assert.equal(r.json.history.length, 1);
  assert.equal(r.json.history[0].id, first.id);
  assert.equal((await call(app, "GET", "/api/admin/checks?filter=retakes")).json.checks.length, 1);
  const other = await takeCheck(app, { see: 20 });
  const o = await call(app, "GET", `/api/admin/checks/${other.id}`);
  assert.equal(o.json.history.length, 0, "a different person's checks never show as history");
  assert.equal((await call(app, "GET", `/api/admin/checks/${"-".repeat(36)}`)).status, 404);
});

test("delete needs DELETE, same-site, and removes everything", async () => {
  const app = await appOn();
  const s = await takeCheck(app);
  assert.equal((await call(app, "POST", "/api/admin/checks/delete", { ids: [s.id], confirm: "delete" })).status, 400);
  assert.equal((await call(app, "POST", "/api/admin/checks/delete", { ids: [s.id], confirm: "DELETE" }, { origin: "https://evil.example" })).status, 403);
  const r = await call(app, "POST", "/api/admin/checks/delete", { ids: [s.id], confirm: "DELETE" });
  assert.equal(r.json.deleted, 1);
  assert.equal((await call(app, "GET", `/api/admin/checks/${s.id}`)).status, 404);
  assert.equal((await call(app, "GET", `/api/check/${s.id}`, undefined, bearer(s.token))).status, 404, "the person's own link stops working too");
});

test("staff routes need sign-in", async () => {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "on", V360_ADMIN_PASSWORD_HASH: "scrypt$x$y" });
  for (const [m, u] of [["GET", "/api/admin/checks"], ["GET", "/api/admin/checks/00000000-0000-0000-0000-000000000000"], ["POST", "/api/admin/checks/delete"]]) {
    const r = await call(app, m, u, m === "POST" ? { ids: [], confirm: "DELETE" } : undefined);
    assert.equal(r.status, 401, u);
  }
});

test("the Supabase store sends the right requests", async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, method: init.method, prefer: init.headers.Prefer, body: init.body && JSON.parse(init.body) }); return new Response(JSON.stringify([{ id: "x" }]), { status: 200 }); };
  const S = createSupabaseCheckStore({ V360_SUPABASE_URL: "https://p.supabase.co", V360_SUPABASE_SERVICE_KEY: "sb_secret_x" }, fake);
  await S.putStep("11111111-1111-1111-1111-111111111111", "contrast", { trials: [], tries: 1, junk: "dropped" });
  assert.match(calls[0].url, /\/rest\/v1\/screen_check_steps\?on_conflict=check_id,setting$/);
  assert.match(calls[0].prefer, /resolution=merge-duplicates/);
  assert.ok(!("junk" in calls[0].body));
  await S.remove(["11111111-1111-1111-1111-111111111111"]);
  assert.equal(calls[1].method, "DELETE");
  assert.match(calls[1].url, /screen_checks\?id=in\.\(11111111-1111-1111-1111-111111111111\)/);
  await S.listChecks();
  assert.match(calls[2].url, /select=\*,steps:screen_check_steps\(/);
});
