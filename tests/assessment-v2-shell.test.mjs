// Vision Assessment v2, phase 1: ending early, going back, skipping a test,
// and settings changed from the menu or by voice — all kept for staff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call } from "./helpers.mjs";
import * as check from "../server/lib/screen-check.mjs";

async function appOn() {
  const app = await makeApp();
  assert.equal((await call(app, "PUT", "/api/admin/settings", { features: { screenCheck: true } })).status, 200);
  return app;
}
const bearer = (t) => ({ authorization: "Bearer " + t });
async function start(app) {
  const s = await call(app, "POST", "/api/check/start", { device: { type: "computer", os: "windows" } });
  assert.equal(s.status, 200);
  return { ...s.json, h: bearer(s.json.token) };
}
async function finishRate(app, s) {
  let r = await call(app, "POST", `/api/check/${s.id}/step`, { setting: "speech_rate" }, s.h);
  while (!r.json.done) r = await call(app, "POST", `/api/check/${s.id}/trial`, { setting: "speech_rate", trial: { answer: "keep" } }, s.h);
  return r;
}

test("off: the new routes answer nothing", async () => {
  const app = await makeApp();
  const id = "00000000-0000-4000-8000-000000000000";
  for (const sub of ["end", "back", "skip", "setting"]) assert.equal((await call(app, "POST", `/api/check/${id}/${sub}`, {})).status, 404, sub);
});

test("End and save: what's done is kept, the rest is listed as not reached, and nothing more can change", async () => {
  const app = await appOn();
  const s = await start(app);
  await finishRate(app, s);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/end`, {}, bearer("wrong"))).status, 404, "needs the check's own token");
  const e = await call(app, "POST", `/api/check/${s.id}/end`, { at: "magnification" }, s.h);
  assert.equal(e.status, 200);
  assert.equal(e.json.check.status, "ended");
  assert.equal(e.json.check.state, "ended");
  assert.equal(e.json.check.stopped_at, "magnification");
  assert.equal(e.json.check.steps.find((x) => x.setting === "speech_rate").done, true);
  for (const [sub, body] of [["end", {}], ["finish", { consent: false }], ["details", { goal: "x" }], ["skip", { setting: "bold" }], ["back", { setting: "speech_rate" }], ["setting", { setting: "theme", value: "blue" }]]) {
    assert.equal((await call(app, "POST", `/api/check/${s.id}/${sub}`, body, s.h)).status, 409, sub);
  }
  assert.equal((await call(app, "POST", `/api/check/${s.id}/trial`, { setting: "bold", trial: { answer: "left" } }, s.h)).status, 409);

  const list = await call(app, "GET", "/api/admin/checks?filter=ended");
  assert.equal(list.json.checks.length, 1);
  assert.equal(list.json.counts.ended, 1);
  const review = await call(app, "GET", "/api/admin/checks?filter=needs_review");
  assert.equal(review.json.checks.length, 1, "an ended check goes to staff for review");
  const d = await call(app, "GET", `/api/admin/checks/${s.id}`);
  assert.equal(d.json.check.state_words, "Ended early");
  assert.ok(d.json.check.not_reached.includes("Text size"));
  assert.match(d.json.case_note, /Status: ended early \(stopped at text size\)/);
  assert.match(d.json.case_note, /Not reached: text size/);
});

test("Go back clears one test so it runs again; others are untouched", async () => {
  const app = await appOn();
  const s = await start(app);
  await finishRate(app, s);
  let r = await call(app, "POST", `/api/check/${s.id}/step`, { setting: "magnification" }, s.h);
  r = await call(app, "POST", `/api/check/${s.id}/trial`, { setting: "magnification", trial: { answer: r.json.prompt.word } }, s.h);
  const back = await call(app, "POST", `/api/check/${s.id}/back`, { setting: "speech_rate" }, s.h);
  assert.equal(back.status, 200);
  assert.equal(back.json.check.steps.find((x) => x.setting === "speech_rate").done, false);
  const again = await call(app, "POST", `/api/check/${s.id}/step`, { setting: "speech_rate" }, s.h);
  assert.equal(again.json.done, false, "the speed test starts again");
  assert.equal(again.json.prompt.rate, "0.7", "from the slowest speed");
  const mag = await call(app, "POST", `/api/check/${s.id}/step`, { setting: "magnification" }, s.h);
  assert.equal(mag.json.prompt.n, 2, "the reading test kept its first answer");
  assert.equal((await call(app, "POST", `/api/check/${s.id}/back`, { setting: "nope" }, s.h)).status, 400);
});

test("Skip marks a test skipped, and it stays done", async () => {
  const app = await appOn();
  const s = await start(app);
  const k = await call(app, "POST", `/api/check/${s.id}/skip`, { setting: "cursor" }, s.h);
  assert.equal(k.status, 200);
  assert.equal(k.json.result.recommended_value, "skipped");
  assert.equal(k.json.result.summary, "Pointer: skipped");
  const st = await call(app, "POST", `/api/check/${s.id}/step`, { setting: "cursor" }, s.h);
  assert.equal(st.json.done, true);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/trial`, { setting: "cursor", trial: { answer: "found" } }, s.h)).status, 409);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/skip`, { setting: "cursor" }, s.h)).status, 409);
  await finishRate(app, s);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/skip`, { setting: "speech_rate" }, s.h)).status, 409, "a finished test can't be skipped");
});

test("Settings changed from the menu or by voice are checked and kept, up to 200", async () => {
  const app = await appOn();
  const s = await start(app);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/setting`, { setting: "theme", value: "purple" }, s.h)).status, 400);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/setting`, { setting: "fontFamily", value: "x" }, s.h)).status, 400);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/setting`, { setting: "theme", value: "blue", via: "voice", step: "contrast" }, s.h)).json.kept, true);
  assert.equal((await call(app, "POST", `/api/check/${s.id}/setting`, { setting: "textSize", value: "300", via: "menu" }, s.h)).json.kept, true);
  const d = await call(app, "GET", `/api/admin/checks/${s.id}`);
  assert.deepEqual(d.json.check.change_words, ["colors → white on dark blue (by voice, during colors)", "text size → 300% (from the menu)"]);
  assert.match(d.json.case_note, /Changed by the person outside the tests:\n- colors → white on dark blue/);
  for (let i = 0; i < 205; i++) await call(app, "POST", `/api/check/${s.id}/setting`, { setting: "bold", value: i % 2 ? "on" : "off" }, s.h);
  const d2 = await call(app, "GET", `/api/admin/checks/${s.id}`);
  assert.equal(d2.json.check.setting_changes.length, 200);
});

test("Left without ending is worked out from two hours with no activity", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(check.checkState({ status: "started", updated_at: "2026-11-09T11:00:00Z" }, now), "in_progress");
  assert.equal(check.checkState({ status: "started", updated_at: "2026-11-09T09:30:00Z" }, now), "left");
  assert.equal(check.checkState({ status: "ended" }, now), "ended");
  assert.equal(check.checkState({ status: "finished" }, now), "finished");
});

test("a test left halfway reads as started, not finished", () => {
  assert.equal(check.describe("contrast", { trials: [{ answer: "left" }], recommended_value: null }), "Colors: started, not finished");
});
