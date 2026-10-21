// HTTP API shared by the local dev server and (later) a Vercel function.
// The browser never holds a provider key. Each conversation is bound to a
// random session token the server only stores as a hash.
import { loadCorpus } from "./corpus.mjs";
import { openStore } from "./store.mjs";
import { createDialogue, newDialogueState, POLICY_VERSION } from "./dialogue.mjs";
import { createActions } from "./actions.mjs";
import {
  newToken, tokenHash, tokenMatches, verifyPassword, parseCookies, staffCookie, clearStaffCookie, STAFF_COOKIE,
} from "./auth.mjs";
import { RETENTION_DAYS } from "./store.mjs";
import { aiEnabled, interpretWithAI, extractWithAI, DEFAULT_MODEL } from "./ai-understanding.mjs";
import { interpretAnswer, detectGlobal, looksLikeCorrection } from "./understand.mjs";

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
  const aiFetch = opts.aiFetch || globalThis.fetch;

  // Optional AI help, only where the rules can't tell. Failures fall back silently.
  async function prepareAi(session, input) {
    if (!aiEnabled(env) || !input.text || input.choice || input.action) return;
    const c = dialogue.aiContext(session);
    const g = detectGlobal(input.text);
    if (g.repeat || g.help || g.staff || g.end || g.startOver || g.skipSection) return;
    try {
      if (c.phase === "opening") {
        session.__aiExtract = await extractWithAI(env, aiFetch, { questions: c.openQuestions, utterance: input.text });
        store.audit("system", session.id, "ai_extract", { n: session.__aiExtract.length });
      } else if (c.phase === "intake" && c.currentQuestion && !c.pending && !looksLikeCorrection(input.text)) {
        const det = interpretAnswer(input.text, c.currentQuestion, { geography: corpus.geography });
        if (det.kind !== "unclear") return;
        const r = await interpretWithAI(env, aiFetch, { question: c.currentQuestion, utterance: input.text, otherQuestions: c.openQuestions.filter((x) => x.id !== c.currentQuestion.id) });
        if (r) { session.__aiInterp = { ...r, questionId: c.currentQuestion.id }; store.audit("system", session.id, "ai_interpret", { kind: r.kind }); }
      }
    } catch (e) {
      store.audit("system", session.id, "ai_unavailable", { error: String(e.message).slice(0, 80) });
    }
  }
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

  function send(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    res.end(data);
  }

  async function readJson(req) {
    if (req.body && typeof req.body === "object") return req.body; // platforms that pre-parse
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw httpError(413, "Request too large");
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

  function isSecure(req) {
    return req.headers["x-forwarded-proto"] === "https" || !!(req.socket && req.socket.encrypted);
  }

  function loadSession(req, id) {
    const s = store.getSession(id);
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!s || !tokenMatches(token, s.token_hash)) throw httpError(404, "Session not found");
    if (new Date(s.expires_at) < new Date()) throw httpError(410, "Session expired");
    return s;
  }

  function staffUser(req) {
    const tok = parseCookies(req.headers.cookie)[STAFF_COOKIE];
    if (!tok) return null;
    const sess = store.staffSession(tokenHash(tok));
    return sess ? store.staffUserById(sess.user_id) : null;
  }

  function requireStaff(req) {
    const u = staffUser(req);
    if (!u) throw httpError(401, "Staff sign-in required");
    return u;
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
          ok: true, corpusVersion: corpus.version, hashes: corpus.hashes, organizations: corpus.organizations.length,
          policyVersion: POLICY_VERSION, emailTransport: ctx.actions.transportName(), retentionDays: RETENTION_DAYS,
          storage: env.V360_STORAGE || "local",
          aiUnderstanding: aiEnabled(env) ? { on: true, model: env.V360_AI_MODEL || DEFAULT_MODEL } : { on: false },
        });
      }

      // ---------------- conversation -------------------------------------
      if (p === "/api/session" && method === "POST") {
        const body = await readJson(req);
        if (body.noticeAccepted !== true) throw httpError(400, "The demo notice must be accepted first.");
        const token = newToken();
        const id = store.createSession({ tokenHash: tokenHash(token), corpusVersion: corpus.version, state: newDialogueState() });
        const session = store.getSession(id);
        session.notice_ack_at = new Date().toISOString();
        session.channels = [{ mode: body.mode === "voice" ? "voice" : "text", at: session.notice_ack_at }];
        const turn = dialogue.greeting(session);
        store.saveSession(session);
        store.audit("caller", id, "session_started", { mode: body.mode });
        return send(res, 201, { sessionId: id, token, ...turnResponse(session, turn) });
      }

      let m = p.match(/^\/api\/session\/([0-9a-f-]{36})(?:\/(turn|state|event|end))?$/);
      if (m) {
        const id = m[1], sub = m[2] || "state";
        if (sub === "state" && method === "GET") {
          const s = loadSession(req, id);
          return send(res, 200, { state: dialogue.snapshot(s) });
        }
        if (method !== "POST") throw httpError(405, "Method not allowed");
        const body = await readJson(req);
        return await withLock(id, async () => {
          const s = loadSession(req, id);
          if (sub === "turn") {
            if (s.status === "ended") throw httpError(409, "This session has ended.");
            const clientTurnId = String(body.clientTurnId || "").slice(0, 64);
            if (clientTurnId) {
              const cached = store.cachedTurn(id, clientTurnId);
              if (cached) return send(res, 200, { ...cached, replayed: true });
            }
            const mode = body.mode === "voice" ? "voice" : "text";
            const last = s.channels[s.channels.length - 1];
            if (!last || last.mode !== mode) s.channels.push({ mode, at: new Date().toISOString() });
            const input = {
              text: typeof body.text === "string" ? body.text : "",
              choice: body.choice && typeof body.choice === "object" ? { questionId: String(body.choice.questionId || ""), value: body.choice.value } : null,
              action: typeof body.action === "string" ? body.action : null,
              questionId: typeof body.questionId === "string" ? body.questionId : null,
              revision: body.revision === undefined ? null : Number(body.revision),
              mode,
            };
            await prepareAi(s, input);
            const turn = dialogue.handle(s, input);
            delete s.__aiExtract; delete s.__aiInterp;
            store.saveSession(s);
            // Serverless has no background loop: finish the email job before replying.
            if (turn.actionId && env.V360_INLINE_WORKER !== "off" && env.V360_SERVERLESS) await processQueueSoon();
            const out = turnResponse(s, turn);
            if (clientTurnId) store.cacheTurn(id, clientTurnId, out);
            if (turn.actionId && env.V360_INLINE_WORKER !== "off" && !env.V360_SERVERLESS) processQueueSoon();
            return send(res, 200, out);
          }
          if (sub === "event") {
            if (body.type === "speech_interrupted") {
              const changed = dialogue.speechInterrupted(s, String(body.turnId || ""));
              store.saveSession(s);
              return send(res, 200, { ok: true, consentMustBeRepeated: changed });
            }
            if (body.type === "mode_switch") {
              const mode = body.mode === "voice" ? "voice" : "text";
              s.channels.push({ mode, at: new Date().toISOString() });
              store.audit("caller", id, "mode_switch", { mode });
              store.saveSession(s);
              return send(res, 200, { ok: true, state: dialogue.snapshot(s) });
            }
            throw httpError(400, "Unknown event");
          }
          if (sub === "end") {
            s.status = "ended";
            s.state.phase = "closed";
            store.audit("caller", id, "session_ended", null);
            store.saveSession(s);
            return send(res, 200, { ok: true });
          }
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
        const tok = newToken();
        store.createStaffSession(tokenHash(tok), user.id);
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
        return u ? send(res, 200, { username: u.username }) : send(res, 401, { error: "Not signed in" });
      }
      if (p === "/api/staff/sessions" && method === "GET") {
        requireStaff(req);
        const open = new Map(store.allOpenReviews().map((r) => [r.session_id, r.n]));
        const rows = store.listSessions().map((s) => ({ ...s, openReviews: open.get(s.id) || 0, actions: store.actionsForSession(s.id).map((a) => ({ type: a.type, status: a.status })) }));
        return send(res, 200, { sessions: rows });
      }
      m = p.match(/^\/api\/staff\/sessions\/([0-9a-f-]{36})(?:\/(status))?$/);
      if (m) {
        const u = requireStaff(req);
        const s = store.getSession(m[1]);
        if (!s) throw httpError(404, "Not found");
        if (m[2] === "status" && method === "POST") {
          const body = await readJson(req);
          const allowed = ["pending", "reviewed", "needs_follow_up"];
          if (!allowed.includes(body.staffStatus)) throw httpError(400, "Invalid status");
          s.staff_status = body.staffStatus;
          store.saveSession(s);
          store.audit("staff:" + u.username, s.id, "staff_status", { staffStatus: body.staffStatus });
          return send(res, 200, { ok: true });
        }
        if (method !== "GET") throw httpError(405, "Method not allowed");
        store.audit("staff:" + u.username, s.id, "viewed", null);
        const snap = dialogue.snapshot(s);
        return send(res, 200, {
          session: { id: s.id, created_at: s.created_at, updated_at: s.updated_at, status: s.status, staff_status: s.staff_status, revision: s.revision, channels: s.channels, corpus_version: s.corpus_version, expires_at: s.expires_at },
          snapshot: { ...snap, lastAssistant: undefined },
          recommendations: store.recommendations(s.id).map((r) => ({ id: r.id, revision: r.revision, corpusVersion: r.corpus_version, stale: !!r.stale, createdAt: r.created_at, matches: r.result.matches.map((x) => ({ rank: x.rank, id: x.id, name: x.name, points: x.points, reasons: x.reasons })), handoffs: r.result.handoffs.map((h) => h.headline), unresolved: r.result.unresolved })),
          actions: store.actionsForSession(s.id),
          reviews: store.staffReviews(s.id),
          answerEvents: store.answerEvents(s.id),
          audit: store.auditFor(s.id).map((a) => ({ at: a.at, actor: a.actor, event: a.event })),
        });
      }
      m = p.match(/^\/api\/staff\/actions\/([0-9a-f-]{36})\/retry$/);
      if (m && method === "POST") {
        const u = requireStaff(req);
        const ok = ctx.actions.retry(m[1]);
        store.audit("staff:" + u.username, null, "action_retry", { actionId: m[1], ok });
        if (ok) await processQueueSoon();
        return send(res, ok ? 200 : 409, { ok });
      }

      throw httpError(404, "Not found");
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? "Something went wrong on the server. Nothing was sent or submitted." : e.message });
    }
  }

  return { handle, ctx, store, dialogue, corpus };
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
