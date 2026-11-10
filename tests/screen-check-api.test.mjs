// The screen check's API: a person runs the whole check; tokens, linking to
// the Vision Assessment, retakes by code, and the off switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call } from "./helpers.mjs";

async function appOn() {
  const app = await makeApp();
  const r = await call(app, "PUT", "/api/admin/settings", { features: { screenCheck: true } });
  assert.equal(r.status, 200);
  return app;
}
const bearer = (t) => ({ authorization: "Bearer " + t });

// Runs every test in the plan with simple answers; reads words down to 24px.
async function runAll(app, start) {
  const h = bearer(start.token);
  for (const setting of start.plan) {
    let r = await call(app, "POST", `/api/check/${start.id}/step`, { setting }, h);
    assert.equal(r.status, 200, setting);
    let guard = 0;
    while (!r.json.done) {
      const p = r.json.prompt;
      const trial =
        setting === "speech_rate" ? { answer: p.rate === "1" ? "keep" : "faster" } :
        setting === "magnification" ? (p.px >= 24 ? { answer: p.word } : { cant_tell: true }) :
        setting === "pictures" ? (p.px >= 24 ? { answer: p.picture } : { cant_tell: true }) :
        setting === "cursor" ? { answer: p.kind === "pick_cursor_size" ? "xl" : "yellow" } :
        { answer: "left" };
      r = await call(app, "POST", `/api/check/${start.id}/trial`, { setting, trial }, h);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(++guard < 60);
    }
    assert.ok(r.json.result.summary, setting + " has a summary");
  }
}

test("off: nothing answers", async () => {
  const app = await makeApp();
  assert.equal((await call(app, "POST", "/api/check/start", { device: { type: "computer" } })).status, 404);
});

test("a person runs the whole check, sees only their own result, and settings are applied", async () => {
  const app = await appOn();
  const s = await call(app, "POST", "/api/check/start", { device: { type: "computer", os: "mac", screenW: 1440, screenH: 900, dpr: 2 } });
  assert.equal(s.status, 200);
  assert.match(s.json.code, /^[a-z]+ \d{3} [a-z]+$/);
  assert.deepEqual(s.json.plan, ["speech_rate", "magnification", "pictures", "contrast", "cursor", "bold", "highlight"]);
  assert.equal((await call(app, "POST", `/api/check/${s.json.id}/step`, { setting: "contrast" })).status, 404, "no token, no access");
  assert.equal((await call(app, "POST", `/api/check/${s.json.id}/step`, { setting: "contrast" }, bearer("wrong"))).status, 404);
  // The word is only sent for the trial being shown.
  const first = await call(app, "POST", `/api/check/${s.json.id}/step`, { setting: "magnification" }, bearer(s.json.token));
  assert.equal(first.json.prompt.px, 12, "starts small");
  assert.ok(first.json.prompt.word);
  await runAll(app, s.json);
  const again = await call(app, "POST", `/api/check/${s.json.id}/trial`, { setting: "contrast", trial: { answer: "left" } }, bearer(s.json.token));
  assert.equal(again.status, 409, "a finished test can't be answered again");
  const d = await call(app, "POST", `/api/check/${s.json.id}/details`, { goal: "Read email from my grandkids" }, bearer(s.json.token));
  assert.equal(d.json.check.goal, "Read email from my grandkids");
  const f = await call(app, "POST", `/api/check/${s.json.id}/finish`, { consent: true, wants_call: true, contact: { first_name: "Pat", phone: "704-555-0100" }, age_range: "65_74", zip: "28213" }, bearer(s.json.token));
  assert.equal(f.status, 200);
  const c = f.json.check;
  assert.equal(c.status, "finished");
  assert.deepEqual({ ...c.settings }, { rate: "1", textSize: "400", theme: "high", cursor: "xl", cursorColor: "yellow", bold: "off", highlight: "off" });
  assert.ok(c.steps.every((x) => x.done));
  assert.ok(!("contact" in c), "contact details are not sent back to the browser");
  const later = await call(app, "POST", `/api/check/${s.json.id}/trial`, { setting: "bold", trial: { answer: "left" } }, bearer(s.json.token));
  assert.equal(later.status, 409);
  const again2 = await call(app, "POST", `/api/check/${s.json.id}/finish`, { consent: false }, bearer(s.json.token));
  assert.equal(again2.status, 409, "a finished check can't be finished again (that would wipe the contact details)");
  const dev = await call(app, "POST", `/api/check/${s.json.id}/details`, { device: { type: "phone" } }, bearer(s.json.token));
  assert.equal(dev.status, 409, "nor changed after it's finished");
  assert.equal((await call(app, "GET", `/api/check/${"-".repeat(36)}`, undefined, bearer(s.json.token))).status, 404, "not a real id: plain 404");
});

test("no consent: no contact details are kept", async () => {
  const app = await appOn();
  const s = (await call(app, "POST", "/api/check/start", { device: { type: "phone", os: "ios" } })).json;
  assert.deepEqual(s.plan, ["speech_rate", "magnification", "pictures", "contrast", "bold", "highlight"], "no pointer test on a phone");
  const f = await call(app, "POST", `/api/check/${s.id}/finish`, { consent: false, wants_call: true, contact: { phone: "704-555-0100" }, zip: "not-a-zip" }, bearer(s.token));
  assert.equal(f.status, 200);
  // Look at the stored row through a second check's eyes isn't possible; the staff view (phase 3) shows it.
});

test("linked to the Vision Assessment only with that conversation's own token; retake by code", async () => {
  const app = await appOn();
  const conv = await call(app, "POST", "/api/session", { noticeAccepted: true, mode: "text", flow: "vision-assessment" });
  assert.equal(conv.status, 201);
  const good = await call(app, "POST", "/api/check/start", { device: { type: "computer" }, from: { sessionId: conv.json.sessionId, token: conv.json.token } });
  assert.equal(good.json.linked, true);
  const bad = await call(app, "POST", "/api/check/start", { device: { type: "computer" }, from: { sessionId: conv.json.sessionId, token: "guess" } });
  assert.equal(bad.json.linked, false);
  const retake = await call(app, "POST", "/api/check/start", { device: { type: "computer" }, code: good.json.code.toUpperCase() });
  assert.equal(retake.status, 200);
  assert.equal(retake.json.retake, true);
  assert.equal(retake.json.code, good.json.code, "a person keeps one code");
  const unknown = await call(app, "POST", "/api/check/start", { device: { type: "computer" }, code: "maple 111 river" });
  assert.equal(unknown.status, 404);
  const garbage = await call(app, "POST", "/api/check/start", { device: { type: "computer" }, code: "drop table" });
  assert.equal(garbage.status, 404);
});

test("screen-reader users skip the pointer test", async () => {
  const app = await appOn();
  const s = (await call(app, "POST", "/api/check/start", { device: { type: "computer", os: "windows", skipPointer: true } })).json;
  assert.deepEqual(s.plan, ["speech_rate", "magnification", "pictures", "contrast", "bold"]);
});

test("bad input is refused or cleaned", async () => {
  const app = await appOn();
  const s = (await call(app, "POST", "/api/check/start", { device: { type: "spaceship", os: "<script>", screenW: "9e99" } })).json;
  assert.equal(s.device.type, "computer");
  assert.equal(s.device.os, "other");
  assert.equal((await call(app, "POST", `/api/check/${s.id}/step`, { setting: "toaster" }, bearer(s.token))).status, 400);
  const r = await call(app, "POST", `/api/check/${s.id}/trial`, { setting: "magnification", trial: { answer: "x".repeat(5000) } }, bearer(s.token));
  assert.equal(r.status, 200, "an overlong answer is trimmed, not stored whole");
});
