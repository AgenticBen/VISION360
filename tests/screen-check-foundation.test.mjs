// Screen Settings Check, Phase 1: the off switch and the shared display
// settings. Nothing about the check is built yet, so everything here proves
// it stays off and invisible, and that display settings carry across pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeApp, call } from "./helpers.mjs";

function displayCore() {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../site/display-settings.js", import.meta.url), "utf8"), ctx);
  return ctx.V360DisplayCore;
}
const store = (map) => (k) => (k in map ? map[k] : null);

test("display settings: page defaults until someone chooses, then their choice everywhere", () => {
  const D = displayCore();
  assert.equal(D.saved(store({})), null, "nothing chosen yet");
  assert.deepEqual({ ...D.normalize(null, { textSize: "150", theme: "high" }) }, { textSize: "150", theme: "high", cursor: "default", cursorColor: "black", bold: "off" });
  assert.deepEqual({ ...D.normalize(null, { textSize: "100", theme: "standard" }) }, { textSize: "100", theme: "standard", cursor: "default", cursorColor: "black", bold: "off" });
  const chosen = store({ "v360-display": JSON.stringify({ textSize: "200", theme: "dark", cursor: "xl", cursorColor: "yellow", bold: "on" }) });
  assert.deepEqual({ ...D.normalize(D.saved(chosen), { textSize: "100", theme: "standard" }) }, { textSize: "200", theme: "dark", cursor: "xl", cursorColor: "yellow", bold: "on" });
});

test("display settings: older saved choices carry over (assistant first, then directory)", () => {
  const D = displayCore();
  const assistant = store({ "v360-demo-settings": JSON.stringify({ textSize: "125", theme: "dark", rate: "1" }) });
  assert.deepEqual({ ...D.saved(assistant) }, { textSize: "125", theme: "dark" });
  const directory = store({ "vrd-display-v1": JSON.stringify({ textsize: "150", contrast: "high" }) });
  assert.deepEqual({ ...D.saved(directory) }, { textSize: "150", theme: "high" });
  const both = store({ "v360-demo-settings": JSON.stringify({ textSize: "125" }), "vrd-display-v1": JSON.stringify({ textsize: "150" }) });
  assert.equal(D.saved(both).textSize, "125");
  const shared = store({ "v360-display": JSON.stringify({ textSize: "100" }), "v360-demo-settings": JSON.stringify({ textSize: "200" }) });
  assert.equal(D.saved(shared).textSize, "100", "the shared setting wins once it exists");
});

test("display settings: bad values fall back, and every page gets the right attributes", () => {
  const D = displayCore();
  const s = D.normalize({ textSize: "999", theme: "neon", cursor: "giant", cursorColor: "pink", bold: "very" }, { textSize: "150", theme: "high" });
  assert.deepEqual({ ...s }, { textSize: "150", theme: "high", cursor: "default", cursorColor: "black", bold: "off" });
  assert.equal(D.attributes({ ...s, theme: "high" })["data-contrast"], "high");
  assert.equal(D.attributes({ ...s, theme: "dark" })["data-contrast"], "normal", "the directory shows dark as normal contrast");
  assert.equal(D.attributes(s)["data-cursor"], "default");
  const css = D.cursorCss();
  for (const size of ["large", "xl"]) for (const color of D.CURSOR_COLORS) assert.ok(css.includes(`html[data-cursor='${size}'][data-cursor-color='${color}']`));
  assert.ok(!css.includes("data-cursor='default'"), "the normal pointer is left alone");
});

test("screen check is off by default and nothing about it answers", async () => {
  const app = await makeApp();
  const site = await call(app, "GET", "/api/site");
  assert.equal(site.status, 200);
  assert.equal(site.json.features.screenCheck, false);
  for (const url of ["/api/check", "/api/check/start", "/api/check/anything"]) {
    const r = await call(app, url.endsWith("start") ? "POST" : "GET", url, url.endsWith("start") ? {} : undefined);
    assert.equal(r.status, 404, url);
  }
  const s = await call(app, "GET", "/api/admin/settings");
  assert.equal(s.json.settings.features.screenCheck, false);
});

test("an admin can switch it on and off (same-site only); it still answers nothing until built", async () => {
  const app = await makeApp();
  const cross = await call(app, "PUT", "/api/admin/settings", { features: { screenCheck: true } }, { origin: "https://evil.example" });
  assert.ok(cross.status === 403 || cross.status === 400, `cross-site change refused (${cross.status})`);
  let r = await call(app, "PUT", "/api/admin/settings", { features: { screenCheck: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.settings.features.screenCheck, true);
  assert.equal((await call(app, "GET", "/api/site")).json.features.screenCheck, true);
  assert.equal((await call(app, "GET", "/api/check/anything")).status, 404, "nothing is built behind it yet");
  r = await call(app, "PUT", "/api/admin/settings", { features: { screenCheck: "yes" } });
  assert.equal(r.json.settings.features.screenCheck, false, "only a real true turns it on");
  r = await call(app, "PUT", "/api/admin/settings", {});
  assert.equal(r.status, 400, "an empty change is refused");
  // The other settings are untouched by the feature switch.
  const s = (await call(app, "GET", "/api/admin/settings")).json.settings;
  assert.equal(s.mainFlow, "referral");
  assert.equal(s.voice.elevenlabs, false);
});
