// HTTP API shared by the local dev server and (later) a Vercel function.
// The browser never holds a provider key. Each conversation is bound to a
// random session token the server only stores as a hash.
import { loadCorpus } from "./corpus.mjs";
import { openStore } from "./store.mjs";
import { createDialogue, POLICY_VERSION } from "./dialogue.mjs";
import { createSqliteSessionRepo } from "./session-repo.mjs";
import { createTurnService } from "./turn-service.mjs";
import { createActions } from "./actions.mjs";
import {
  newToken, tokenHash, tokenMatches, verifyPassword, parseCookies, staffCookie, clearStaffCookie, STAFF_COOKIE,
  sessionSecret, signSession, verifySession,
} from "./auth.mjs";
import { RETENTION_DAYS } from "./store.mjs";
import { ttsEnabled, ttsInfo, synthesize } from "./tts.mjs";
import { aiEnabled, DEFAULT_MODEL } from "./ai-understanding.mjs";
import { createAdminStore } from "./supabase-store.mjs";
import { createRequests } from "./requests.mjs";
import { createFlowRepo } from "./flow-repo.mjs";
import { createMcp } from "./mcp.mjs";
import { supabaseConfigured, supabaseKeyProblem, createSupabaseSessions, createDurableSessions } from "./supabase-sessions.mjs";

import { randomUUID } from "node:crypto";

const MAX_BODY = 16 * 1024;

export async function createApp(opts = {}) {
  const corpus = await loadCorpus();
  const store = opts.store || openStore(opts.dbPath);
  const env = opts.env || process.env;
  const ctx = { corpus, store, env };
  ctx.actions = createActions(ctx);
  const dialogue = createDialogue(ctx);
  // Optional staff bootstrap for hosted previews: a username plus an scrypt
  // hash (never a plain password) supplied as deployment environment values.
  if (env.V360_STAFF_USER && env.V360_STAFF_PASSWORD_HASH && !store.staffUserByName(env.V360_STAFF_USER)) {
    store.createStaffUser(env.V360_STAFF_USER, env.V360_STAFF_PASSWORD_HASH);
  }
  const limiter = rateLimiter();
  // Admin storage: GitHub when V360_GITHUB_TOKEN is set, otherwise a local folder.
  const gh = opts.ghStore || createAdminStore(env, { dir: env.V360_ADMIN_STORE_DIR, repoRoot: opts.repoRoot });
  const requests = createRequests(gh);
  const editsOn = String(env.V360_FLOW_EDITS || "on").toLowerCase() !== "off";
  const flows = createFlowRepo({ gh, corpus, requests });
  ctx.gh = gh; ctx.requests = requests; ctx.flows = flows;
  const BIG_BODY = 600 * 1024;
  const access = accessRules(env, gh);
  ctx.access = access;
  const mcp = createMcp({ flows, requests, corpus, overview: () => adminOverview(), canWrite: () => editsOn && access.writesAllowed });
  const aiFetch = opts.aiFetch || globalThis.fetch;
  const ttsFetch = opts.ttsFetch || globalThis.fetch;
  const ttsCount = new Map();
  const sampleCache = new Map();

  // Sessions are loaded once and saved once per request (see session-repo.mjs);
  // the turn service runs the conversation itself, independent of HTTP.
  // With Supabase configured, conversations are kept there and each server
  // copy works from its SQLite cache (see supabase-sessions.mjs).
  const sqliteRepo = createSqliteSessionRepo(store);
  const durable = opts.durable !== undefined ? opts.durable
    : opts.sessionRemote ? createDurableSessions({ store, sqliteRepo, remote: opts.sessionRemote })
    : supabaseConfigured(env) ? createDurableSessions({ store, sqliteRepo, remote: createSupabaseSessions(env, opts.supabaseFetch) }) : null;
  const repo = durable ? durable.repo : sqliteRepo;
  store.durableKind = durable ? "supabase" : "local";
  // Conversations changed outside a guarded turn save (emails sent, replay
  // cache, staff status) are copied to the database before each reply.
  const dirty = new Set();
  ctx.markDirty = (id) => { if (id) dirty.add(id); };
  async function flushDirty() {
    if (!durable || !dirty.size) return;
    const ids = [...dirty];
    dirty.clear();
    await durable.flush(ids);
  }
  async function pullRecent(days = 30) {
    if (durable) await durable.pullRecent(new Date(Date.now() - days * 864e5).toISOString());
  }
  const turns = createTurnService({ corpus, store, repo, dialogue, actions: ctx.actions, env, aiFetch });

  const locks = new Map();

  // One turn at a time per session, so a late request can't overwrite a newer one.
  async function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    locks.set(id, prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(id) === next) locks.delete(id); }
  }

  async function send(res, status, body, headers = {}) {
    await flushDirty();
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    res.end(data);
  }

  async function readJson(req, max = MAX_BODY) {
    if (req.body && typeof req.body === "object") return req.body; // platforms that pre-parse
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) throw httpError(413, "Request too large");
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw httpError(400, "Invalid JSON"); }
  }

  // Same-origin only for anything that changes state.
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients (tests, curl) send none
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    let ok = false;
    try { ok = new URL(origin).host === host; } catch {}
    const extra = String(env.V360_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ok && !extra.includes(origin)) throw httpError(403, "Origin not allowed");
  }

  // Admin changes must come from this site's own pages: a missing Origin is
  // refused too, so scripts can't write without going through the connector.
  function requireSameSite(req) {
    if (!req.headers.origin) throw httpError(403, "Changes here must come from the admin pages.");
    checkOrigin(req);
  }

  // Anything that commits to the public repo (publish, revert) needs the key.
  function requirePublishKey(req) {
    if (!access.publishAllowed) throw httpError(503, access.note);
    if (!access.keyRequired) return;
    const given = req.headers["x-v360-key"] || "";
    if (!given || !tokenMatches(given, tokenHash(env.V360_MCP_KEY))) {
      const e = httpError(401, "Publishing needs the publish key (the same key as the Claude connector).");
      e.code = "publish_key";
      throw e;
    }
  }

  function isSecure(req) {
    return req.headers["x-forwarded-proto"] === "https" || !!(req.socket && req.socket.encrypted);
  }

  async function loadSession(req, id) {
    const s = await repo.load(id);
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!s || !tokenMatches(token, s.token_hash)) throw httpError(404, "Session not found");
    if (new Date(s.expires_at) < new Date()) throw httpError(410, "Session expired");
    return s;
  }

  const signer = sessionSecret(env);
  function staffUser(req) {
    const tok = parseCookies(req.headers.cookie)[STAFF_COOKIE];
    if (!tok) return null;
    const signed = verifySession(signer, tok);
    if (signed) return store.staffUserByName(signed);
    const sess = store.staffSession(tokenHash(tok));
    return sess ? store.staffUserById(sess.user_id) : null;
  }

  // Admin sign-in is off for now (owner's decision, 2026-11-06): anyone with
  // the link can open the staff queue and admin pages. Set V360_ADMIN_SIGNIN=on
  // to require a staff password again. Cross-origin writes stay blocked.
  const adminOpen = String(env.V360_ADMIN_SIGNIN || "off").toLowerCase() !== "on";
  const OPEN_ADMIN = { username: "admin-open" };

  function requireStaff(req) {
    const u = staffUser(req) || (adminOpen ? OPEN_ADMIN : null);
    if (!u) throw httpError(401, "Staff sign-in required");
    return u;
  }

  // In open mode, show only enough of an address to tell emails apart.
  function maskEmail(to) {
    if (!to || !adminOpen) return to;
    const [user, domain] = String(to).split("@");
    return (user ? user[0] : "") + "•••@" + (domain || "");
  }

  // The admin dashboard's numbers (also served to the MCP get_dashboard tool).
  function adminOverview() {
    const days = 30;
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const usage = store.adminUsage(since);
    const ai = aiEnabled(env);
    const perCall = Number(env.V360_COST_PER_AI_CALL_USD);
    const tts = ttsInfo(env).provider;
    return {
          generatedAt: new Date().toISOString(), days, since,
          commit: env.VERCEL_GIT_COMMIT_SHA || "local",
          storage: env.V360_STORAGE || "local", retentionDays: RETENTION_DAYS,
          signInRequired: !adminOpen,
          usage,
          costs: {
            ai: { on: ai, model: ai ? env.V360_AI_MODEL || DEFAULT_MODEL : null, calls: usage.aiCalls, perCallUsd: Number.isFinite(perCall) ? perCall : null, estimateUsd: !ai && !usage.aiCalls ? 0 : (Number.isFinite(perCall) ? +(usage.aiCalls * perCall).toFixed(4) : null) },
            tts: { provider: tts, estimateUsd: tts === "browser" ? 0 : null },
            email: { transport: ctx.actions.transportName(), estimateUsd: ctx.actions.transportName() === "outbox" ? 0 : null },
          },
          emails: store.adminEmails(since).map((e) => ({ ...e, to: maskEmail(e.to) })),
          settings: {
            corpusVersion: corpus.version, organizations: corpus.organizations.length, policyVersion: POLICY_VERSION,
            emailTransport: ctx.actions.transportName(), tts, aiUnderstanding: ai,
            storage: { ...(gh.kind === "github" ? { kind: "github", repo: gh.repo } : { kind: "local" }), data: gh.dataKind || gh.kind, sessions: store.durableKind },
            editsOn, mcpKeyRequired: !!env.V360_MCP_KEY, publishing: access.publishing, publishingNote: access.note,
          },
    };
  }

  function turnResponse(session, turn) {
    return { turn, state: dialogue.snapshot(session) };
  }

  async function processQueueSoon() {
    // Run due actions now; the dev server also polls on an interval.
    try { await ctx.actions.drain(5); } catch (e) { console.error("worker error", e.message); }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname.replace(/\/+$/, "");
    const method = req.method;
    try {
      const ip = String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "local").split(",")[0].trim();
      if (!limiter(ip, p.startsWith("/api/staff/login") ? 10 : 120)) throw httpError(429, "Too many requests — please wait a moment.");
      if (method !== "GET") checkOrigin(req);

      if (p === "/api/health" && method === "GET") {
        return send(res, 200, {
          ok: true, commit: env.VERCEL_GIT_COMMIT_SHA || "local", corpusVersion: corpus.version, hashes: corpus.hashes, organizations: corpus.organizations.length,
          policyVersion: POLICY_VERSION, emailTransport: ctx.actions.transportName(), retentionDays: RETENTION_DAYS,
          storage: env.V360_STORAGE || "local",
          stores: { content: gh.kind, adminData: gh.dataKind || gh.kind, sessions: store.durableKind || "local" },
          ...(supabaseKeyProblem(env) ? { storeProblem: supabaseKeyProblem(env) } : {}),
          publishing: access.publishing,
          tts: { provider: ttsInfo(env).provider },
          aiUnderstanding: aiEnabled(env) ? { on: true, model: env.V360_AI_MODEL || DEFAULT_MODEL } : { on: false },
        });
      }

      // Fixed sample sentence for the voice picker (never arbitrary text).
      if (p === "/api/tts-sample" && method === "GET") {
        if (!ttsEnabled(env)) throw httpError(404, "Natural voice is not set up");
        const rate = Number(url.searchParams.get("rate")) || 1;
        const key = String(rate);
        if (!sampleCache.has(key)) sampleCache.set(key, await synthesize(env, ttsFetch, { text: "Hi, I'm the Vision 360 assistant. Tell me a little about what's going on, and I'll help you find the right services.", rate }));
        const audio = sampleCache.get(key);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
        return res.end(audio);
      }

      // ---------------- conversation -------------------------------------
      if (p === "/api/session" && method === "POST") {
        const body = await readJson(req);
        if (body.noticeAccepted !== true) throw httpError(400, "The demo notice must be accepted first.");
        const token = newToken();
        const { session, turn } = await turns.start({ mode: body.mode, tokenHash: tokenHash(token) });
        ctx.markDirty(session.id);
        return send(res, 201, { sessionId: session.id, token, ...turnResponse(session, turn) });
      }

      let m = p.match(/^\/api\/session\/([0-9a-f-]{36})(?:\/(turn|state|event|end|tts))?$/);
      if (m) {
        const id = m[1], sub = m[2] || "state";
        if (method !== "GET") ctx.markDirty(id);
        if (sub === "state" && method === "GET") {
          const s = await loadSession(req, id);
          return send(res, 200, { state: dialogue.snapshot(s) });
        }
        if (method !== "POST") throw httpError(405, "Method not allowed");
        const body = await readJson(req);
        return await withLock(id, async () => {
          const s = await loadSession(req, id);
          if (sub === "turn") {
            const clientTurnId = String(body.clientTurnId || "").slice(0, 64);
            if (clientTurnId) {
              const cached = store.cachedTurn(id, clientTurnId);
              if (cached) return send(res, 200, { ...cached, replayed: true });
            }
            const { reply, session } = await turns.turn(s, body);
            const out = turnResponse(session, reply);
            if (clientTurnId) store.cacheTurn(id, clientTurnId, out);
            return send(res, 200, out);
          }
          if (sub === "event") return send(res, 200, await turns.event(s, body));
          if (sub === "tts") {
            // Voice ONLY the assistant's own latest reply for this session.
            if (!ttsEnabled(env)) throw httpError(404, "Natural voice is not set up");
            const last = s.state.lastAssistant;
            if (!last || String(body.turnId || "") !== last.turnId) throw httpError(409, "That reply is no longer current");
            const n = (ttsCount.get(id) || 0) + 1;
            ttsCount.set(id, n);
            if (n > 300) throw httpError(429, "Voice limit reached for this session");
            const audio = await synthesize(env, ttsFetch, { text: last.speech || last.text, rate: body.rate });
            res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
            return res.end(audio);
          }
          if (sub === "end") return send(res, 200, await turns.end(s));
          throw httpError(404, "Not found");
        });
      }

      // ---------------- staff -------------------------------------------
      if (p === "/api/staff/login" && method === "POST") {
        const body = await readJson(req);
        const user = store.staffUserByName(String(body.username || "").trim().toLowerCase());
        if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) {
          store.audit("staff", null, "login_failed", { username: String(body.username || "").slice(0, 40) });
          throw httpError(401, "Wrong username or password.");
        }
        // Signed cookie when a server secret exists (works on every server
        // copy); otherwise a session row in this copy's database.
        let tok;
        if (signer) tok = signSession(signer, user.username);
        else { tok = newToken(); store.createStaffSession(tokenHash(tok), user.id); }
        store.audit("staff:" + user.username, null, "login", null);
        return send(res, 200, { ok: true, username: user.username }, { "Set-Cookie": staffCookie(tok, isSecure(req)) });
      }
      if (p === "/api/staff/logout" && method === "POST") {
        const tok = parseCookies(req.headers.cookie)[STAFF_COOKIE];
        if (tok) store.deleteStaffSession(tokenHash(tok));
        return send(res, 200, { ok: true }, { "Set-Cookie": clearStaffCookie(isSecure(req)) });
      }
      if (p === "/api/staff/me" && method === "GET") {
        const u = staffUser(req);
        if (u) return send(res, 200, { username: u.username, signInRequired: !adminOpen });
        return adminOpen ? send(res, 200, { username: OPEN_ADMIN.username, open: true, signInRequired: false }) : send(res, 401, { error: "Not signed in" });
      }
      // ---------------- requests and change log ------------------------
      if (p === "/api/requests" || p.startsWith("/api/requests/") || p === "/api/changelog") {
        requireStaff(req);
        if (method !== "GET") {
          requireSameSite(req);
          if (!editsOn) throw httpError(403, "Editing is turned off on this site (V360_FLOW_EDITS=off).");
          if (!limiter(ip + ":write", 30)) throw httpError(429, "Too many changes at once — please wait a minute.");
        }
        if (p === "/api/changelog" && method === "GET") {
          await flows.reconcile(env.VERCEL_GIT_COMMIT_SHA).catch(() => 0);
          return send(res, 200, { entries: await requests.changelog() });
        }
        if (p === "/api/requests" && method === "GET") {
          const page = url.searchParams.get("page");
          const rows = await requests.list({ page: page || undefined });
          return send(res, 200, { requests: page ? rows.slice(0, 5) : rows });
        }
        if (p === "/api/requests" && method === "POST") return send(res, 201, { request: await requests.create(await readJson(req)) });
        const rm = p.match(/^\/api\/requests\/([0-9a-f-]{36})(?:\/(comment|status|cancel))?$/);
        if (rm) {
          if (method === "DELETE" && !rm[2]) return send(res, 200, await requests.remove(rm[1]));
          if (method === "POST" && rm[2] === "comment") return send(res, 200, { request: await requests.comment(rm[1], { author: "team", body: (await readJson(req)).body }) });
          if (method === "POST" && rm[2] === "status") return send(res, 200, { request: await requests.setStatus(rm[1], await readJson(req)) });
          if (method === "POST" && rm[2] === "cancel") return send(res, 200, { request: await requests.cancel(rm[1]) });
        }
        throw httpError(404, "Not found");
      }
      // ---------------- MCP (Claude / ChatGPT connector) ------------------
      if (p === "/api/mcp") {
        if (method === "DELETE") { res.writeHead(200, { "Cache-Control": "no-store" }); return res.end(); }
        if (method !== "POST") return send(res, 405, { error: "This MCP endpoint takes POST (Streamable HTTP, JSON responses)." }, { Allow: "POST, DELETE" });
        if (env.V360_MCP_KEY) {
          // Header for clients that can send one (Claude Code); ?key= in the
          // connector URL for Claude.ai and ChatGPT custom connectors.
          const given = req.headers["x-v360-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("key") || "";
          if (!given || !tokenMatches(given, tokenHash(env.V360_MCP_KEY))) throw httpError(401, "This connector needs its key.");
        }
        if (!limiter(ip + ":mcp", 120)) throw httpError(429, "Too many requests — please wait a moment.");
        const out = await mcp.handle(await readJson(req, BIG_BODY));
        // Stateless server; a session id is still handed out for clients that expect one.
        const sid = req.headers["mcp-session-id"] || (Array.isArray(out.body) ? null : out.body && out.body.result && out.body.result.serverInfo ? randomUUID() : null);
        const extra = sid ? { "Mcp-Session-Id": sid } : {};
        if (out.status === 202) { res.writeHead(202, { "Cache-Control": "no-store", ...extra }); return res.end(); }
        return send(res, 200, out.body, extra);
      }
      // ---------------- workflows ---------------------------------------
      if (p === "/api/flows" || p.startsWith("/api/flows/")) {
        requireStaff(req);
        if (method !== "GET") {
          requireSameSite(req);
          if (!editsOn) throw httpError(403, "Editing is turned off on this site (V360_FLOW_EDITS=off).");
          if (!access.writesAllowed) throw httpError(503, access.note);
          if (!limiter(ip + ":write", 30)) throw httpError(429, "Too many changes at once — please wait a minute.");
        }
        if (p === "/api/flows" && method === "GET") return send(res, 200, { flows: await flows.list(), storage: gh.kind, editsOn, publishing: access.publishing, keyRequired: access.keyRequired });
        const fm = p.match(/^\/api\/flows\/([a-z0-9-]{1,40})(?:\/(draft|check|publish|revert|versions)(?:\/([0-9a-z-]{7,40}))?)?$/);
        if (fm) {
          const [, id, action, arg] = fm;
          if (!action && method === "GET") return send(res, 200, await flows.get(id));
          if (action === "versions" && arg && method === "GET") return send(res, 200, { flow: await flows.versionAt(id, arg) });
          if (action === "draft" && method === "PUT") return send(res, 200, await flows.saveDraft(id, await readJson(req, BIG_BODY)));
          if (action === "draft" && method === "DELETE") return send(res, 200, await flows.discardDraft(id));
          if (action === "check" && method === "POST") { const b = await readJson(req, BIG_BODY); return send(res, 200, await flows.check(id, b.flow)); }
          if (action === "publish" || action === "revert") {
            if (method !== "POST") throw httpError(405, "Method not allowed");
            requirePublishKey(req);
            if (!limiter(ip + ":publish", 6)) throw httpError(429, "Too many publishes — please wait a minute.");
            const b = await readJson(req);
            const out = action === "publish" ? await flows.publish(id, b) : await flows.revert(id, b);
            return send(res, 200, { ...out, live: liveMessage(out) });
          }
        }
        throw httpError(404, "Not found");
      }
      if (p === "/api/admin/overview" && method === "GET") {
        requireStaff(req);
        await pullRecent();
        return send(res, 200, adminOverview());
      }
      if (p === "/api/staff/sessions" && method === "GET") {
        requireStaff(req);
        await pullRecent(RETENTION_DAYS + 30);
        const open = new Map(store.allOpenReviews().map((r) => [r.session_id, r.n]));
        const rows = store.listSessions().map((s) => ({ ...s, openReviews: open.get(s.id) || 0, actions: store.actionsForSession(s.id).map((a) => ({ type: a.type, status: a.status })) }));
        return send(res, 200, { sessions: rows });
      }
      m = p.match(/^\/api\/staff\/sessions\/([0-9a-f-]{36})(?:\/(status))?$/);
      if (m) {
        const u = requireStaff(req);
        const s = await repo.load(m[1]);
        if (!s) throw httpError(404, "Not found");
        if (m[2] === "status" && method === "POST") {
          requireSameSite(req);
          ctx.markDirty(s.id);
          const body = await readJson(req);
          const allowed = ["pending", "reviewed", "needs_follow_up"];
          if (!allowed.includes(body.staffStatus)) throw httpError(400, "Invalid status");
          // Only the staff column changes; the conversation itself is untouched.
          store.setStaffStatus(s.id, body.staffStatus);
          store.audit("staff:" + u.username, s.id, "staff_status", { staffStatus: body.staffStatus });
          return send(res, 200, { ok: true });
        }
        if (method !== "GET") throw httpError(405, "Method not allowed");
        store.audit("staff:" + u.username, s.id, "viewed", null);
        const snap = dialogue.snapshot(s);
        return send(res, 200, {
          session: { id: s.id, created_at: s.created_at, updated_at: s.updated_at, status: s.status, staff_status: s.staff_status, revision: s.revision, channels: s.channels, corpus_version: s.corpus_version, expires_at: s.expires_at },
          snapshot: { ...snap, lastAssistant: undefined },
          recommendations: store.recommendations(s.id).map((r) => ({ id: r.id, revision: r.revision, corpusVersion: r.corpus_version, commit: r.result.commit || null, stale: !!r.stale, createdAt: r.created_at, matches: r.result.matches.map((x) => ({ rank: x.rank, id: x.id, name: x.name, points: x.points, reasons: x.reasons })), handoffs: r.result.handoffs.map((h) => h.headline), unresolved: r.result.unresolved })),
          actions: store.actionsForSession(s.id),
          reviews: store.staffReviews(s.id),
          answerEvents: store.answerEvents(s.id),
          audit: store.auditFor(s.id).map((a) => ({ at: a.at, actor: a.actor, event: a.event })),
        });
      }
      m = p.match(/^\/api\/staff\/actions\/([0-9a-f-]{36})\/retry$/);
      if (m && method === "POST") {
        const u = requireStaff(req);
        requireSameSite(req);
        const act = store.getAction(m[1]);
        if (act) ctx.markDirty(act.session_id);
        const ok = ctx.actions.retry(m[1]);
        store.audit("staff:" + u.username, null, "action_retry", { actionId: m[1], ok });
        if (ok) await processQueueSoon();
        return send(res, ok ? 200 : 409, { ok });
      }

      // ---------------- scheduled work (Vercel Cron) ----------------------
      // Sends due emails (retries from any server copy) and removes expired
      // conversations. With CRON_SECRET set, only Vercel's scheduler may call it.
      if (p === "/api/cron/tick" && method === "GET") {
        if (env.CRON_SECRET && String(req.headers.authorization || "") !== "Bearer " + env.CRON_SECRET) throw httpError(401, "Not allowed");
        const due = durable ? await durable.pullDue() : 0;
        const sent = await ctx.actions.drain(10);
        const purgedLocal = store.purgeExpired();
        const purgedDb = durable ? await durable.purge() : 0;
        return send(res, 200, { ok: true, due, processed: sent.length, purged: { local: purgedLocal, database: purgedDb } });
      }

      throw httpError(404, "Not found");
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? "Something went wrong on the server. Nothing was sent or submitted." : e.message, ...(e.code ? { code: e.code } : {}), ...(e.details ? { details: e.details } : {}) });
    }
  }

  return { handle, ctx, store, dialogue, corpus };
}

export function liveMessage(out) {
  if (out.state === "proposed") return `Sent for checks as pull request #${out.pr}. It goes live by itself in about 3–5 minutes once the checks pass; the change log shows when it's live.`;
  return "Saved on this machine only (GitHub isn't connected).";
}

// Who may change what, decided once at start-up from the environment.
//   - GitHub connected (published versions go to the public repo): publishing
//     and every connector/editor write need V360_MCP_KEY. Without the key,
//     writes are refused, so adding the token first can't open the repo.
//   - Hosted without GitHub: publishing is off (it would only change one
//     server copy); drafts and requests still save.
//   - Local dev and tests: open, unless a key is set.
export function accessRules(env, gh) {
  const key = !!env.V360_MCP_KEY;
  const github = gh.kind === "github";
  const hosted = !!env.V360_SERVERLESS;
  if (github && !key) return { publishing: "off", keyRequired: true, writesAllowed: false, publishAllowed: false, note: "Publishing is off: GitHub is connected but the connector key (V360_MCP_KEY) isn't set." };
  if (github) return { publishing: "on", keyRequired: true, writesAllowed: true, publishAllowed: true, note: "Publishing opens a pull request that goes live once the checks pass." };
  if (hosted) return { publishing: "off", keyRequired: key, writesAllowed: true, publishAllowed: false, note: "Publishing is off: GitHub isn't connected on this site, so a publish would only change one server copy." };
  return { publishing: "local", keyRequired: key, writesAllowed: true, publishAllowed: true, note: "Published versions are kept on this machine only." };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function rateLimiter() {
  const hits = new Map();
  return (key, perMinute) => {
    const now = Date.now();
    const k = key + ":" + perMinute;
    const arr = (hits.get(k) || []).filter((t) => now - t < 60000);
    arr.push(now);
    hits.set(k, arr);
    return arr.length <= perMinute;
  };
}
