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
  assert.deepEqual({ ...D.normalize(null, { textSize: "150", theme: "high" }) }, { textSize: "150", theme: "high", cursor: "default", cursorColor: "black", bold: "off", highlight: "off" });
  assert.deepEqual({ ...D.normalize(null, { textSize: "100", theme: "standard" }) }, { textSize: "100", theme: "standard", cursor: "default", cursorColor: "black", bold: "off", highlight: "off" });
  const chosen = store({ "v360-display": JSON.stringify({ textSize: "200", theme: "dark", cursor: "xl", cursorColor: "yellow", bold: "on" }) });
  assert.deepEqual({ ...D.normalize(D.saved(chosen), { textSize: "100", theme: "standard" }) }, { textSize: "200", theme: "dark", cursor: "xl", cursorColor: "yellow", bold: "on", highlight: "off" });
});

test("display settings: each page carries over only its own older saved choice, once", () => {
  const D = displayCore();
  const assistant = store({ "v360-demo-settings": JSON.stringify({ textSize: "125", theme: "dark", rate: "1" }) });
  assert.deepEqual({ ...D.saved(assistant, "assistant") }, { textSize: "125", theme: "dark" });
  assert.equal(D.read(assistant, "assistant").migrated, true, "copied to the shared key on first load");
  assert.equal(D.saved(assistant, "directory"), null, "the directory ignores the assistant's old key (it used to save defaults on every visit)");
  const directory = store({ "vrd-display-v1": JSON.stringify({ textsize: "125", contrast: "normal" }) });
  assert.deepEqual({ ...D.saved(directory, "directory") }, { textSize: "125", theme: "standard" });
  // Someone who set the directory to 125% normal and once opened the assistant
  // (which stored 150/high) keeps 125% normal on the directory.
  const both = store({ "v360-demo-settings": JSON.stringify({ textSize: "150", theme: "high" }), "vrd-display-v1": JSON.stringify({ textsize: "125" }) });
  assert.equal(D.saved(both, "directory").textSize, "125");
  // Assistant settings without text size or colors (as the assistant now saves them) are not a choice.
  assert.equal(D.saved(store({ "v360-demo-settings": JSON.stringify({ rate: "1", readAloud: true }) }), "assistant"), null);
  const shared = store({ "v360-display": JSON.stringify({ textSize: "100" }), "v360-demo-settings": JSON.stringify({ textSize: "200" }) });
  assert.equal(D.saved(shared, "assistant").textSize, "100", "the shared setting wins once it exists");
  assert.equal(D.read(shared, "assistant").migrated, false);
});

test("display settings: bad values fall back, and every page gets the right attributes", () => {
  const D = displayCore();
  const s = D.normalize({ textSize: "999", theme: "neon", cursor: "giant", cursorColor: "purple", bold: "very" }, { textSize: "150", theme: "high" });
  assert.deepEqual({ ...s }, { textSize: "150", theme: "high", cursor: "default", cursorColor: "black", bold: "off", highlight: "off" });
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

test("before it's live, signed-in staff can try the full-screen test; the public still can't", async () => {
  const dev = { device: { type: "computer", os: "mac" } };
  const PREVIEW = { "x-v360-preview": "1" };
  // Sign-in required (the hosted site): the preview header alone opens nothing.
  const locked = await makeApp({ V360_ADMIN_SIGNIN: "on" });
  assert.equal((await call(locked, "POST", "/api/check/start", dev)).status, 404);
  assert.equal((await call(locked, "POST", "/api/check/start", dev, PREVIEW)).status, 404);
  // Staff (open admin on a local machine) can try it with the preview header.
  const app = await makeApp();
  assert.equal((await call(app, "POST", "/api/check/start", dev)).status, 404, "no header, no test");
  const s = await call(app, "POST", "/api/check/start", dev, PREVIEW);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  // Making it live on the Workflows page opens it for everyone.
  await call(app, "PUT", "/api/admin/settings", { assessment: "live-test" });
  assert.equal((await call(app, "POST", "/api/check/start", dev)).status, 200);
});

test("display settings: blue (white on dark blue) and 300% are real choices everywhere", () => {
  const D = displayCore();
  assert.deepEqual({ ...D.normalize({ textSize: "300", theme: "blue" }, { textSize: "100", theme: "standard" }) }, { textSize: "300", theme: "blue", cursor: "default", cursorColor: "black", bold: "off", highlight: "off" });
  assert.equal(D.attributes({ ...D.normalize({ theme: "blue" }), theme: "blue" })["data-contrast"], "normal");
  assert.equal(D.normalize({ textSize: "75" }).textSize, "100", "75% is only a sample size in the test, never a page setting");
  assert.deepEqual({ ...D.normalize({ textSize: "400", cursor: "xxl", cursorColor: "pink" }) }, { textSize: "400", theme: "standard", cursor: "xxl", cursorColor: "pink", bold: "off", highlight: "off" });
  assert.deepEqual({ ...D.CURSOR_PX }, { large: 64, xl: 96, xxl: 128 }, "128px is the largest pointer browsers allow");
  const css = D.cursorCss();
  assert.ok(css.includes("html .cursor-try[data-size='xxl'][data-color='pink']"), "pointer test tiles get their own pointer");
  for (const file of ["site/demo/demo.css", "site/styles.css"]) assert.match(readFileSync(new URL("../" + file, import.meta.url), "utf8"), /html\[data-textsize="400"\]/, file);
  for (const [file, re] of [["site/demo/demo.css", /html\[data-theme="blue"\]/], ["site/demo/demo.css", /html\[data-textsize="300"\]/], ["site/styles.css", /html\[data-theme="blue"\]/], ["site/styles.css", /html\[data-textsize="300"\]/], ["site/screen-check/check.css", /\.theme-blue/]]) {
    assert.match(readFileSync(new URL("../" + file, import.meta.url), "utf8"), re, file);
  }
});
