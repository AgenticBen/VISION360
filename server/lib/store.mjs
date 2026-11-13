// Private, durable storage for demo sessions, answers, actions and staff.
//
// Separate from the public directory: nothing here is ever written under
// site/, and the public feedback flow never touches it. Uses Node's built-in
// SQLite so the local demo needs no external database. Full conversation
// transcripts are NOT stored — only structured answers, their revisions and
// confirmation events, plus the last assistant turn so "repeat" works.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT_DIR } from "./corpus.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 0,
  corpus_version TEXT NOT NULL,
  notice_ack_at TEXT,
  staff_status TEXT NOT NULL DEFAULT 'pending',
  channels TEXT NOT NULL DEFAULT '[]',
  state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS answers (
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  value_json TEXT,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  confirmed_revision INTEGER,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, question_id)
);
CREATE TABLE IF NOT EXISTS answer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  question_id TEXT,
  event TEXT NOT NULL,
  value_json TEXT,
  kind TEXT,
  revision INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  corpus_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recommendation_id TEXT,
  method TEXT NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  authorization_id TEXT,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  provider TEXT,
  provider_receipt TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  contact_json TEXT,
  callback_ok INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  owner TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_cache (
  session_id TEXT NOT NULL,
  client_turn_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, client_turn_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  session_id TEXT,
  event TEXT NOT NULL,
  detail_json TEXT
);
`;

const SESSION_TABLES = ["answers", "answer_events", "recommendations", "authorizations", "actions", "staff_reviews", "turn_cache", "audit_events"];

// Conversations are kept until an admin deletes them (0 = keep). Set
// V360_RETENTION_DAYS to a number of days to delete them automatically instead.
export const RETENTION_DAYS = Math.max(0, Number(process.env.V360_RETENTION_DAYS || 0) || 0);
export const KEEP_UNTIL_DELETED = "9999-12-31T00:00:00.000Z";

export function nowIso() {
  return new Date().toISOString();
}

export function openStore(file) {
  const dbPath = file || process.env.V360_DB_PATH || path.join(ROOT_DIR, ".data", "v360-demo.sqlite");
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  // Migration: the exact words for an answer ("26", "Gaston County") for display.
  try { db.exec("ALTER TABLE answers ADD COLUMN detail TEXT"); } catch (e) { /* already there */ }
  // Migration: a save counter, so two saves of the same session can't silently overwrite each other.
  try { db.exec("ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* already there */ }
  // Migration: which workflow a conversation ran, fixed when it starts (so it
  // still lists and filters after that workflow is deleted).
  try { db.exec("ALTER TABLE sessions ADD COLUMN flow_id TEXT NOT NULL DEFAULT 'referral'"); } catch (e) { /* already there */ }
  try { db.exec("ALTER TABLE sessions ADD COLUMN flow_title TEXT"); } catch (e) { /* already there */ }
  try { db.exec("ALTER TABLE sessions ADD COLUMN flow_version TEXT"); } catch (e) { /* already there */ }
  const q = (sql) => db.prepare(sql);
  const bumpSessionOf = (actionId) =>
    q(`UPDATE sessions SET version=version+1 WHERE id=(SELECT session_id FROM actions WHERE id=?)`).run(actionId);

  const cols = new Map();
  const columnsOf = (tbl) => {
    if (!cols.has(tbl)) cols.set(tbl, new Set(db.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name)));
    return cols.get(tbl);
  };
  // Inserts only columns this table has (bundles from older code still load).
  const insertRow = (tbl, row) => {
    const known = columnsOf(tbl);
    const keys = Object.keys(row).filter((k) => known.has(k));
    q(`INSERT INTO ${tbl} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k] === undefined ? null : row[k]));
  };

  const store = {
    db,
    path: dbPath,
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try { const r = fn(); db.exec("COMMIT"); return r; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },

    // sessions ---------------------------------------------------------
    createSession({ tokenHash, corpusVersion, state, flow }) {
      const id = randomUUID();
      const t = nowIso();
      const exp = RETENTION_DAYS ? new Date(Date.now() + RETENTION_DAYS * 864e5).toISOString() : KEEP_UNTIL_DELETED;
      const f = flow || { id: "referral", title: "Referral finder", version: null };
      q(`INSERT INTO sessions (id, token_hash, created_at, updated_at, expires_at, corpus_version, state_json, flow_id, flow_title, flow_version) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, tokenHash, t, t, exp, corpusVersion, JSON.stringify(state || {}), f.id, f.title || null, f.version || null);
      return id;
    },
    getSession(id) {
      const r = q(`SELECT * FROM sessions WHERE id = ?`).get(id);
      if (!r) return null;
      return { ...r, state: JSON.parse(r.state_json), channels: JSON.parse(r.channels) };
    },
    // Saves only if nobody else saved this session since it was loaded
    // (same save counter). Returns rows changed: 0 means another save won.
    saveSessionGuarded(s, expectedVersion) {
      return q(`UPDATE sessions SET updated_at=?, status=?, revision=?, notice_ack_at=?, channels=?, state_json=?, version=version+1 WHERE id=? AND version=?`)
        .run(nowIso(), s.status, s.revision, s.notice_ack_at || null, JSON.stringify(s.channels || []), JSON.stringify(s.state || {}), s.id, expectedVersion).changes;
    },
    // Staff changes only their own column, never the conversation state.
    setStaffStatus(id, staffStatus) {
      q(`UPDATE sessions SET staff_status=?, updated_at=? WHERE id=?`).run(staffStatus, nowIso(), id);
    },
    listSessions(limit = 5000) {
      return q(`SELECT id, created_at, updated_at, status, revision, staff_status, channels, corpus_version, state_json, flow_id, flow_title, flow_version FROM sessions ORDER BY updated_at DESC LIMIT ?`).all(limit)
        .map((r) => ({ ...r, channels: JSON.parse(r.channels), phase: JSON.parse(r.state_json).phase, state_json: undefined }));
    },

    // answers ----------------------------------------------------------
    getAnswers(sessionId) {
      return q(`SELECT * FROM answers WHERE session_id = ?`).all(sessionId)
        .map((r) => ({ questionId: r.question_id, value: r.value_json === null ? null : JSON.parse(r.value_json), kind: r.kind, revision: r.revision, confirmedRevision: r.confirmed_revision, source: r.source, detail: r.detail || null, updatedAt: r.updated_at }));
    },
    putAnswer(sessionId, a) {
      q(`INSERT INTO answers (session_id, question_id, value_json, kind, revision, confirmed_revision, source, detail, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, question_id) DO UPDATE SET value_json=excluded.value_json, kind=excluded.kind, revision=excluded.revision, confirmed_revision=excluded.confirmed_revision, source=excluded.source, detail=excluded.detail, updated_at=excluded.updated_at`)
        .run(sessionId, a.questionId, a.value === undefined || a.value === null ? null : JSON.stringify(a.value), a.kind, a.revision, a.confirmedRevision ?? null, a.source, a.detail || null, nowIso());
    },
    deleteAnswer(sessionId, questionId) {
      q(`DELETE FROM answers WHERE session_id=? AND question_id=?`).run(sessionId, questionId);
    },
    deleteAllAnswers(sessionId) {
      q(`DELETE FROM answers WHERE session_id=?`).run(sessionId);
    },
    confirmAllAnswers(sessionId, revision) {
      q(`UPDATE answers SET confirmed_revision=? WHERE session_id=?`).run(revision, sessionId);
    },
    answerEvent(sessionId, questionId, event, value, kind, revision) {
      q(`INSERT INTO answer_events (session_id, question_id, event, value_json, kind, revision, at) VALUES (?,?,?,?,?,?,?)`)
        .run(sessionId, questionId, event, value === undefined ? null : JSON.stringify(value), kind || null, revision, nowIso());
    },
    answerEvents(sessionId) {
      return q(`SELECT question_id, event, value_json, kind, revision, at FROM answer_events WHERE session_id=? ORDER BY id`).all(sessionId);
    },

    // recommendations ----------------------------------------------------
    saveRecommendation(sessionId, revision, corpusVersion, result, id = randomUUID()) {
      q(`UPDATE recommendations SET stale=1 WHERE session_id=?`).run(sessionId);
      q(`INSERT INTO recommendations (id, session_id, revision, corpus_version, result_json, created_at) VALUES (?,?,?,?,?,?)`)
        .run(id, sessionId, revision, corpusVersion, JSON.stringify(result), nowIso());
      return id;
    },
    currentRecommendation(sessionId) {
      const r = q(`SELECT * FROM recommendations WHERE session_id=? AND stale=0 ORDER BY created_at DESC LIMIT 1`).get(sessionId);
      return r ? { ...r, result: JSON.parse(r.result_json) } : null;
    },
    markRecommendationsStale(sessionId) {
      return q(`UPDATE recommendations SET stale=1 WHERE session_id=? AND stale=0`).run(sessionId).changes;
    },
    recommendations(sessionId) {
      return q(`SELECT id, revision, corpus_version, stale, created_at, result_json FROM recommendations WHERE session_id=? ORDER BY created_at`).all(sessionId)
        .map((r) => ({ ...r, result: JSON.parse(r.result_json), result_json: undefined }));
    },

    // authorizations / actions -----------------------------------------
    saveAuthorization(a) {
      const id = a.id || randomUUID();
      q(`INSERT INTO authorizations (id, session_id, action_type, destination, payload_hash, purpose, revision, recommendation_id, method, granted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, a.sessionId, a.actionType, a.destination, a.payloadHash, a.purpose, a.revision, a.recommendationId || null, a.method, nowIso());
      return id;
    },
    getAuthorization(id) {
      return q(`SELECT * FROM authorizations WHERE id=?`).get(id) || null;
    },
    // Insert-or-return-existing on the idempotency key: a retry never creates a second action.
    enqueueAction(a) {
      const existing = q(`SELECT * FROM actions WHERE idempotency_key=?`).get(a.idempotencyKey);
      if (existing) return { action: existing, duplicate: true };
      const id = a.id || randomUUID();
      const t = nowIso();
      q(`INSERT INTO actions (id, session_id, type, status, idempotency_key, authorization_id, revision, payload_json, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, a.sessionId, a.type, a.status || "queued", a.idempotencyKey, a.authorizationId || null, a.revision, JSON.stringify(a.payload), t, t, t);
      return { action: q(`SELECT * FROM actions WHERE id=?`).get(id), duplicate: false };
    },
    getAction(id) {
      return q(`SELECT * FROM actions WHERE id=?`).get(id) || null;
    },
    actionsForSession(sessionId) {
      return q(`SELECT id, type, status, attempts, provider, provider_receipt, error, revision, created_at, updated_at FROM actions WHERE session_id=? ORDER BY created_at`).all(sessionId);
    },
    // Same as actionsForSession plus the idempotency key (for a unit of work).
    actionRowsForSession(sessionId) {
      return q(`SELECT id, type, status, attempts, provider, provider_receipt, error, revision, idempotency_key, created_at, updated_at FROM actions WHERE session_id=? ORDER BY created_at`).all(sessionId);
    },
    // Claim one due action with a lease so two workers never run it at once.
    claimDueAction(leaseMs = 60000) {
      const t = nowIso();
      const row = q(`SELECT * FROM actions WHERE status IN ('queued','retrying') AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at LIMIT 1`).get(t, t);
      if (!row) return null;
      const lease = new Date(Date.now() + leaseMs).toISOString();
      const ch = q(`UPDATE actions SET status='running', lease_until=?, attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('queued','retrying')`).run(lease, t, row.id).changes;
      if (ch) bumpSessionOf(row.id);
      return ch ? q(`SELECT * FROM actions WHERE id=?`).get(row.id) : null;
    },
    // Used by the email worker. Any change it makes also bumps the session's
    // save counter, so a turn that loaded the session before the change is
    // refused (409) and retried on fresh data instead of saving stale state.
    updateAction(id, fields) {
      const cols = Object.keys(fields);
      q(`UPDATE actions SET ${cols.map((c) => c + "=?").join(", ")}, updated_at=? WHERE id=?`).run(...cols.map((c) => fields[c]), nowIso(), id);
      bumpSessionOf(id);
    },
    cancelActions(sessionId, types, reason) {
      let n = 0;
      for (const t of types) {
        n += Number(q(`UPDATE actions SET status='cancelled', error=?, updated_at=? WHERE session_id=? AND type=? AND status IN ('prepared','awaiting_authorization','queued','retrying')`)
          .run(reason || "Cancelled by the person", nowIso(), sessionId, t).changes || 0);
      }
      return n;
    },
    adminOutreach(sinceIso, limit = 500) {
      return q(`SELECT id, session_id, type, status, attempts, provider, error, payload_json, created_at, updated_at FROM actions WHERE type LIKE 'org_%' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(sinceIso, limit)
        .map((r) => { const p = JSON.parse(r.payload_json || "{}"); return { ...r, payload_json: undefined, orgId: p.orgId || null, orgName: p.orgName || null, channel: p.channel || null, to: p.to || null, intendedTo: p.intendedTo || null, demoRedirect: !!p.demoRedirect }; });
    },
    cancelStaleActions(sessionId, revision) {
      return q(`UPDATE actions SET status='cancelled', error='Answers changed after this was authorised', updated_at=? WHERE session_id=? AND revision < ? AND status IN ('prepared','awaiting_authorization','queued','retrying')`)
        .run(nowIso(), sessionId, revision).changes;
    },

    // staff reviews -------------------------------------------------------
    createStaffReview(sessionId, reason, contact, callbackOk, id = randomUUID()) {
      const t = nowIso();
      q(`INSERT INTO staff_reviews (id, session_id, reason, contact_json, callback_ok, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, sessionId, reason, contact ? JSON.stringify(contact) : null, callbackOk ? 1 : 0, t, t);
      return id;
    },
    staffReviews(sessionId) {
      return q(`SELECT * FROM staff_reviews WHERE session_id=? ORDER BY created_at`).all(sessionId)
        .map((r) => ({ ...r, contact: r.contact_json ? JSON.parse(r.contact_json) : null, contact_json: undefined }));
    },
    allOpenReviews() {
      return q(`SELECT session_id, COUNT(*) n FROM staff_reviews WHERE status != 'closed' GROUP BY session_id`).all();
    },

    // admin overview: read-only counts and lists for the last N days ---------
    adminUsage(sinceIso) {
      const one = (sql, ...a) => Number(Object.values(q(sql).get(...a) || { n: 0 })[0] || 0);
      const sessions = q(`SELECT id, created_at, channels FROM sessions WHERE created_at >= ?`).all(sinceIso);
      const byDay = {};
      const byMode = { voice: 0, text: 0 };
      for (const r of sessions) {
        const day = r.created_at.slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
        const first = (JSON.parse(r.channels || "[]")[0] || {}).mode;
        if (first === "voice" || first === "text") byMode[first] += 1;
      }
      return {
        conversations: sessions.length,
        byMode,
        byDay,
        completed: one(`SELECT COUNT(DISTINCT session_id) n FROM audit_events WHERE event='session_completed' AND at >= ?`, sinceIso),
        summariesConfirmed: one(`SELECT COUNT(DISTINCT session_id) n FROM audit_events WHERE event='recap_confirmed' AND at >= ?`, sinceIso),
        staffRequests: one(`SELECT COUNT(*) n FROM staff_reviews WHERE created_at >= ?`, sinceIso),
        aiCalls: one(`SELECT COUNT(*) n FROM audit_events WHERE event IN ('ai_interpret','ai_extract','ai_email') AND at >= ?`, sinceIso),
        ttsChars: one(`SELECT COALESCE(SUM(json_extract(detail_json, '$.chars')), 0) n FROM audit_events WHERE event='tts' AND at >= ?`, sinceIso),
      };
    },
    adminEmails(sinceIso, limit = 500) {
      return q(`SELECT id, session_id, type, status, attempts, provider, error, payload_json, created_at, updated_at FROM actions WHERE type='email_plan' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(sinceIso, limit)
        .map((r) => { const p = JSON.parse(r.payload_json || "{}"); return { ...r, payload_json: undefined, to: p.to || null, subject: p.subject || null }; });
    },

    // staff auth ------------------------------------------------------------
    createStaffUser(username, passwordHash) {
      const id = randomUUID();
      q(`INSERT INTO staff_users (id, username, password_hash, created_at) VALUES (?,?,?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, disabled=0`)
        .run(id, username, passwordHash, nowIso());
      return q(`SELECT id FROM staff_users WHERE username=?`).get(username).id;
    },
    staffUserByName(username) {
      return q(`SELECT * FROM staff_users WHERE username=? AND disabled=0`).get(username) || null;
    },
    staffUserById(id) {
      return q(`SELECT id, username FROM staff_users WHERE id=? AND disabled=0`).get(id) || null;
    },
    createStaffSession(tokenHash, userId, hours = 8) {
      q(`INSERT INTO staff_sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)`)
        .run(tokenHash, userId, nowIso(), new Date(Date.now() + hours * 36e5).toISOString());
    },
    staffSession(tokenHash) {
      return q(`SELECT * FROM staff_sessions WHERE token_hash=? AND expires_at > ?`).get(tokenHash, nowIso()) || null;
    },
    deleteStaffSession(tokenHash) {
      q(`DELETE FROM staff_sessions WHERE token_hash=?`).run(tokenHash);
    },

    // turn cache: makes client retries of the same turn idempotent -----------
    cachedTurn(sessionId, clientTurnId) {
      const r = q(`SELECT response_json FROM turn_cache WHERE session_id=? AND client_turn_id=?`).get(sessionId, clientTurnId);
      return r ? JSON.parse(r.response_json) : null;
    },
    cacheTurn(sessionId, clientTurnId, response) {
      q(`INSERT OR REPLACE INTO turn_cache (session_id, client_turn_id, response_json, at) VALUES (?,?,?,?)`).run(sessionId, clientTurnId, JSON.stringify(response), nowIso());
      // keep only the most recent few
      q(`DELETE FROM turn_cache WHERE session_id=? AND client_turn_id NOT IN (SELECT client_turn_id FROM turn_cache WHERE session_id=? ORDER BY at DESC LIMIT 5)`).run(sessionId, sessionId);
    },

    audit(actor, sessionId, event, detail) {
      q(`INSERT INTO audit_events (at, actor, session_id, event, detail_json) VALUES (?,?,?,?,?)`).run(nowIso(), actor, sessionId || null, event, detail ? JSON.stringify(detail) : null);
    },
    auditFor(sessionId) {
      return q(`SELECT at, actor, event, detail_json FROM audit_events WHERE session_id=? ORDER BY id`).all(sessionId);
    },

    // Durable copy: everything about one conversation as plain rows, so a
    // hosted database can keep it and another server copy can load it.
    exportSession(id) {
      const session = q(`SELECT * FROM sessions WHERE id=?`).get(id);
      if (!session) return null;
      const rows = {};
      for (const tbl of SESSION_TABLES) {
        const order = tbl === "answer_events" || tbl === "audit_events" ? " ORDER BY id" : "";
        rows[tbl] = q(`SELECT * FROM ${tbl} WHERE session_id=?${order}`).all(id).map((r) => {
          const o = { ...r };
          if (tbl === "answer_events" || tbl === "audit_events") delete o.id; // local row numbers
          return o;
        });
      }
      return { format: 1, session: { ...session }, rows };
    },
    // Replaces this copy's rows for the conversation with the given bundle.
    importSession(bundle) {
      const id = bundle.session.id;
      store.tx(() => {
        for (const tbl of SESSION_TABLES) q(`DELETE FROM ${tbl} WHERE session_id=?`).run(id);
        q(`DELETE FROM sessions WHERE id=?`).run(id);
        insertRow("sessions", bundle.session);
        for (const tbl of SESSION_TABLES) for (const r of (bundle.rows && bundle.rows[tbl]) || []) insertRow(tbl, r);
      });
    },
    actionByReceipt(receipt) {
      return q(`SELECT id, session_id, status FROM actions WHERE provider_receipt=?`).get(receipt) || null;
    },
    localSessionVersions() {
      return new Map(q(`SELECT id, version FROM sessions`).all().map((r) => [r.id, r.version]));
    },

    // Permanently removes conversations and everything recorded about them.
    deleteSessions(ids) {
      let n = 0;
      store.tx(() => {
        for (const id of ids) {
          for (const tbl of SESSION_TABLES) q(`DELETE FROM ${tbl} WHERE session_id=?`).run(id);
          n += q(`DELETE FROM sessions WHERE id=?`).run(id).changes;
        }
      });
      return n;
    },

    // Retention: only conversations with a real expiry date (V360_RETENTION_DAYS) are removed.
    purgeExpired() {
      const t = nowIso();
      const ids = q(`SELECT id FROM sessions WHERE expires_at < ?`).all(t).map((r) => r.id);
      for (const id of ids) {
        for (const tbl of SESSION_TABLES) {
          q(`DELETE FROM ${tbl} WHERE session_id=?`).run(id);
        }
        q(`DELETE FROM sessions WHERE id=?`).run(id);
      }
      q(`DELETE FROM staff_sessions WHERE expires_at < ?`).run(t);
      return ids.length;
    },
  };
  return store;
}
