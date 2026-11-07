// OAuth sign-in for the Vision 360 connector: discovery, registration, the
// approval page (admin password or admin session), PKCE code exchange,
// refresh, using the token on /api/mcp, and sign-out by password change.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { makeApp, call } from "./helpers.mjs";

const PW = "test-admin-pass-1";
const ORIGIN = "http://localhost:8360";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const JSONH = { "content-type": "application/json" };

// A request with a raw (form-encoded) body, like a browser form or an OAuth client.
function form(app, url, fields, headers = {}) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(new URLSearchParams(fields).toString())]);
    req.method = "POST"; req.url = url;
    req.headers = { host: "localhost:8360", "content-type": "application/x-www-form-urlencoded", ...headers };
    req.socket = { remoteAddress: "test-" + Math.random() };
    const res = {
      status: 0, headers: {}, body: "",
      writeHead(s, h) { this.status = s; this.headers = h || {}; },
      end(b) {
        const isJson = String((this.headers || {})["Content-Type"] || "").includes("json");
        this.body = b ? String(b) : "";
        resolve({ status: this.status, headers: this.headers, json: isJson && this.body ? JSON.parse(this.body) : null, raw: this.body });
      },
    };
    app.handle(req, res);
  });
}

async function setup(env = {}) {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "on", V360_MCP_KEY: "secret-123", ...env });
  await app.ctx.settings.setPassword(PW);
  return app;
}

const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(app) {
  const r = await call(app, "POST", "/oauth/register", { redirect_uris: [REDIRECT], client_name: "Claude" }, JSONH);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.client_id;
}

async function approvalFor(app, clientId, challenge, headers = {}) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: ORIGIN + "/api/mcp", scope: "vision360" });
  const r = await call(app, "GET", "/oauth/authorize?" + q, undefined, headers);
  assert.equal(r.status, 200, String(r.raw).slice(0, 200));
  const m = String(r.raw).match(/name="approval" value="([^"]+)"/);
  assert.ok(m, "approval page has a signed approval field");
  return { page: String(r.raw), approval: m[1].replace(/&amp;/g, "&") };
}

async function signIn(app) {
  const { verifier, challenge } = pkce();
  const clientId = await register(app);
  const { approval } = await approvalFor(app, clientId, challenge);
  const ok = await form(app, "/oauth/authorize", { approval, decision: "allow", password: PW }, { origin: ORIGIN });
  assert.equal(ok.status, 302);
  const code = new URL(ok.headers.Location).searchParams.get("code");
  const t = await form(app, "/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  return { clientId, tokens: t.json };
}

const listTools = (app, headers = {}, path = "/api/mcp") => call(app, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, headers);

test("discovery: the connector says where to sign in", async () => {
  const app = await setup();
  const pr = await call(app, "GET", "/.well-known/oauth-protected-resource");
  assert.equal(pr.status, 200);
  assert.equal(pr.json.resource, ORIGIN + "/api/mcp");
  assert.deepEqual(pr.json.authorization_servers, [ORIGIN]);
  const as = await call(app, "GET", "/.well-known/oauth-authorization-server");
  assert.equal(as.json.token_endpoint, ORIGIN + "/oauth/token");
  assert.deepEqual(as.json.code_challenge_methods_supported, ["S256"]);
  // A refused connector request points Claude at the sign-in.
  const r = await listTools(app);
  assert.equal(r.status, 401);
  assert.match(r.headers["WWW-Authenticate"], /resource_metadata="http:\/\/localhost:8360\/\.well-known\/oauth-protected-resource"/);
});

test("full sign-in: register, approve with the admin password, exchange the code, use the token", async () => {
  const app = await setup();
  const { tokens } = await signIn(app);
  assert.equal(tokens.token_type, "Bearer");
  const r = await listTools(app, { authorization: "Bearer " + tokens.access_token });
  assert.equal(r.status, 200);
  assert.ok(r.json.result.tools.length > 10);
  // The old key still works alongside OAuth.
  assert.equal((await listTools(app, {}, "/api/mcp?key=secret-123")).status, 200);
});

test("refresh gives a new working access token", async () => {
  const app = await setup();
  const { clientId, tokens } = await signIn(app);
  const t = await form(app, "/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(t.status, 200);
  assert.equal((await listTools(app, { authorization: "Bearer " + t.json.access_token })).status, 200);
  const bad = await form(app, "/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.access_token });
  assert.equal(bad.status, 400, "an access token is not a refresh token");
});

test("wrong password, wrong PKCE verifier, tampered and foreign tokens are refused", async () => {
  const app = await setup();
  const { verifier, challenge } = pkce();
  const clientId = await register(app);
  const { approval } = await approvalFor(app, clientId, challenge);
  const wrong = await form(app, "/oauth/authorize", { approval, decision: "allow", password: "nope" }, { origin: ORIGIN });
  assert.equal(wrong.status, 401);
  assert.match(String(wrong.raw), /password isn(&#39;|')t right/);
  const ok = await form(app, "/oauth/authorize", { approval, decision: "allow", password: PW }, { origin: ORIGIN });
  const code = new URL(ok.headers.Location).searchParams.get("code");
  const badPkce = await form(app, "/oauth/token", { grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: clientId });
  assert.equal(badPkce.status, 400);
  assert.equal(badPkce.json.error, "invalid_grant");
  const good = await form(app, "/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId });
  const access = good.json.access_token;
  const tampered = access.slice(0, -2) + (access.endsWith("AA") ? "BB" : "AA");
  assert.equal((await listTools(app, { authorization: "Bearer " + tampered })).status, 401);
  // A token from this site is not accepted by another Vision 360 site (different admin password).
  const otherApp = await makeApp({ V360_ADMIN_SIGNIN: "on", V360_MCP_KEY: "secret-123" });
  await otherApp.ctx.settings.setPassword("another-site-password");
  assert.equal((await listTools(otherApp, { authorization: "Bearer " + access })).status, 401);
});

test("deny sends the app back with access_denied and no code", async () => {
  const app = await setup();
  const clientId = await register(app);
  const { approval } = await approvalFor(app, clientId, pkce().challenge);
  const r = await form(app, "/oauth/authorize", { approval, decision: "deny" }, { origin: ORIGIN });
  assert.equal(r.status, 302);
  const back = new URL(r.headers.Location);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "xyz");
  assert.equal(back.searchParams.get("code"), null);
});

test("someone already signed in to the admin just clicks Allow", async () => {
  const app = await setup();
  const login = await call(app, "POST", "/api/admin/login", { password: PW });
  assert.equal(login.status, 200);
  const cookie = String(login.headers["Set-Cookie"]).split(";")[0];
  const clientId = await register(app);
  const { page, approval } = await approvalFor(app, clientId, pkce().challenge, { cookie });
  assert.match(page, /signed in to the Vision 360 admin/);
  assert.match(page, /go back to <strong>claude\.ai<\/strong>/, "the page shows where it returns to");
  assert.doesNotMatch(page, /type="password"/);
  const r = await form(app, "/oauth/authorize", { approval, decision: "allow" }, { origin: ORIGIN, cookie });
  assert.equal(r.status, 302);
  assert.ok(new URL(r.headers.Location).searchParams.get("code"));
});

test("registration only accepts https or localhost return addresses, and authorize checks them", async () => {
  const app = await setup();
  for (const bad of ["javascript:alert(1)", "http://evil.example/cb", "https://ok.example/cb#frag"]) {
    const r = await call(app, "POST", "/oauth/register", { redirect_uris: [bad] }, JSONH);
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await call(app, "POST", "/oauth/register", { redirect_uris: ["http://localhost:33418/callback"] }, JSONH)).status, 201);
  const clientId = await register(app);
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" });
  const r = await call(app, "GET", "/oauth/authorize?" + q);
  assert.equal(r.status, 400, "a return address the app didn't register is refused, never redirected to");
  const noPkce = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT });
  const r2 = await call(app, "GET", "/oauth/authorize?" + noPkce);
  assert.equal(r2.status, 302);
  assert.equal(new URL(r2.headers.Location).searchParams.get("error"), "invalid_request");
});

test("changing the admin password signs every connected app out", async () => {
  const app = await setup();
  const { tokens } = await signIn(app);
  assert.equal((await listTools(app, { authorization: "Bearer " + tokens.access_token })).status, 200);
  await app.ctx.settings.setPassword("a-brand-new-password");
  assert.equal((await listTools(app, { authorization: "Bearer " + tokens.access_token })).status, 401);
  const t = await form(app, "/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(t.status, 400);
});

test("without an admin password there is no sign-in, and a missing key is a plain 403", async () => {
  const app = await makeApp({ V360_ADMIN_SIGNIN: "on", V360_MCP_KEY: "secret-123" });
  assert.equal((await call(app, "GET", "/.well-known/oauth-protected-resource")).status, 404);
  assert.equal((await listTools(app)).status, 403);
});
