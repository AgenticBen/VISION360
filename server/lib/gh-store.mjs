// Admin storage on GitHub (no database). Two adapters, one interface:
//
//   readText(ref, path)                 -> { text, sha } | null
//   writeText(branch, path, text, sha, message)   conditional on sha; 409 when stale
//   updateJson(branch, path, fn, message, fallback) read-modify-write, one retry
//   commitFiles(branch, files[{path, text}], message) -> { sha }   one commit, many files
//   listCommits(branch, path, limit)    -> [{ sha, message, author, date }] newest first
//
// GitHub adapter: the REST API with a fine-grained token (V360_GITHUB_TOKEN) that
// can only read and write AgenticBen/VISION360 contents. Published workflows are
// commits on main; drafts, requests and the change log live on the admin-data
// branch. Local adapter: the same thing in a folder, for dev and tests.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const DATA_BRANCH = "admin-data";

export class StoreConflict extends Error {
  constructor(message = "Someone else saved this just now. Reload and try again.") {
    super(message);
    this.status = 409;
    this.code = "stale";
  }
}

export function createGhStore(env = process.env, opts = {}) {
  if (opts.local || !env.V360_GITHUB_TOKEN) return createLocalStore(opts.dir || env.V360_ADMIN_STORE_DIR, opts);
  return createGithubStore(env, opts.fetch || globalThis.fetch);
}

async function updateJsonWith(store, branch, file, fn, message, fallback) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await store.readText(branch, file);
    const data = cur ? JSON.parse(cur.text) : structuredClone(fallback);
    const result = await fn(data);
    try {
      await store.writeText(branch, file, JSON.stringify(data, null, 2) + "\n", cur ? cur.sha : null, message);
      return result === undefined ? data : result;
    } catch (e) {
      if (!(e instanceof StoreConflict) || attempt === 2) throw e;
    }
  }
}

// ---------------------------------------------------------------- GitHub
export function createGithubStore(env, fetchImpl) {
  const repo = env.V360_GITHUB_REPO || "AgenticBen/VISION360";
  const base = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${env.V360_GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vision360-admin",
  };

  async function gh(method, url, body, extra = {}) {
    const res = await fetchImpl(url.startsWith("http") ? url : base + url, {
      method, headers: { ...headers, ...extra, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text };
  }

  function fail(r, what) {
    const e = new Error(`GitHub ${what} failed (${r.status}): ${(r.json && r.json.message) || r.text.slice(0, 200)}`);
    e.status = 502;
    return e;
  }

  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

  async function ensureBranch(branch) {
    const r = await gh("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
    if (r.status === 200) return;
    const main = await gh("GET", `/git/ref/heads/main`);
    if (main.status !== 200) throw fail(main, "read main");
    const c = await gh("POST", `/git/refs`, { ref: `refs/heads/${branch}`, sha: main.json.object.sha });
    if (c.status !== 201 && c.status !== 422) throw fail(c, "create branch");
  }

  const store = {
    kind: "github",
    repo,
    async readText(ref, file) {
      const r = await gh("GET", `/contents/${enc(file)}?ref=${encodeURIComponent(ref)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw fail(r, "read " + file);
      if (r.json.encoding === "base64" && r.json.content) {
        return { text: Buffer.from(r.json.content, "base64").toString("utf8"), sha: r.json.sha };
      }
      // Files over 1 MB come back without content; fetch the raw bytes.
      const raw = await gh("GET", `/contents/${enc(file)}?ref=${encodeURIComponent(ref)}`, null, { Accept: "application/vnd.github.raw+json" });
      if (raw.status !== 200) throw fail(raw, "read raw " + file);
      return { text: raw.text, sha: r.json.sha };
    },
    async writeText(branch, file, text, sha, message) {
      const body = { message, content: Buffer.from(text, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) };
      let r = await gh("PUT", `/contents/${enc(file)}`, body);
      if (r.status === 404 && /branch/i.test(r.text)) { await ensureBranch(branch); r = await gh("PUT", `/contents/${enc(file)}`, body); }
      if (r.status === 409 || (r.status === 422 && /sha/i.test(r.text))) throw new StoreConflict();
      if (r.status !== 200 && r.status !== 201) throw fail(r, "write " + file);
      return { sha: r.json.content.sha, commit: r.json.commit.sha };
    },
    updateJson(branch, file, fn, message, fallback) { return updateJsonWith(store, branch, file, fn, message, fallback); },
    async commitFiles(branch, files, message) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const ref = await gh("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
        if (ref.status !== 200) throw fail(ref, "read " + branch);
        const parent = ref.json.object.sha;
        const pc = await gh("GET", `/git/commits/${parent}`);
        if (pc.status !== 200) throw fail(pc, "read commit");
        const tree = await gh("POST", `/git/trees`, {
          base_tree: pc.json.tree.sha,
          tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.text })),
        });
        if (tree.status !== 201) throw fail(tree, "create tree");
        const commit = await gh("POST", `/git/commits`, { message, tree: tree.json.sha, parents: [parent] });
        if (commit.status !== 201) throw fail(commit, "create commit");
        const upd = await gh("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.json.sha, force: false });
        if (upd.status === 200) return { sha: commit.json.sha };
        if (upd.status !== 422 || attempt === 1) throw fail(upd, "update " + branch);
      }
    },
    // Publishing: one commit on a new publish/* branch plus a pull request
    // into main. The repo's "publish" workflow runs the checks and merges it
    // when they pass; Vercel then deploys main.
    async proposeToMain(files, message, { branch, title, body }) {
      const ref = await gh("GET", `/git/ref/heads/main`);
      if (ref.status !== 200) throw fail(ref, "read main");
      const parent = ref.json.object.sha;
      const pc = await gh("GET", `/git/commits/${parent}`);
      if (pc.status !== 200) throw fail(pc, "read commit");
      const tree = await gh("POST", `/git/trees`, { base_tree: pc.json.tree.sha, tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.text })) });
      if (tree.status !== 201) throw fail(tree, "create tree");
      const commit = await gh("POST", `/git/commits`, { message, tree: tree.json.sha, parents: [parent] });
      if (commit.status !== 201) throw fail(commit, "create commit");
      const mk = await gh("POST", `/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.json.sha });
      if (mk.status !== 201) throw fail(mk, "create branch " + branch);
      const pr = await gh("POST", `/pulls`, { title, head: branch, base: "main", body, maintainer_can_modify: true });
      if (pr.status !== 201) throw fail(pr, "open pull request");
      return { sha: commit.json.sha, branch, pr: pr.json.number, url: pr.json.html_url };
    },
    async pullState(number) {
      const r = await gh("GET", `/pulls/${Number(number)}`);
      if (r.status !== 200) throw fail(r, "read pull request");
      return { state: r.json.state, merged: !!r.json.merged, mergeSha: r.json.merge_commit_sha, url: r.json.html_url };
    },
    // Is commit `sha` part of `running` (the commit this server copy runs)?
    async includes(sha, running) {
      if (!running || running === "local") return false;
      if (running.startsWith(sha) || sha.startsWith(running)) return true;
      const r = await gh("GET", `/compare/${sha}...${running}`);
      if (r.status !== 200) return false;
      return r.json.status === "ahead" || r.json.status === "identical";
    },
    async listCommits(branch, file, limit = 100) {
      const r = await gh("GET", `/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(file)}&per_page=${Math.min(limit, 100)}`);
      if (r.status !== 200) throw fail(r, "list commits");
      return r.json.map((c) => ({ sha: c.sha, message: c.commit.message, author: (c.commit.author && c.commit.author.name) || "", date: c.commit.author && c.commit.author.date }));
    },
  };
  return store;
}

// ----------------------------------------------------------------- local
// Branches are folders; main falls back to the working copy so "published"
// starts as what is on disk. Commits keep full file text so versions and
// revert work offline.
export function createLocalStore(dir, opts = {}) {
  const root = path.resolve(dir || ".data/admin-store");
  const repoRoot = path.resolve(opts.repoRoot || ".");
  const logFile = path.join(root, "commits.json");
  mkdirSync(root, { recursive: true });
  const sha = (t) => createHash("sha1").update(t).digest("hex");
  const readLog = () => (existsSync(logFile) ? JSON.parse(readFileSync(logFile, "utf8")) : []);
  const writeLog = (log) => writeFileSync(logFile, JSON.stringify(log));

  function latest(branch, file) {
    const log = readLog();
    for (let i = log.length - 1; i >= 0; i--) {
      const c = log[i];
      if (c.branch === branch && Object.prototype.hasOwnProperty.call(c.files, file)) return c.files[file];
    }
    return undefined;
  }

  function commit(branch, files, message) {
    const log = readLog();
    const c = { sha: sha(randomUUID()), branch, message, author: "VISION360 editor", date: new Date().toISOString(), files };
    log.push(c);
    writeLog(log);
    return c;
  }

  const store = {
    kind: "local",
    repo: "local",
    root,
    async readText(ref, file) {
      if (ref === "working-copy") {
        const p = path.join(repoRoot, file);
        if (!existsSync(p)) return null;
        const text = readFileSync(p, "utf8");
        return { text, sha: sha(text) };
      }
      const log = readLog();
      const byCommit = log.find((c) => c.sha === ref);
      if (byCommit) {
        // State of `file` as of that commit on its branch.
        const idx = log.indexOf(byCommit);
        for (let i = idx; i >= 0; i--) if (log[i].branch === byCommit.branch && Object.prototype.hasOwnProperty.call(log[i].files, file)) return { text: log[i].files[file], sha: sha(log[i].files[file]) };
        ref = byCommit.branch;
      }
      const t = latest(ref, file);
      if (t !== undefined) return t === null ? null : { text: t, sha: sha(t) };
      if (ref === "main") {
        const p = path.join(repoRoot, file);
        if (existsSync(p)) { const text = readFileSync(p, "utf8"); return { text, sha: sha(text) }; }
      }
      return null;
    },
    async writeText(branch, file, text, expectedSha, message) {
      const cur = await store.readText(branch, file);
      if ((cur ? cur.sha : null) !== (expectedSha || null)) throw new StoreConflict();
      const c = commit(branch, { [file]: text }, message);
      return { sha: sha(text), commit: c.sha };
    },
    updateJson(branch, file, fn, message, fallback) { return updateJsonWith(store, branch, file, fn, message, fallback); },
    async commitFiles(branch, files, message) {
      const map = {};
      for (const f of files) map[f.path] = f.text;
      return { sha: commit(branch, map, message).sha };
    },
    async listCommits(branch, file, limit = 100) {
      return readLog().filter((c) => c.branch === branch && Object.prototype.hasOwnProperty.call(c.files, file))
        .reverse().slice(0, limit).map((c) => ({ sha: c.sha, message: c.message, author: c.author, date: c.date }));
    },
  };
  return store;
}
