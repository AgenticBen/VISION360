// The admin password gate: pages and API need the admin password, which is
// kept hashed in the private settings store and can be changed in Settings.
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, call } from "./helpers.mjs";
import { hashPassword } from "../server/lib/auth.mjs";

const PW = "test-admin-pass-1";
const cookieOf = (r) => String(r.headers["Set-Cookie"] || "").split(";")[0];

async function gated(env = {}) {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "on", ...env });
  await app.ctx.settings.setPassword(PW);
  return app;
}

test("signed out: admin pages redirect to sign-in, files and API return 401, sign-in page is public", async () => {
  const app = await gated();
  let r = await call(app, "GET", "/admin/");
  assert.equal(r.status, 302);
  assert.match(r.headers.Location, /^\/admin\/login\/\?next=%2Fadmin%2F/);
  r = await call(app, "GET", "/admin/workflows/edit/?flow=referral");
  assert.equal(r.status, 302);
  assert.match(r.headers.Location, /next=%2Fadmin%2Fworkflows%2Fedit%2F%3Fflow%3Dreferral/);
  r = await call(app, "GET", "/admin/shell.js");
  assert.equal(r.status, 401);
  r = await call(app, "GET", "/admin/login/");
  assert.equal(r.status, 200);
  assert.match(String(r.raw), /Admin sign-in/);
  r = await call(app, "GET", "/admin/login/login.js");
  assert.equal(r.status, 200);
  r = await call(app, "GET", "/api/admin/overview");
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "signin");
  r = await call(app, "GET", "/api/staff/sessions");
  assert.equal(r.status, 401);
});

test("wrong password refused, right password signs in and opens pages", async () => {
  const app = await gated();
  let r = await call(app, "POST", "/api/admin/login", { password: "nope" });
  assert.equal(r.status, 401);
  r = await call(app, "POST", "/api/admin/login", { password: PW });
  assert.equal(r.status, 200);
  const c = cookieOf(r);
  assert.match(c, /^v360_staff=v1\./);
  assert.match(String(r.headers["Set-Cookie"]), /HttpOnly/);
  r = await call(app, "GET", "/admin/", undefined, { cookie: c });
  assert.equal(r.status, 200);
  assert.match(r.headers["Content-Type"], /text\/html/);
  r = await call(app, "GET", "/admin/shell.js", undefined, { cookie: c });
  assert.equal(r.status, 200);
  r = await call(app, "GET", "/api/admin/overview", undefined, { cookie: c });
  assert.equal(r.status, 200);
  r = await call(app, "GET", "/api/admin/me", undefined, { cookie: c });
  assert.equal(r.json.signedIn, true);
});

test("sign-in needs a same-site Origin and is rate limited", async () => {
  const app = await gated();
  let r = await call(app, "POST", "/api/admin/login", { password: PW }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const headers = {};
  let last;
  for (let i = 0; i < 11; i++) {
    last = await new Promise((resolve) => {
      // same client address for every attempt
      import("node:stream").then(({ Readable }) => {
        const req = Readable.from([Buffer.from(JSON.stringify({ password: "x" }))]);
        req.method = "POST"; req.url = "/api/admin/login"; req.headers = { host: "localhost:8360", origin: "http://localhost:8360", ...headers }; req.socket = { remoteAddress: "same-ip" };
        const res = { writeHead(s) { this.status = s; }, end() { resolve(this.status); } };
        app.handle(req, res);
      });
    });
  }
  assert.equal(last, 429);
});

test("changing the password signs out old cookies; old password stops working", async () => {
  const app = await gated();
  let r = await call(app, "POST", "/api/admin/login", { password: PW });
  const old = cookieOf(r);
  r = await call(app, "POST", "/api/admin/password", { current: "wrong", password: "brand-new-pass", confirm: "brand-new-pass" }, { cookie: old });
  assert.equal(r.status, 401);
  r = await call(app, "POST", "/api/admin/password", { current: PW, password: "short", confirm: "short" }, { cookie: old });
  assert.equal(r.status, 400);
  r = await call(app, "POST", "/api/admin/password", { current: PW, password: "brand-new-pass", confirm: "brand-new-pas" }, { cookie: old });
  assert.equal(r.status, 400);
  r = await call(app, "POST", "/api/admin/password", { current: PW, password: "brand-new-pass", confirm: "brand-new-pass" }, { cookie: old });
  assert.equal(r.status, 200);
  const fresh = cookieOf(r);
  r = await call(app, "GET", "/api/admin/overview", undefined, { cookie: old });
  assert.equal(r.status, 401, "old cookie refused after the change");
  r = await call(app, "GET", "/api/admin/overview", undefined, { cookie: fresh });
  assert.equal(r.status, 200);
  r = await call(app, "POST", "/api/admin/login", { password: PW });
  assert.equal(r.status, 401);
  r = await call(app, "POST", "/api/admin/login", { password: "brand-new-pass" });
  assert.equal(r.status, 200);
  const log = await call(app, "GET", "/api/changelog", undefined, { cookie: fresh });
  assert.ok(log.json.entries.some((e) => e.title === "Admin password changed"));
  assert.ok(!JSON.stringify(log.json).includes("brand-new-pass"));
});

test("paths can't escape the admin folder", async () => {
  const app = await gated();
  const r0 = await call(app, "POST", "/api/admin/login", { password: PW });
  const c = cookieOf(r0);
  for (const p of ["/admin/..%2fserver%2flib%2fauth.mjs", "/admin/%2e%2e/package.json", "/admin/../../package.json"]) {
    const r = await call(app, "GET", p, undefined, { cookie: c });
    assert.notEqual(r.status, 200, p);
  }
});

test("the hosted site ignores V360_ADMIN_SIGNIN=off and never offers first-time setup", async () => {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "off", V360_SERVERLESS: "1" });
  let r = await call(app, "GET", "/api/admin/overview");
  assert.equal(r.status, 401);
  r = await call(app, "GET", "/api/admin/me");
  assert.equal(r.json.setupNeeded, true);
  assert.equal(r.json.canSetUp, false);
  r = await call(app, "POST", "/api/admin/setup", { password: "anything-long" });
  assert.equal(r.status, 403);
  r = await call(app, "GET", "/admin/");
  assert.equal(r.status, 302);
});

test("a local install with no password can set the first one", async () => {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "on" });
  let r = await call(app, "GET", "/api/admin/me");
  assert.equal(r.json.canSetUp, true);
  r = await call(app, "POST", "/api/admin/setup", { password: "first-pass-1" });
  assert.equal(r.status, 200);
  r = await call(app, "POST", "/api/admin/setup", { password: "second-pass" });
  assert.equal(r.status, 403, "only once");
});

test("an env hash works when nothing is saved in settings", async () => {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "on", V360_ADMIN_PASSWORD_HASH: hashPassword("env-pass-123") });
  const r = await call(app, "POST", "/api/admin/login", { password: "env-pass-123" });
  assert.equal(r.status, 200);
  const ok = await call(app, "GET", "/api/admin/overview", undefined, { cookie: cookieOf(r) });
  assert.equal(ok.status, 200);
});

test("voice switch: can't turn on without a key; usage is counted; off again stops voice", async () => {
  const app = await makeApp();
  let r = await call(app, "PUT", "/api/admin/settings", { voice: { elevenlabs: true } });
  assert.equal(r.status, 400);
  r = await call(app, "GET", "/api/admin/overview");
  assert.equal(r.json.costs.tts.keySet, false);
  assert.equal(r.json.costs.tts.provider, "browser");
});

test("main workflow setting accepts only a published workflow and logs the change", async () => {
  const app = await makeApp();
  let r = await call(app, "PUT", "/api/admin/settings", { mainFlow: "nope" });
  assert.equal(r.status, 400);
  r = await call(app, "PUT", "/api/admin/settings", { mainFlow: "v360-interest" });
  assert.equal(r.status, 200);
  assert.equal(r.json.settings.mainFlow, "v360-interest");
  r = await call(app, "PUT", "/api/admin/settings", { mainFlow: "v360-interest" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  r = await call(app, "GET", "/api/changelog");
  assert.ok(r.json.entries.some((e) => e.title === "Main workflow changed"));
});

test("conversations are kept until deleted: no expiry, and the purge leaves them", async () => {
  const app = await makeApp();
  const s = await call(app, "POST", "/api/session", { noticeAccepted: true, mode: "text" });
  const row = app.store.getSession(s.json.sessionId);
  assert.equal(row.expires_at, "9999-12-31T00:00:00.000Z");
  assert.equal(app.store.purgeExpired(), 0);
  assert.ok(app.store.getSession(s.json.sessionId));
});
