// Admin documents in Supabase (prepared for when the Lions Services project
// exists). Same interface as gh-store.mjs for the admin-data branch: drafts,
// change requests and the change log. Published workflow versions stay as git
// commits on main, so a split store sends `main` to GitHub and everything
// else here. Talks to PostgREST with fetch: no client library.
//
//   V360_SUPABASE_URL           https://<ref>.supabase.co
//   V360_SUPABASE_SERVICE_KEY   service role key (server only, never the browser)
import { createHash } from "node:crypto";
import { StoreConflict, DATA_BRANCH, createGhStore } from "./gh-store.mjs";

const sha1 = (t) => createHash("sha1").update(t).digest("hex");

export function createSupabaseDocStore(env, fetchImpl = globalThis.fetch) {
  const base = String(env.V360_SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1";
  const key = env.V360_SUPABASE_SERVICE_KEY;
  // Legacy service_role keys are JWTs and also go in Authorization; the newer
  // sb_secret_ keys go in apikey only.
  const headers = (extra = {}) => ({ apikey: key, ...(/^eyJ/.test(String(key)) ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...extra });
  const q = (branch, file) => `branch=eq.${encodeURIComponent(branch)}&path=eq.${encodeURIComponent(file)}`;

  async function req(method, url, body, extra) {
    const res = await fetchImpl(base + url, { method, headers: headers(extra), body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text };
  }
  function fail(r, what) {
    const e = new Error(`Supabase ${what} failed (${r.status}): ${(r.json && r.json.message) || r.text.slice(0, 200)}`);
    e.status = 502;
    return e;
  }

  const store = {
    kind: "supabase",
    async readText(branch, file) {
      const r = await req("GET", `/admin_documents?${q(branch, file)}&select=body,sha`);
      if (r.status !== 200) throw fail(r, "read " + file);
      return r.json.length ? { text: r.json[0].body, sha: r.json[0].sha } : null;
    },
    async writeText(branch, file, text, expectedSha, message) {
      const sha = sha1(text);
      const msg = { "x-v360-message": String(message || "").slice(0, 200) };
      if (!expectedSha) {
        const r = await req("POST", "/admin_documents", { branch, path: file, body: text, sha }, { Prefer: "return=minimal", ...msg });
        if (r.status === 409) throw new StoreConflict();
        if (r.status !== 201) throw fail(r, "create " + file);
        return { sha };
      }
      const r = await req("PATCH", `/admin_documents?${q(branch, file)}&sha=eq.${encodeURIComponent(expectedSha)}`, { body: text, sha, updated_at: new Date().toISOString() }, { Prefer: "return=representation", ...msg });
      if (r.status !== 200) throw fail(r, "update " + file);
      if (!r.json.length) throw new StoreConflict();
      return { sha };
    },
    async listCommits(branch, file, limit = 100) {
      const r = await req("GET", `/admin_document_history?${q(branch, file)}&select=id,sha,message,written_at&order=written_at.desc&limit=${Math.min(limit, 100)}`);
      if (r.status !== 200) throw fail(r, "history " + file);
      return r.json.map((h) => ({ sha: h.sha, message: h.message || "", author: "", date: h.written_at }));
    },
  };
  return store;
}

// main (published workflows) -> GitHub or local; admin-data -> Supabase.
export function createSplitStore(mainStore, dataStore) {
  const pick = (ref) => (ref === DATA_BRANCH ? dataStore : mainStore);
  const store = {
    kind: mainStore.kind,
    dataKind: dataStore.kind,
    repo: mainStore.repo,
    root: mainStore.root,
    readText: (ref, file) => pick(ref).readText(ref, file),
    writeText: (branch, file, text, sha, message) => pick(branch).writeText(branch, file, text, sha, message),
    updateJson: async (branch, file, fn, message, fallback) => {
      const s = pick(branch);
      if (s.updateJson) return s.updateJson(branch, file, fn, message, fallback);
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await s.readText(branch, file);
        const data = cur ? JSON.parse(cur.text) : structuredClone(fallback);
        const result = await fn(data);
        try { await s.writeText(branch, file, JSON.stringify(data, null, 2) + "\n", cur ? cur.sha : null, message); return result === undefined ? data : result; }
        catch (e) { if (!(e instanceof StoreConflict) || attempt === 2) throw e; }
      }
    },
    commitFiles: (branch, files, message) => mainStore.commitFiles(branch, files, message),
    ...(mainStore.proposeToMain ? {
      proposeToMain: (files, message, o) => mainStore.proposeToMain(files, message, o),
      pullState: (n) => mainStore.pullState(n),
      includes: (sha, running) => mainStore.includes(sha, running),
    } : {}),
    listCommits: (branch, file, limit) => pick(branch).listCommits(branch, file, limit),
  };
  return store;
}

// The admin store the app uses: Supabase for admin-data when configured.
export function createAdminStore(env = process.env, opts = {}) {
  const main = createGhStore(env, opts);
  if (env.V360_SUPABASE_URL && env.V360_SUPABASE_SERVICE_KEY) return createSplitStore(main, createSupabaseDocStore(env, opts.fetch));
  return main;
}
