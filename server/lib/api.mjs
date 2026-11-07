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
import { flowMeta } from "./corpus.mjs";
import { ttsEnabled, ttsInfo, ttsKeySet, synthesize, DEFAULT_VOICE_ID, DEFAULT_TTS_MODEL } from "./tts.mjs";
import { voicePhrases } from "./phrases.mjs";
import { aiEnabled, DEFAULT_MODEL } from "./ai-understanding.mjs";
import { createAdminStore } from "./supabase-store.mjs";
import { createRequests } from "./requests.mjs";
import { createFlowRepo } from "./flow-repo.mjs";
import { createMcp } from "./mcp.mjs";
import { verifyWebhook, deliveryEvent } from "./email-webhook.mjs";
import { supabaseConfigured, supabaseKeyProblem, createSupabaseSessions, createDurableSessions } from "./supabase-sessions.mjs";
import { createSiteSettings } from "./site-settings.mjs";
import { serveAdmin } from "./admin-pages.mjs";
import { qrSvg } from "./qr.mjs";
import * as check from "./screen-check.mjs";
import { createCheckStore } from "./screen-check-store.mjs";
import { readFileSync as readFileSyncCheck } from "node:fs";
import pathCheck from "node:path";
import { ROOT_DIR as ROOT_DIR_CHECK } from "./corpus.mjs";

import { randomUUID } from "node:crypto";

const MAX_BODY = 16 * 1024;
const ADMIN_USER = "admin";

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
  const flowRunnable = (id) => !!flowMeta(corpus, id);
  ctx.flowRunnable = flowRunnable;
  // Admin storage: GitHub when V360_GITHUB_TOKEN is set, otherwise a local folder.
  const gh = opts.ghStore || createAdminStore(env, { dir: env.V360_ADMIN_STORE_DIR, repoRoot: opts.repoRoot });
  const requests = createRequests(gh);
  const settings = opts.settings || createSiteSettings({ gh, env });
  ctx.settings = settings;
  const editsOn = String(env.V360_FLOW_EDITS || "on").toLowerCase() !== "off";
  const flows = createFlowRepo({ gh, corpus, requests });
  ctx.gh = gh; ctx.requests = requests; ctx.flows = flows;
  const BIG_BODY = 600 * 1024;
  const access = accessRules(env, gh);
  ctx.access = access;
  const linkOrigin = () => (env.V360_PUBLIC_ORIGIN ? String(env.V360_PUBLIC_ORIGIN).replace(/\/+$/, "") : env.V360_SERVERLESS ? "https://vision360.agenticarc.ai" : "http://localhost:" + (env.PORT || 8360));
  const mcp = createMcp({
    flows, requests, corpus, overview: async () => adminOverview(), canWrite: () => editsOn && access.writesAllowed,
    site: {
      main: async () => (await settings.site()).mainFlow,
      async setMain(id) {
        if (!flowRunnable(id)) { const e = httpError(400, `Only a published workflow can be the main one. Published: ${[...corpus.flows.keys()].join(", ")}.`); throw e; }
        await settings.updateSite({ mainFlow: id });
        await requests.logChange({ title: "Main workflow changed", summary: `Main workflow is now "${id}" (set by Claude).`, kind: "app" }).catch(() => {});
        return { mainFlow: id };
      },
      links(id) {
        const o = linkOrigin();
        return { live: flowRunnable(id), url: `${o}/f/${id}`, qr_svg: `${o}/api/qr/${id}.svg`, flyer: `${o}/admin/workflows/flyer/?flow=${id}`, admin: `${o}/admin/workflows/?flow=${id}` };
      },
    },
    conversations: async (f) => { await pullRecent(RETENTION_DAYS ? RETENTION_DAYS + 30 : 36500); return listConversations(f); },
  });
  const aiFetch = opts.aiFetch || globalThis.fetch;
  const ttsFetch = opts.ttsFetch || globalThis.fetch;
  const ttsCount = new Map();
  const sampleCache = new Map();
  const phraseCache = new Map();

  // Sessions are loaded once and saved once per request (see session-repo.mjs);
  // the turn service runs the conversation itself, independent of HTTP.
  // With Supabase configured, conversations are kept there and each server
  // copy works from its SQLite cache (see supabase-sessions.mjs).
  const sqliteRepo = createSqliteSessionRepo(store);
  const durable = opts.durable !== undefined ? opts.durable
    : opts.sessionRemote ? createDurableSessions({ store, sqliteRepo, remote: opts.sessionRemote })
    : supabaseConfigured(env) ? createDurableSessions({ store, sqliteRepo, remote: createSupabaseSessions(env, opts.supabaseFetch) }) : null;
  const repo = durable ? durable.repo : sqliteRepo;
  // Screen settings check: results in their own private tables (or memory locally).
  const checks = createCheckStore(env, opts);
  const CHECK_CONTENT = JSON.parse(readFileSyncCheck(pathCheck.join(ROOT_DIR_CHECK, "site", "data", "screen-check.json"), "utf8"));
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

  // Exact bytes (for signatures). Reads the stream; never touches req.body,
  // which on Vercel is a lazy parser that would consume it.
  async function readRaw(req, max) {
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw httpError(413, "Request too large"); chunks.push(c); }
    return Buffer.concat(chunks).toString("utf8");
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

  // ---------------------------------------------------- screen settings check
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const checkCtx = (c) => ({ words: CHECK_CONTENT.words, soundsLike: CHECK_CONTENT.sounds_like || {}, seed: c.id, device: c.device || {} });
  function cleanDevice(d) {
    d = d || {};
    const type = ["phone", "tablet", "computer"].includes(d.type) ? d.type : "computer";
    const os = ["ios", "android", "mac", "windows", "chromeos", "other"].includes(d.os) ? d.os : "other";
    const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(20000, Math.round(Number(v)))) : null);
    return { type, os, touchOnly: type !== "computer" || !!d.touchOnly, skipPointer: !!d.skipPointer, screenW: num(d.screenW), screenH: num(d.screenH), dpr: Number.isFinite(Number(d.dpr)) ? Math.min(8, Math.max(0.5, Number(d.dpr))) : null };
  }
  async function loadCheck(req, id) {
    const c = await checks.getCheck(id);
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!c || !tokenMatches(token, c.token_hash)) throw httpError(404, "Check not found");
    return c;
  }
  // What the person sees about their own check: results only, never other checks.
  async function checkSummary(c) {
    const st = await checks.steps(c.id);
    const plan = check.plan(c.device);
    return {
      id: c.id, code: c.code, status: c.status, device: c.device, goal: c.goal || null, settings: c.settings || {}, retake: !!c.previous_check_id,
      plan,
      steps: plan.map((setting) => {
        const s = st.find((x) => x.setting === setting);
        const done = s && s.recommended_value != null;
        return { setting, done: !!done, recommended_value: done ? s.recommended_value : null, measured_limit: done ? s.measured_limit : null, summary: done ? check.describe(setting, s) : null, flags: done ? s.flags || [] : [] };
      }),
    };
  }
  async function handleCheck(req, res, p, method, ip) {
    if (p === "/api/check/start" && method === "POST") {
      if (!limiter(ip + ":check-start", 10)) throw httpError(429, "Too many new checks at once — please wait a minute.");
      const body = await readJson(req);
      const device = cleanDevice(body.device);
      let assessment_session_id = null, previous_check_id = null, code = null;
      // Started from the Vision Assessment's button: link it, but only with
      // that conversation's own token.
      if (body.from && body.from.sessionId) {
        const s = UUID.test(String(body.from.sessionId)) ? await repo.load(String(body.from.sessionId)) : null;
        if (s && tokenMatches(String(body.from.token || ""), s.token_hash)) assessment_session_id = s.id;
      }
      if (body.code) {
        if (!limiter(ip + ":check-code", 5)) throw httpError(429, "Too many codes tried — please wait a minute.");
        const want = check.normalizeCode(body.code);
        const prev = want ? await checks.latestByCode(want) : null;
        if (!prev) throw httpError(404, "We couldn't find that code. Check the three parts (a word, a number and a word), or start a new check.");
        previous_check_id = prev.id; code = prev.code;
      }
      // A new person gets a code nobody else has.
      if (!code) {
        for (let i = 0; i < 25 && !code; i++) { const c0 = check.newCode(); if (!(await checks.latestByCode(c0))) code = c0; }
        if (!code) throw httpError(503, "Couldn't start a new check right now. Please try again.");
      }
      const token = newToken();
      const c = await checks.createCheck({ id: randomUUID(), code, token_hash: tokenHash(token), device, assessment_session_id, previous_check_id });
      store.audit("system", null, "screen_check_started", { retake: !!previous_check_id, linked: !!assessment_session_id });
      const plan = check.plan(device);
      return send(res, 200, { id: c.id, token, code: c.code, retake: !!previous_check_id, linked: !!assessment_session_id, plan, device });
    }
    const m = p.match(/^\/api\/check\/([^/]+)(?:\/(step|trial|details|finish))?$/);
    if (!m || !UUID.test(m[1])) throw httpError(404, "Not found");
    const c = await loadCheck(req, m[1]);
    const sub = m[2] || "";
    if (sub === "" && method === "GET") return send(res, 200, { check: await checkSummary(c) });
    if (method !== "POST") throw httpError(405, "Method not allowed");
    const body = await readJson(req);
    if (sub === "step" || sub === "trial") {
      const setting = String(body.setting || "");
      if (!check.plan(c.device).includes(setting)) throw httpError(400, "That test isn't part of this check.");
      if (c.status !== "started") throw httpError(409, "This check is finished.");
      const existing = (await checks.steps(c.id)).find((x) => x.setting === setting);
      let trials = existing && Array.isArray(existing.trials) ? existing.trials : [];
      let out = check.next(setting, trials, checkCtx(c));
      if (sub === "trial") {
        if (out.done) throw httpError(409, "That test is already done.");
        trials = [...trials, check.cleanTrial(setting, body.trial, out.prompt)];
        out = check.next(setting, trials, checkCtx(c));
        const step = { trials, tries: trials.length };
        if (out.done) Object.assign(step, { measured_limit: out.result.measured_limit, recommended_value: out.result.recommended_value, unit: out.result.unit, duration_ms: out.result.duration_ms, flags: out.result.flags });
        await checks.putStep(c.id, setting, step);
        if (out.done) await checks.updateCheck(c.id, { settings: { ...(c.settings || {}), ...out.result.apply } });
      }
      // The word to read is only ever sent for the trial being shown.
      return send(res, 200, { setting, done: out.done, prompt: out.done ? null : out.prompt, result: out.done ? { ...out.result, summary: check.describe(setting, out.result) } : null });
    }
    // A finished check is final: staff may already have reviewed it.
    if ((sub === "details" || sub === "finish") && c.status !== "started") throw httpError(409, "This check is finished.");
    if (sub === "details") {
      const patch = {};
      if (body.goal !== undefined) patch.goal = String(body.goal || "").trim().slice(0, 500) || null;
      if (body.device !== undefined) patch.device = cleanDevice(body.device);
      if (!Object.keys(patch).length) throw httpError(400, "Nothing to change.");
      await checks.updateCheck(c.id, patch);
      return send(res, 200, { check: await checkSummary(await checks.getCheck(c.id)) });
    }
    if (sub === "finish") {
      const consent = body.consent === true;
      const ct = body.contact || {};
      const contact = consent ? {
        first_name: String(ct.first_name || "").trim().slice(0, 80) || null,
        phone: String(ct.phone || "").replace(/[^0-9+()\- ]/g, "").trim().slice(0, 30) || null,
        email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(ct.email || "").trim()) ? String(ct.email).trim().slice(0, 200) : null,
      } : null;
      const ages = ["under_18", "18_34", "35_54", "55_64", "65_74", "75_plus"];
      const patch = {
        status: "finished", finished_at: new Date().toISOString(),
        consent_contact: consent && !!(contact && (contact.phone || contact.email)),
        contact: consent && contact && (contact.phone || contact.email) ? contact : null,
        wants_call: consent && body.wants_call === true,
        age_range: ages.includes(body.age_range) ? body.age_range : null,
        zip: /^[0-9]{5}$/.test(String(body.zip || "")) ? String(body.zip) : null,
      };
      if (body.goal !== undefined) patch.goal = String(body.goal || "").trim().slice(0, 500) || null;
      await checks.updateCheck(c.id, patch);
      store.audit("system", null, "screen_check_finished", { contact: patch.consent_contact, wants_call: patch.wants_call });
      return send(res, 200, { check: await checkSummary(await checks.getCheck(c.id)) });
    }
    throw httpError(404, "Not found");
  }

  // Legacy named staff accounts (V360_STAFF_USER) still sign in with their own
  // key; the admin password (site-settings.mjs) signs its own cookies.
  const signer = sessionSecret(env);
  async function staffUser(req) {
    const tok = parseCookies(req.headers.cookie)[STAFF_COOKIE];
    if (!tok) return null;
    const a = await settings.auth();
    if (a.secret && verifySession(a.secret, tok) === ADMIN_USER) return { username: ADMIN_USER };
    const signed = signer ? verifySession(signer, tok) : null;
    if (signed) return store.staffUserByName(signed);
    const sess = store.staffSession(tokenHash(tok));
    return sess ? store.staffUserById(sess.user_id) : null;
  }

  // The admin always needs the admin password on the hosted site.
  // V360_ADMIN_SIGNIN=off opens it only on a local machine (tests, demos).
  const adminOpen = String(env.V360_ADMIN_SIGNIN || "on").toLowerCase() === "off" && !env.V360_SERVERLESS;
  const OPEN_ADMIN = { username: "admin-open" };

  async function requireStaff(req) {
    const u = (await staffUser(req)) || (adminOpen ? OPEN_ADMIN : null);
    if (!u) { const e = httpError(401, "Sign in to the admin first."); e.code = "signin"; throw e; }
    return u;
  }

  // In open mode, show only enough of an address to tell emails apart.
  function maskEmail(to) {
    if (!to || !adminOpen) return to;
    const [user, domain] = String(to).split("@");
    return (user ? user[0] : "") + "•••@" + (domain || "");
  }

  // The admin dashboard's numbers (also served to the MCP get_dashboard tool).
  async function voiceSwitch() {
    try { return (await settings.site()).voice.elevenlabs; } catch { return false; }
  }

  // This calendar month's screen checks: how many, how long people took, and
  // how long staff spent reviewing (the "time saved" numbers).
  async function screenCheckMonth(site) {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const all = await checks.listChecks({ limit: 1000 });
    const month = all.filter((c) => c.created_at >= start);
    const finished = month.filter((c) => c.status === "finished" && c.finished_at);
    const mins = finished.map((c) => Math.max(0, (new Date(c.finished_at) - new Date(c.created_at)) / 60000));
    const reviews = await checks.reviewsSince(start);
    const reviewMs = reviews.reduce((n, r) => n + (Number(r.review_ms) || 0), 0);
    const reviewed = new Set(reviews.map((r) => r.check_id)).size;
    return {
      on: !!(site.features && site.features.screenCheck), monthStart: start,
      started: month.length, finished: finished.length,
      avgMinutes: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
      reviewed, reviewMinutes: Math.round(reviewMs / 60000), avgReviewMinutes: reviewed ? Math.round(reviewMs / 60000 / reviewed) : null,
      needsReview: all.filter((c) => c.status === "finished" && c.staff_status === "needs_review").length,
      wantsCall: all.filter((c) => c.wants_call && c.staff_status !== "closed").length,
    };
  }

  async function adminOverview() {
    const days = 30;
    const site = await settings.site().catch(() => ({ mainFlow: "referral", voice: { elevenlabs: false } }));
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const usage = store.adminUsage(since);
    const ai = aiEnabled(env);
    const perCall = Number(env.V360_COST_PER_AI_CALL_USD);
    const tts = ttsInfo(env, site.voice.elevenlabs).provider;
    const perK = Number(env.V360_COST_PER_1K_TTS_CHARS);
    return {
          generatedAt: new Date().toISOString(), days, since,
          commit: env.VERCEL_GIT_COMMIT_SHA || "local",
          storage: env.V360_STORAGE || "local", retentionDays: RETENTION_DAYS,
          mainFlow: site.mainFlow,
          signInRequired: !adminOpen,
          usage,
          costs: {
            ai: { on: ai, model: ai ? env.V360_AI_MODEL || DEFAULT_MODEL : null, calls: usage.aiCalls, perCallUsd: Number.isFinite(perCall) ? perCall : null, estimateUsd: !ai && !usage.aiCalls ? 0 : (Number.isFinite(perCall) ? +(usage.aiCalls * perCall).toFixed(4) : null) },
            tts: {
              provider: tts, keySet: ttsKeySet(env), switchOn: site.voice.elevenlabs,
              voiceId: env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID, model: env.ELEVENLABS_MODEL || DEFAULT_TTS_MODEL,
              chars: usage.ttsChars, per1kUsd: Number.isFinite(perK) ? perK : null,
              estimateUsd: !usage.ttsChars ? 0 : (Number.isFinite(perK) ? +(usage.ttsChars / 1000 * perK).toFixed(4) : null),
            },
            email: { transport: ctx.actions.transportName(), estimateUsd: ctx.actions.transportName() === "outbox" ? 0 : null },
          },
          emails: store.adminEmails(since).map((e) => ({ ...e, to: maskEmail(e.to) })),
          screenChecks: await screenCheckMonth(site).catch(() => null),
          settings: {
            corpusVersion: corpus.version, organizations: corpus.organizations.length, policyVersion: POLICY_VERSION,
            emailTransport: ctx.actions.transportName(), tts, aiUnderstanding: ai,
            storage: { ...(gh.kind === "github" ? { kind: "github", repo: gh.repo } : { kind: "local" }), data: gh.dataKind || gh.kind, sessions: store.durableKind },
            editsOn, mcpKeyRequired: !!env.V360_MCP_KEY, publishing: access.publishing, publishingNote: access.note,
          },
    };
  }

  // A named workflow must be published and pass its checks, or the link is
  // refused: a broken link must never collect details into the wrong form.
  // No name means the main workflow (falling back to referral).
  async function flowForStart(id) {
    if (id !== undefined && id !== null && id !== "") {
      const name = String(id);
      const F = /^[a-z0-9-]{1,40}$/.test(name) ? flowMeta(corpus, name) : null;
      if (!F) { const e = httpError(404, "This form isn't available."); e.code = "unknown_flow"; throw e; }
      return F;
    }
    const main = (await settings.site().catch(() => ({ mainFlow: "referral" }))).mainFlow;
    return flowMeta(corpus, main) || flowMeta(corpus, "referral");
  }

  function publicOrigin(req) {
    if (env.V360_PUBLIC_ORIGIN) return String(env.V360_PUBLIC_ORIGIN).replace(/\/+$/, "");
    if (env.V360_SERVERLESS) return "https://vision360.agenticarc.ai";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:8360";
    return (isSecure(req) ? "https://" : "http://") + host;
  }
  ctx.publicOrigin = publicOrigin;

  // Conversations for the admin list (and the connector), newest first, with filters.
  function listConversations(f = {}) {
    const open = new Map(store.allOpenReviews().map((r) => [r.session_id, r.n]));
    const all = store.listSessions().map((s) => ({ ...s, flow_title: s.flow_title || (flowMeta(corpus, s.flow_id) || {}).title || s.flow_id, openReviews: open.get(s.id) || 0, flowLive: flowRunnable(s.flow_id) }));
    // Every workflow that has conversations, including deleted ones (by the title they had).
    const flowsSeen = new Map([...corpus.flows.values()].map((F) => [F.id, { id: F.id, title: F.title, live: true }]));
    for (const s of all) if (!flowsSeen.has(s.flow_id)) flowsSeen.set(s.flow_id, { id: s.flow_id, title: s.flow_title || s.flow_id, live: false });
    const rows = all.filter((s) =>
      (!f.flow || f.flow === "all" || s.flow_id === f.flow) &&
      (!f.status || f.status === "all" || s.staff_status === f.status) &&
      (!f.stage || f.stage === "all" || (f.stage === "ended" ? s.status === "ended" || s.phase === "closed" : s.phase === f.stage)) &&
      (!f.attention || (f.attention === "yes" ? s.openReviews > 0 : s.openReviews === 0)) &&
      (!f.from || s.created_at >= f.from) &&
      (!f.to || s.created_at.slice(0, 10) <= f.to) &&
      (!f.q || s.id.startsWith(String(f.q).trim().toLowerCase())));
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 50)), offset = Math.max(0, Number(f.offset) || 0);
    const page = rows.slice(offset, offset + limit).map((s) => ({ ...s, actions: store.actionsForSession(s.id).map((a) => ({ type: a.type, status: a.status })) }));
    return { sessions: page, total: rows.length, totalAll: all.length, offset, limit, flows: [...flowsSeen.values()] };
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
      // Admin pages and their files: only for someone signed in.
      if (p === "/admin" || p.startsWith("/admin/")) {
        if (!limiter(ip + ":pages", 600)) throw httpError(429, "Too many requests — please wait a moment.");
        return serveAdmin(req, res, url, adminOpen || !!(await staffUser(req)));
      }
      const signInRoute = /^\/api\/(staff\/login|admin\/(login|setup|password))$/.test(p);
      if (!limiter(ip, signInRoute ? 10 : 120)) throw httpError(429, "Too many requests — please wait a moment.");
      if (method !== "GET") checkOrigin(req);

      if (p === "/api/health" && method === "GET") {
        return send(res, 200, {
          ok: true, commit: env.VERCEL_GIT_COMMIT_SHA || "local", corpusVersion: corpus.version, hashes: corpus.hashes, organizations: corpus.organizations.length,
          policyVersion: POLICY_VERSION, emailTransport: ctx.actions.transportName(), retentionDays: RETENTION_DAYS,
          storage: env.V360_STORAGE || "local",
          stores: { content: gh.kind, adminData: gh.dataKind || gh.kind, sessions: store.durableKind || "local" },
          ...(supabaseKeyProblem(env) ? { storeProblem: supabaseKeyProblem(env) } : {}),
          publishing: access.publishing,
          tts: { provider: ttsInfo(env, await voiceSwitch()).provider },
          aiUnderstanding: aiEnabled(env) ? { on: true, model: env.V360_AI_MODEL || DEFAULT_MODEL } : { on: false },
        });
      }

      // Fixed sample sentence for the voice picker (never arbitrary text).
      // The assistant's fixed lines (welcome, display replies), voiced only
      // when the line is listed in site/voice-phrases.js. Cached per server copy.
      if (p === "/api/tts-phrase" && method === "POST") {
        if (!ttsEnabled(env, await voiceSwitch())) throw httpError(404, "Natural voice is not set up");
        const body = await readJson(req);
        const text = String(body.text || "");
        if (!voicePhrases().allowed.has(text)) throw httpError(404, "That line isn't one the assistant says");
        const rate = [0.7, 0.85, 1, 1.2, 1.4].includes(Number(body.rate)) ? Number(body.rate) : 1;
        const key = rate + "|" + text;
        if (!phraseCache.has(key)) {
          if (phraseCache.size > 400) phraseCache.clear();
          phraseCache.set(key, await synthesize(env, ttsFetch, { text, rate }));
          store.audit("system", null, "tts", { chars: text.length });
        }
        const audio = phraseCache.get(key);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
        return res.end(audio);
      }
      if (p === "/api/tts-sample" && method === "GET") {
        if (!ttsEnabled(env, await voiceSwitch())) throw httpError(404, "Natural voice is not set up");
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
        const F = await flowForStart(body.flow);
        const token = newToken();
        const { session, turn } = await turns.start({ mode: body.mode, tokenHash: tokenHash(token), flow: { id: F.id, title: F.title, version: F.version } });
        ctx.markDirty(session.id);
        return send(res, 201, { sessionId: session.id, token, flow: { id: F.id, title: F.title }, ...turnResponse(session, turn) });
      }
      // Which workflow a public page runs: /f/<id>, or the main one for the home page.
      if (p === "/api/assistant" && method === "GET") {
        const F = await flowForStart(url.searchParams.get("flow") || undefined);
        const main = (await settings.site()).mainFlow;
        return send(res, 200, { flow: { id: F.id, title: F.title, description: F.description, intro: F.flow.intro || null, privacy: F.flow.privacy_notice || null, routing: F.routing, main: F.id === main } });
      }
      // QR code for a workflow's public link (/f/<id>), for posters and flyers.
      let qm = p.match(/^\/api\/qr\/([a-z0-9-]{1,40})\.svg$/);
      if (qm && method === "GET") {
        const F = flowMeta(corpus, qm[1]);
        if (!F) throw httpError(404, "No published workflow called " + qm[1]);
        const svg = qrSvg(`${publicOrigin(req)}/f/${F.id}`, { title: F.title });
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="vision360-${F.id}-qr.svg"` });
        return res.end(svg);
      }
      if (p === "/api/site" && method === "GET") {
        const main = (await settings.site()).mainFlow;
        const origin = publicOrigin(req);
        const features = (await settings.site()).features;
        return send(res, 200, { mainFlow: flowRunnable(main) ? main : "referral", features, flows: [...corpus.flows.values()].map((F) => ({ id: F.id, title: F.title, main: F.id === main, url: `${origin}/f/${F.id}` })) });
      }

      // Screen Settings Check: switched off unless an admin turns it on in
      // Settings. The browser shows the tests; every answer comes here and
      // the server decides what's next (server/lib/screen-check.mjs).
      if (p === "/api/check" || p.startsWith("/api/check/")) {
        if (!(await settings.site()).features.screenCheck) throw httpError(404, "Not available.");
        return await handleCheck(req, res, p, method, ip);
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
            if (!ttsEnabled(env, await voiceSwitch())) throw httpError(404, "Natural voice is not set up");
            const last = s.state.lastAssistant;
            if (!last || String(body.turnId || "") !== last.turnId) throw httpError(409, "That reply is no longer current");
            const n = (ttsCount.get(id) || 0) + 1;
            ttsCount.set(id, n);
            if (n > 300) throw httpError(429, "Voice limit reached for this session");
            const text = last.speech || last.text;
            const audio = await synthesize(env, ttsFetch, { text, rate: body.rate });
            store.audit("system", id, "tts", { chars: Math.min(String(text).length, 2500) });
            res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
            return res.end(audio);
          }
          if (sub === "end") return send(res, 200, await turns.end(s));
          throw httpError(404, "Not found");
        });
      }

      // ---------------- admin sign-in ---------------------------------------
      if (p === "/api/admin/me" && method === "GET") {
        const a = await settings.auth();
        const u = await staffUser(req);
        return send(res, 200, { signedIn: !!u || adminOpen, open: adminOpen && !u, setupNeeded: !a.source, canSetUp: !a.source && !env.V360_SERVERLESS && settings.privateData });
      }
      if (p === "/api/admin/login" && method === "POST") {
        requireSameSite(req);
        const body = await readJson(req);
        const a = await settings.auth();
        if (!a.source) throw httpError(503, "No admin password is set up on this site yet.");
        if (!verifyPassword(String(body.password || ""), a.passwordHash)) {
          store.audit("admin", null, "login_failed", null);
          throw httpError(401, "That password isn't right.");
        }
        store.audit("admin", null, "login", null);
        return send(res, 200, { ok: true }, { "Set-Cookie": staffCookie(signSession(a.secret, ADMIN_USER), isSecure(req)) });
      }
      if (p === "/api/admin/logout" && method === "POST") {
        return send(res, 200, { ok: true }, { "Set-Cookie": clearStaffCookie(isSecure(req)) });
      }
      // First password on a local machine only; the hosted site is set up by the owner.
      if (p === "/api/admin/setup" && method === "POST") {
        requireSameSite(req);
        const a = await settings.auth();
        if (a.source || env.V360_SERVERLESS) throw httpError(403, "An admin password is already set up. Change it in Settings.");
        const body = await readJson(req);
        await settings.setPassword(body.password);
        const b = await settings.auth();
        store.audit("admin", null, "password_set", null);
        return send(res, 200, { ok: true }, { "Set-Cookie": staffCookie(signSession(b.secret, ADMIN_USER), isSecure(req)) });
      }
      if (p === "/api/admin/password" && method === "POST") {
        await requireStaff(req);
        requireSameSite(req);
        const body = await readJson(req);
        const a = await settings.auth();
        if (a.source && !verifyPassword(String(body.current || ""), a.passwordHash)) throw httpError(401, "The current password isn't right.");
        if (String(body.password || "") !== String(body.confirm || "")) throw httpError(400, "The two new passwords don't match.");
        const out = await settings.setPassword(body.password);
        const b = await settings.auth();
        store.audit("admin", null, "password_changed", null);
        await requests.logChange({ title: "Admin password changed", summary: "The admin password was changed. Everyone else was signed out.", kind: "app" }).catch(() => {});
        return send(res, 200, { ok: true, changedAt: out.changedAt }, { "Set-Cookie": staffCookie(signSession(b.secret, ADMIN_USER), isSecure(req)) });
      }
      // ---------------- site settings (main workflow, voice switch) ----------
      if (p === "/api/admin/settings" && (method === "GET" || method === "PUT")) {
        const u = await requireStaff(req);
        if (method === "GET") return send(res, 200, { settings: await settings.site(), voiceKeySet: ttsKeySet(env) });
        requireSameSite(req);
        if (!limiter(ip + ":write", 30)) throw httpError(429, "Too many changes at once — please wait a minute.");
        const body = await readJson(req);
        const patch = {};
        if (body.mainFlow !== undefined) {
          const id = String(body.mainFlow);
          if (!flowRunnable(id)) throw httpError(400, "Only a published workflow can be the main one.");
          patch.mainFlow = id;
        }
        if (body.voice && body.voice.elevenlabs !== undefined) {
          if (body.voice.elevenlabs && !ttsKeySet(env)) throw httpError(400, "Add ELEVENLABS_API_KEY in Vercel first, then switch natural voice on.");
          patch.voice = { elevenlabs: !!body.voice.elevenlabs };
        }
        if (body.features && body.features.screenCheck !== undefined) patch.features = { screenCheck: body.features.screenCheck === true };
        if (!Object.keys(patch).length) throw httpError(400, "Nothing to change.");
        await settings.updateSite(patch);
        store.audit("staff:" + u.username, null, "settings_changed", patch);
        const what = patch.mainFlow ? `Main workflow is now "${patch.mainFlow}".`
          : patch.voice ? `Natural voice (ElevenLabs) switched ${patch.voice.elevenlabs ? "on" : "off"}.`
          : `Screen settings check switched ${patch.features.screenCheck ? "on" : "off"}.`;
        const title = patch.mainFlow ? "Main workflow changed" : patch.voice ? "Voice setting changed" : "Feature switch changed";
        await requests.logChange({ title, summary: what, kind: "app" }).catch(() => {});
        return send(res, 200, { settings: await settings.site() });
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
        const u = await staffUser(req);
        if (u) return send(res, 200, { username: u.username, signInRequired: !adminOpen });
        return adminOpen ? send(res, 200, { username: OPEN_ADMIN.username, open: true, signInRequired: false }) : send(res, 401, { error: "Not signed in" });
      }
      // ---------------- requests and change log ------------------------
      if (p === "/api/requests" || p.startsWith("/api/requests/") || p === "/api/changelog") {
        await requireStaff(req);
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
        await requireStaff(req);
        if (method !== "GET") {
          requireSameSite(req);
          if (!editsOn) throw httpError(403, "Editing is turned off on this site (V360_FLOW_EDITS=off).");
          if (!access.writesAllowed) throw httpError(503, access.note);
          if (!limiter(ip + ":write", 30)) throw httpError(429, "Too many changes at once — please wait a minute.");
        }
        if (p === "/api/flows" && method === "GET") {
          const main = (await settings.site()).mainFlow;
          const origin = publicOrigin(req);
          const list = (await flows.list()).map((f) => ({ ...f, main: f.id === main, live: flowRunnable(f.id), url: flowRunnable(f.id) ? `${origin}/f/${f.id}` : null, qr: flowRunnable(f.id) ? `/api/qr/${f.id}.svg` : null }));
          return send(res, 200, { flows: list, mainFlow: main, storage: gh.kind, editsOn, publishing: access.publishing, keyRequired: access.keyRequired });
        }
        if (p === "/api/flows" && method === "POST") {
          const u = await requireStaff(req);
          const b = await readJson(req);
          return send(res, 201, await flows.create({ id: b.id, title: b.title, description: b.description, copyFrom: b.copyFrom || null, author: b.author || u.username }));
        }
        const fm = p.match(/^\/api\/flows\/([a-z0-9-]{1,40})(?:\/(draft|check|publish|revert|versions)(?:\/([0-9a-z-]{7,40}))?)?$/);
        if (fm) {
          const [, id, action, arg] = fm;
          if (!action && method === "GET") return send(res, 200, await flows.get(id));
          if (!action && method === "DELETE") {
            const b = await readJson(req);
            if (b.confirm !== "DELETE") throw httpError(400, "Type DELETE to confirm.");
            const m = (await flows.registry()).find((x) => x.id === id);
            if (m && m.status !== "draft") requirePublishKey(req);
            const out = await flows.remove(id, { name: b.name, mainFlow: (await settings.site()).mainFlow });
            return send(res, 200, { ...out, live: out.state === "removed" ? "Removed." : liveMessage(out) });
          }
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
        await requireStaff(req);
        await pullRecent();
        return send(res, 200, await adminOverview());
      }
      if (p === "/api/staff/sessions" && method === "GET") {
        await requireStaff(req);
        await pullRecent(RETENTION_DAYS ? RETENTION_DAYS + 30 : 36500);
        return send(res, 200, listConversations(Object.fromEntries(url.searchParams)));
      }
      // Permanently delete conversations. The admin types DELETE to confirm;
      // the server checks it too.
      if (p === "/api/admin/conversations/delete" && method === "POST") {
        const u = await requireStaff(req);
        requireSameSite(req);
        if (!limiter(ip + ":write", 30)) throw httpError(429, "Too many changes at once — please wait a minute.");
        const body = await readJson(req, 64 * 1024);
        if (body.confirm !== "DELETE") throw httpError(400, "Type DELETE to confirm.");
        const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
        if (!ids.length) throw httpError(400, "Choose at least one conversation.");
        if (ids.length > 200) throw httpError(400, "Delete at most 200 conversations at a time.");
        if (ids.some((id) => !/^[0-9a-f-]{36}$/.test(id))) throw httpError(400, "Invalid conversation id.");
        const remote = durable ? await durable.remove(ids) : 0;
        const local = store.deleteSessions(ids);
        for (const id of ids) dirty.delete(id);
        store.audit("staff:" + u.username, null, "conversations_deleted", { count: Math.max(local, remote) });
        await requests.logChange({ title: "Conversations deleted", summary: `${Math.max(local, remote)} conversation(s) were permanently deleted.`, kind: "content" }).catch(() => {});
        return send(res, 200, { ok: true, deleted: Math.max(local, remote) });
      }
      // ---------------- screen settings check: staff side -------------
      if (p === "/api/admin/checks" && method === "GET") {
        await requireStaff(req);
        const want = url.searchParams.get("filter") || "all";
        const rows = (await checks.listChecks({ limit: 1000 })).map((c) => {
          const st = c.steps || [];
          const minutes = c.finished_at ? Math.max(0, Math.round((new Date(c.finished_at) - new Date(c.created_at)) / 60000)) : null;
          return {
            id: c.id, code: c.code, created_at: c.created_at, finished_at: c.finished_at, status: c.status, staff_status: c.staff_status,
            device: check.deviceWords(c.device), goal: c.goal ? String(c.goal).slice(0, 120) : null, wants_call: !!c.wants_call, contact: !!c.consent_contact,
            retake: !!c.previous_check_id, linked: !!c.assessment_session_id, attention: check.needsAttention(st), minutes,
            settings: Object.fromEntries(st.filter((x) => x.recommended_value != null).map((x) => [x.setting, x.recommended_value])),
          };
        });
        const keep = {
          all: () => true,
          needs_review: (r) => r.status === "finished" && r.staff_status === "needs_review",
          unfinished: (r) => r.status !== "finished",
          low: (r) => r.attention,
          call: (r) => r.wants_call,
          retakes: (r) => r.retake,
          linked: (r) => r.linked,
        }[want] || (() => true);
        const out = rows.filter(keep);
        const finished = rows.filter((r) => r.minutes != null);
        return send(res, 200, { checks: out, total: rows.length, counts: { needs_review: rows.filter((r) => r.status === "finished" && r.staff_status === "needs_review").length, unfinished: rows.filter((r) => r.status !== "finished").length, call: rows.filter((r) => r.wants_call).length }, avgMinutes: finished.length ? Math.round(finished.reduce((n, r) => n + r.minutes, 0) / finished.length) : null });
      }
      if (p === "/api/admin/checks/delete" && method === "POST") {
        const u = await requireStaff(req);
        requireSameSite(req);
        if (!limiter(ip + ":write", 30)) throw httpError(429, "Too many changes at once — please wait a minute.");
        const body = await readJson(req, 64 * 1024);
        if (body.confirm !== "DELETE") throw httpError(400, "Type DELETE to confirm.");
        const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
        if (!ids.length) throw httpError(400, "Choose at least one check.");
        if (ids.length > 200) throw httpError(400, "Delete at most 200 checks at a time.");
        if (ids.some((id) => !UUID.test(id))) throw httpError(400, "Invalid check id.");
        const n = await checks.remove(ids);
        store.audit("staff:" + u.username, null, "screen_checks_deleted", { count: n });
        await requests.logChange({ title: "Screen checks deleted", summary: `${n} screen settings check(s) were permanently deleted.`, kind: "content" }).catch(() => {});
        return send(res, 200, { ok: true, deleted: n });
      }
      m = p.match(/^\/api\/admin\/checks\/([^/]+)(?:\/(review))?$/);
      if (m && !UUID.test(m[1])) throw httpError(404, "Check not found");
      if (m) {
        const u = await requireStaff(req);
        const c = await checks.getCheck(m[1]);
        if (!c) throw httpError(404, "Check not found");
        if (!m[2] && method === "GET") {
          const [steps, reviews, sameCode] = await Promise.all([checks.steps(c.id), checks.reviews(c.id), checks.byCode(c.code)]);
          // This person's other checks: those joined to this one by retakes
          // (previous_check_id), not just any check that shares the code.
          const byId = new Map(sameCode.map((x) => [x.id, x]));
          const linked = new Set([c.id]);
          for (let grew = true; grew;) {
            grew = false;
            for (const x of sameCode) {
              if (linked.has(x.id)) { if (x.previous_check_id && byId.has(x.previous_check_id) && !linked.has(x.previous_check_id)) { linked.add(x.previous_check_id); grew = true; } }
              else if (x.previous_check_id && linked.has(x.previous_check_id)) { linked.add(x.id); grew = true; }
            }
          }
          const history = sameCode.filter((x) => linked.has(x.id));
          const others = await Promise.all(history.filter((h) => h.id !== c.id).map(async (h) => ({ id: h.id, created_at: h.created_at, status: h.status, steps: (await checks.steps(h.id)).map((s) => ({ setting: s.setting, recommended_value: s.recommended_value, measured_limit: s.measured_limit, summary: check.describe(s.setting, s) })) })));
          const { token_hash, ...safe } = c;
          return send(res, 200, {
            check: { ...safe, device_words: check.deviceWords(c.device) },
            steps: check.SETTINGS.map((setting) => steps.find((s) => s.setting === setting)).filter(Boolean).map((s) => ({ ...s, name: check.prettySetting(s.setting), summary: check.describe(s.setting, s), flag_words: check.flagWords(s.flags) })),
            reviews, history: others, attention: check.needsAttention(steps),
            case_note: check.caseNote(c, steps, reviews[0] || null),
          });
        }
        if (m[2] === "review" && method === "POST") {
          requireSameSite(req);
          if (!limiter(ip + ":write", 30)) throw httpError(429, "Too many changes at once — please wait a minute.");
          const body = await readJson(req, 64 * 1024);
          const steps = await checks.steps(c.id);
          const decisions = {};
          for (const s of steps) {
            const d = body.decisions && body.decisions[s.setting];
            if (!d) continue;
            if (!check.DECISIONS.includes(d.decision)) throw httpError(400, `Choose accept, edit or reject for ${check.prettySetting(s.setting)}.`);
            if (d.decision === "edit" && !String(d.value || "").trim()) throw httpError(400, `Say what ${check.prettySetting(s.setting)} should be changed to.`);
            decisions[s.setting] = { decision: d.decision, value: d.decision === "edit" ? String(d.value).trim().slice(0, 200) : null };
          }
          const review = {
            reviewer: u.username, decisions,
            notes: String(body.notes || "").trim().slice(0, 4000) || null,
            next_steps: String(body.next_steps || "").trim().slice(0, 2000) || null,
            review_ms: Math.max(0, Math.min(24 * 3600 * 1000, Number(body.review_ms) || 0)) || null,
            created_at: new Date().toISOString(),
          };
          review.case_note = check.caseNote(c, steps, review);
          const saved = await checks.addReview(c.id, review);
          const status = ["needs_review", "reviewed", "closed"].includes(body.staff_status) ? body.staff_status : "reviewed";
          await checks.updateCheck(c.id, { staff_status: status });
          store.audit("staff:" + u.username, null, "screen_check_reviewed", { decisions: Object.keys(decisions).length });
          return send(res, 200, { review: saved, case_note: review.case_note, staff_status: status });
        }
        throw httpError(405, "Method not allowed");
      }
      m = p.match(/^\/api\/staff\/sessions\/([0-9a-f-]{36})(?:\/(status))?$/);
      if (m) {
        const u = await requireStaff(req);
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
          flow: { id: s.flow_id || "referral", title: s.flow_title || (flowMeta(corpus, s.flow_id || "referral") || {}).title || s.flow_id, version: s.flow_version || null, live: flowRunnable(s.flow_id || "referral") },
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
        const u = await requireStaff(req);
        requireSameSite(req);
        const act = store.getAction(m[1]);
        if (act) ctx.markDirty(act.session_id);
        const ok = ctx.actions.retry(m[1]);
        store.audit("staff:" + u.username, null, "action_retry", { actionId: m[1], ok });
        if (ok) await processQueueSoon();
        return send(res, ok ? 200 : 409, { ok });
      }

      // ---------------- email delivery reports (Resend webhook) -------------
      if (p === "/api/webhooks/email" && method === "POST") {
        if (!env.RESEND_WEBHOOK_SECRET) throw httpError(503, "Email delivery reports aren't set up (RESEND_WEBHOOK_SECRET).");
        const raw = await readRaw(req, 64 * 1024);
        if (!verifyWebhook(env.RESEND_WEBHOOK_SECRET, req.headers, raw)) throw httpError(401, "Bad signature");
        let evt = null;
        try { evt = JSON.parse(raw); } catch { throw httpError(400, "Invalid JSON"); }
        const d = deliveryEvent(evt);
        if (!d) return send(res, 200, { ok: true, ignored: true });
        if (durable) await durable.pullByReceipt(d.receipt);
        const sessionId = ctx.actions.recordDelivery(d.receipt, d.outcome, d.detail);
        ctx.markDirty(sessionId);
        return send(res, 200, { ok: true, matched: !!sessionId });
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
