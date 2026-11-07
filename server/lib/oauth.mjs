// OAuth 2.1 sign-in for the Vision 360 connector (MCP authorization).
//
// Lets Claude (and other MCP clients) connect with a normal "Connect" /
// "Reconnect" sign-in instead of a key pasted into the connector URL. The
// person approves the connection with the admin password (or one click if
// they're already signed in to the admin site).
//
//   GET  /.well-known/oauth-protected-resource[/api/mcp]   where to sign in
//   GET  /.well-known/oauth-authorization-server           endpoints (also /.well-known/openid-configuration)
//   POST /oauth/register     dynamic client registration (RFC 7591), public clients
//   GET  /oauth/authorize    the approval page (PKCE S256 required)
//   POST /oauth/authorize    approve or deny
//   POST /oauth/token        authorization_code (+ PKCE) and refresh_token grants
//
// Stateless: client ids, approval requests, codes and tokens are all signed
// with a key derived from the admin password's own signing secret. Nothing is
// stored, and changing the admin password signs every connected client out.
// The old ?key= / x-v360-key connector key keeps working alongside this.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const ACCESS_SECONDS = 3600;              // 1 hour
const REFRESH_SECONDS = 90 * 24 * 3600;   // 90 days
const CODE_SECONDS = 300;                 // 5 minutes
const APPROVAL_SECONDS = 15 * 60;         // the approval page stays valid 15 minutes
const SCOPE = "vision360";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Redirect URIs must be https, or http on this computer (desktop and dev clients).
function allowedRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
  } catch { return false; }
}

export function createOAuth({ getSecret, checkPassword, isSignedIn, origin, limiter }) {
  async function key() {
    const secret = await getSecret();
    return secret ? createHash("sha256").update("v360-mcp-oauth\n").update(secret).digest() : null;
  }

  async function sign(obj) {
    const k = await key();
    if (!k) throw Object.assign(new Error("Sign-in isn't set up on this site yet (no admin password)."), { status: 503 });
    const body = b64u(JSON.stringify(obj));
    return body + "." + b64u(createHmac("sha256", k).update(body).digest());
  }

  // Returns the payload if the signature is ours, the type matches and it hasn't expired.
  async function open(token, type) {
    const k = await key();
    if (!k || typeof token !== "string" || token.length > 8192) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const want = createHmac("sha256", k).update(body).digest();
    let got;
    try { got = Buffer.from(token.slice(dot + 1), "base64url"); } catch { return null; }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
    if (!p || p.t !== type) return null;
    if (p.exp && p.exp < now()) return null;
    return p;
  }

  const resourceOf = (req) => origin(req) + "/api/mcp";

  function protectedResource(req) {
    return { resource: resourceOf(req), authorization_servers: [origin(req)], bearer_methods_supported: ["header"], scopes_supported: [SCOPE], resource_name: "Vision 360" };
  }

  function serverMetadata(req) {
    const o = origin(req);
    return {
      issuer: o,
      authorization_endpoint: o + "/oauth/authorize",
      token_endpoint: o + "/oauth/token",
      registration_endpoint: o + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
    };
  }

  // The WWW-Authenticate value for a refused connector request.
  const challenge = (req) => `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;

  // Compare resource addresses without query, fragment or trailing slash
  // (a connector URL may still carry an old ?key=).
  const sameResource = (a, b) => { const n = (s) => String(s).split(/[?#]/)[0].replace(/\/+$/, ""); return n(a) === n(b); };

  // A valid access token for this site's connector, or null.
  async function verifyAccess(token, req) {
    const p = await open(token, "access");
    if (!p) return null;
    if (p.res && !sameResource(p.res, resourceOf(req))) return null;
    return p;
  }

  async function available() { return !!(await key()); }

  // ---------------------------------------------------------------- HTTP
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

  function json(res, status, body, extra = {}) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...CORS, ...extra });
    res.end(JSON.stringify(body));
  }

  function page(res, status, html) {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(html);
  }

  function redirect(res, to) {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
    res.end();
  }

  function withParams(uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
    return u.toString();
  }

  async function readBody(req, max = 16 * 1024) {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error("Request too large"), { status: 413 }); chunks.push(c); }
    const text = Buffer.concat(chunks).toString("utf8");
    const type = String(req.headers["content-type"] || "");
    if (type.includes("application/json")) { try { return JSON.parse(text || "{}"); } catch { return {}; } }
    return Object.fromEntries(new URLSearchParams(text));
  }

  function approvalPage({ clientName, approval, signedIn, error, returnTo }) {
    const who = esc(clientName || "An app");
    let host = "";
    try { host = new URL(returnTo).host; } catch {}
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Connect to Vision 360</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:18px;line-height:1.5;color:#16191d;background:#f4f6f8;overflow-wrap:break-word}
  main{max-width:32rem;margin:2rem auto;padding:1.5rem;background:#fff;border:2px solid #1c3879;border-radius:8px}
  h1{font-size:1.5rem;margin:0 0 .5rem;color:#051362} p{margin:.5rem 0}
  label{display:block;font-weight:700;margin-top:1rem} input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;border:2px solid #7f8992;border-radius:6px}
  .row{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}
  button{font:inherit;font-weight:700;min-height:44px;padding:.5rem 1.2rem;border-radius:8px;border:2px solid #1c3879;cursor:pointer}
  .allow{background:#1c3879;color:#fff} .deny{background:#fff;color:#1c3879}
  .err{background:#fdecea;color:#8a1f11;border:1px solid #8a1f11;border-radius:6px;padding:.5rem .75rem}
  :focus-visible{outline:3px solid #1c3879;outline-offset:2px}
  @media (prefers-color-scheme: dark){body{background:#11151b;color:#f1f4f8}main{background:#1a2029;border-color:#9cc1ff}h1{color:#fff}input{background:#11151b;color:#f1f4f8}.deny{background:#1a2029;color:#9cc1ff;border-color:#9cc1ff}.allow{background:#9cc1ff;color:#0b1020;border-color:#9cc1ff}}
</style></head><body><main>
<h1>Connect to Vision 360</h1>
<p><strong>${who}</strong> wants to connect to the Vision 360 admin tools. Once connected it can read and edit workflows and work through requests, as the admin can.</p>
<p>After you choose, you'll go back to <strong>${esc(host)}</strong>. Only allow this if that's the app you're connecting (for Claude: <strong>claude.ai</strong>).</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="approval" value="${esc(approval)}">
  ${signedIn ? `<p>You're signed in to the Vision 360 admin.</p>` : `<label for="password">Admin password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>`}
  <div class="row">
    <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    <button class="deny" type="submit" name="decision" value="deny" formnovalidate>Don't allow</button>
  </div>
</form>
<p style="font-size:.9em;margin-top:1.25rem">Changing the admin password disconnects every app connected this way.</p>
</main></body></html>`;
  }

  function errorPage(res, status, message) {
    page(res, status, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Can't connect to Vision 360</title></head><body style="font-family:sans-serif;font-size:18px;max-width:32rem;margin:2rem auto;padding:0 1rem"><h1>Can't connect</h1><p>${esc(message)}</p></body></html>`);
  }

  // Handles the OAuth routes. Returns true when it answered the request.
  async function handle(req, res, url, ip) {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;
    const isOAuth = p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-") || p === "/.well-known/openid-configuration";
    if (!isOAuth) return false;
    if (method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return true; }

    try {
      if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/api/mcp") {
        if (!(await available())) { json(res, 404, { error: "not_found" }); return true; }
        json(res, 200, protectedResource(req));
        return true;
      }
      if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server/api/mcp" || p === "/.well-known/openid-configuration") {
        if (!(await available())) { json(res, 404, { error: "not_found" }); return true; }
        json(res, 200, serverMetadata(req));
        return true;
      }

      if (p === "/oauth/register" && method === "POST") {
        if (!limiter(ip + ":oauth-register", 20)) { json(res, 429, { error: "slow_down" }); return true; }
        const body = await readBody(req);
        const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
        if (!uris.length || uris.length > 5 || !uris.every(allowedRedirect)) { json(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be 1-5 https (or localhost) addresses." }); return true; }
        const name = String(body.client_name || "An app").slice(0, 80);
        const iat = now();
        const client_id = await sign({ t: "client", r: uris, n: name, iat });
        json(res, 201, { client_id, client_id_issued_at: iat, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: SCOPE });
        return true;
      }

      if (p === "/oauth/authorize" && method === "GET") {
        const q = Object.fromEntries(url.searchParams);
        const client = await open(q.client_id, "client");
        if (!client) { errorPage(res, 400, "This app isn't registered with Vision 360. Remove the connector and add it again."); return true; }
        const redirectUri = q.redirect_uri || (client.r.length === 1 ? client.r[0] : "");
        if (!client.r.includes(redirectUri)) { errorPage(res, 400, "The app's return address doesn't match how it registered."); return true; }
        if (q.response_type !== "code") { redirect(res, withParams(redirectUri, { error: "unsupported_response_type", state: q.state })); return true; }
        if (!q.code_challenge || q.code_challenge_method !== "S256") { redirect(res, withParams(redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required", state: q.state })); return true; }
        const approval = await sign({ t: "approval", c: q.client_id, n: client.n, r: redirectUri, ch: q.code_challenge, st: q.state || "", res: q.resource || "", exp: now() + APPROVAL_SECONDS });
        page(res, 200, approvalPage({ clientName: client.n, approval, signedIn: await isSignedIn(req), returnTo: redirectUri }));
        return true;
      }

      if (p === "/oauth/authorize" && method === "POST") {
        const body = await readBody(req);
        const a = await open(body.approval, "approval");
        if (!a) { errorPage(res, 400, "This sign-in page has expired. Go back to your app and connect again."); return true; }
        if (body.decision !== "allow") { redirect(res, withParams(a.r, { error: "access_denied", state: a.st })); return true; }
        const signedIn = await isSignedIn(req);
        if (!signedIn) {
          if (!limiter(ip + ":oauth-password", 10)) { page(res, 429, approvalPage({ clientName: a.n, approval: body.approval, signedIn, error: "Too many tries. Wait a minute and try again.", returnTo: a.r })); return true; }
          if (!(await checkPassword(String(body.password || "")))) { page(res, 401, approvalPage({ clientName: a.n, approval: body.approval, signedIn, error: "That password isn't right.", returnTo: a.r })); return true; }
        }
        const code = await sign({ t: "code", c: a.c, r: a.r, ch: a.ch, res: a.res, exp: now() + CODE_SECONDS });
        redirect(res, withParams(a.r, { code, state: a.st, iss: origin(req) }));
        return true;
      }

      if (p === "/oauth/token" && method === "POST") {
        if (!limiter(ip + ":oauth-token", 60)) { json(res, 429, { error: "slow_down" }); return true; }
        const body = await readBody(req);
        const issue = async (clientId, resource) => {
          const access_token = await sign({ t: "access", c: clientId, res: resource || "", exp: now() + ACCESS_SECONDS });
          const refresh_token = await sign({ t: "refresh", c: clientId, res: resource || "", exp: now() + REFRESH_SECONDS });
          json(res, 200, { access_token, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token, scope: SCOPE });
        };
        if (body.grant_type === "authorization_code") {
          const c = await open(body.code, "code");
          if (!c) { json(res, 400, { error: "invalid_grant", error_description: "The code is invalid or has expired." }); return true; }
          if (body.client_id && body.client_id !== c.c) { json(res, 400, { error: "invalid_grant", error_description: "The code was issued to a different app." }); return true; }
          if (body.redirect_uri && body.redirect_uri !== c.r) { json(res, 400, { error: "invalid_grant", error_description: "redirect_uri doesn't match." }); return true; }
          const verifier = String(body.code_verifier || "");
          if (verifier.length < 43 || verifier.length > 128 || b64u(createHash("sha256").update(verifier).digest()) !== c.ch) { json(res, 400, { error: "invalid_grant", error_description: "PKCE check failed." }); return true; }
          await issue(c.c, c.res);
          return true;
        }
        if (body.grant_type === "refresh_token") {
          const r = await open(body.refresh_token, "refresh");
          if (!r) { json(res, 400, { error: "invalid_grant", error_description: "The refresh token is invalid or has expired. Connect again." }); return true; }
          if (body.client_id && body.client_id !== r.c) { json(res, 400, { error: "invalid_grant" }); return true; }
          await issue(r.c, r.res);
          return true;
        }
        json(res, 400, { error: "unsupported_grant_type" });
        return true;
      }

      json(res, 404, { error: "not_found" });
      return true;
    } catch (e) {
      json(res, e.status || 500, { error: e.status === 503 ? "temporarily_unavailable" : "server_error", error_description: e.status ? e.message : "Something went wrong." });
      return true;
    }
  }

  return { handle, verifyAccess, challenge, available };
}
