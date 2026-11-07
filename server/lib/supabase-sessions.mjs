// Conversations kept in Supabase (table session_bundles), with each server
// copy working from its local SQLite cache (store.mjs).
//
//   load    pull the conversation into the cache if the database has a
//           different version, then read it from the cache
//   save    write the cache, then save to the database ONLY if the database
//           still has the version this turn loaded; otherwise the turn is
//           refused with 409 and the browser retries it
//   flush   after other changes (emails sent, staff status, turn replay
//           cache), copy the conversation to the database
//
// Talks to PostgREST with fetch and the server-only key. No client library.
import { SessionConflict } from "./session-repo.mjs";

// The publishable (public) key can't read these tables, so it never counts as
// configured: the site falls back to temporary storage and health says why.
export function supabaseKeyProblem(env) {
  const key = String(env.V360_SUPABASE_SERVICE_KEY || "");
  if (!env.V360_SUPABASE_URL || !key) return null;
  if (key.startsWith("sb_publishable_")) return "V360_SUPABASE_SERVICE_KEY is the publishable key; use the secret key (sb_secret_…).";
  return null;
}

export function supabaseConfigured(env) {
  return !!(env.V360_SUPABASE_URL && env.V360_SUPABASE_SERVICE_KEY) && !supabaseKeyProblem(env);
}

export function createSupabaseSessions(env, fetchImpl = globalThis.fetch) {
  const base = String(env.V360_SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1";
  const key = env.V360_SUPABASE_SERVICE_KEY;
  const headers = (extra = {}) => ({ apikey: key, ...(/^eyJ/.test(String(key)) ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...extra });
  async function req(method, url, body, extra) {
    const res = await fetchImpl(base + url, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status >= 400) {
      const e = new Error(`Supabase ${method} ${url.split("?")[0]} failed (${res.status}): ${(json && json.message) || text.slice(0, 160)}`);
      e.status = 502;
      e.pgCode = json && json.code;
      throw e;
    }
    return json;
  }
  const row = (bundle) => {
    const s = bundle.session;
    const reviews = bundle.rows.staff_reviews || [];
    const due = (bundle.rows.actions || []).filter((a) => a.status === "queued" || a.status === "retrying").map((a) => a.next_attempt_at).sort()[0] || null;
    return {
      id: s.id, version: s.version, created_at: s.created_at, updated_at: s.updated_at, expires_at: s.expires_at,
      status: s.status, staff_status: s.staff_status,
      open_followups: reviews.filter((r) => r.status !== "closed").length + (s.staff_status === "needs_follow_up" ? 1 : 0),
      next_action_at: due, bundle,
      email_receipts: (bundle.rows.actions || []).map((a) => a.provider_receipt).filter(Boolean),
    };
  };
  return {
    kind: "supabase",
    async get(id) {
      const r = await req("GET", `/session_bundles?id=eq.${id}&select=version,bundle`);
      return r && r.length ? r[0] : null;
    },
    async versions({ since, due } = {}) {
      const f = due ? `next_action_at=lte.${encodeURIComponent(new Date().toISOString())}` : `created_at=gte.${encodeURIComponent(since)}`;
      return (await req("GET", `/session_bundles?${f}&select=id,version&order=created_at.desc&limit=2000`)) || [];
    },
    // expected: the version this copy loaded (null = brand new conversation).
    async put(bundle, expected) {
      const body = row(bundle);
      if (expected === null) {
        try { await req("POST", `/session_bundles`, body, { Prefer: "return=minimal" }); return true; }
        catch (e) { if (e.pgCode === "23505") return false; throw e; }
      }
      const guard = expected === undefined ? "" : `&version=eq.${expected}`;
      const r = await req("PATCH", `/session_bundles?id=eq.${body.id}${guard}`, body, { Prefer: "return=representation" });
      if (r && r.length) return true;
      if (expected === undefined) { await req("POST", `/session_bundles`, body, { Prefer: "return=minimal,resolution=merge-duplicates" }); return true; }
      return false;
    },
    async purge() {
      return req("POST", `/rpc/purge_expired_sessions`, {});
    },
    async findByReceipt(receipt) {
      const r = await req("GET", `/session_bundles?email_receipts=cs.${encodeURIComponent("{" + JSON.stringify(String(receipt)) + "}")}&select=id&limit=1`);
      return r && r.length ? r[0].id : null;
    },
  };
}

// Wraps the SQLite repository and store with the database copy.
export function createDurableSessions({ store, sqliteRepo, remote, log = console }) {
  const remoteVersion = new Map(); // id -> version the database has, as far as this copy knows

  async function pull(id) {
    const r = await remote.get(id);
    if (!r) return false;
    const local = store.localSessionVersions().get(id);
    if (local !== r.version) store.importSession(r.bundle);
    remoteVersion.set(id, r.version);
    return true;
  }

  async function pullMany(list) {
    const local = store.localSessionVersions();
    for (const { id, version } of list) {
      if (local.get(id) !== version) await pull(id);
      else remoteVersion.set(id, version);
    }
  }

  // Copies one conversation to the database. guarded=true refuses to
  // overwrite a newer version saved by another server copy.
  async function push(id, guarded) {
    const bundle = store.exportSession(id);
    if (!bundle) return;
    const known = remoteVersion.has(id) ? remoteVersion.get(id) : null;
    if (guarded) {
      if (!(await remote.put(bundle, known))) {
        await pull(id).catch(() => {});
        throw new SessionConflict();
      }
    } else if (known === null) {
      if (!(await remote.put(bundle, null))) await remote.put(bundle, undefined);
    } else {
      await remote.put(bundle, undefined);
    }
    remoteVersion.set(id, bundle.session.version);
  }

  const repo = {
    async load(id) {
      try { await pull(id); } catch (e) { log.error("supabase load", e.message); throw e; }
      return sqliteRepo.load(id);
    },
    async save(s) {
      await sqliteRepo.save(s);
      await push(s.id, true);
    },
  };

  return {
    kind: "supabase",
    repo,
    pull,
    async pullRecent(since) { await pullMany(await remote.versions({ since })); },
    async pullDue() { const list = await remote.versions({ due: true }); await pullMany(list); return list.length; },
    async flush(ids) {
      for (const id of new Set(ids.filter(Boolean))) {
        try { await push(id, false); } catch (e) { log.error("supabase flush", id, e.message); }
      }
    },
    async purge() { return remote.purge(); },
    // Loads the conversation that sent this email into the cache.
    async pullByReceipt(receipt) {
      const id = remote.findByReceipt ? await remote.findByReceipt(receipt) : null;
      if (id) await pull(id);
      return id;
    },
  };
}
