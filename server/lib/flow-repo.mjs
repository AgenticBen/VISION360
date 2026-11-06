// Workflows: drafts, checks, publish, versions and revert, all on GitHub
// (see gh-store.mjs). A published version is a commit on main that changes the
// workflow file; Vercel redeploys from main, so what the assistant runs stays
// file-based. Drafts live on the admin-data branch.
//
// Publishing the referral workflow also updates, in the same commit:
//   - data/corpus.lock.json (that file's hash and the question counts), and
//   - tests/fixtures/golden-personas.json (the expected suggestions),
// so the repository's own checks stay green. The editor shows the impact
// (who gets different suggestions) before anyone publishes.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DATA_BRANCH, StoreConflict } from "./gh-store.mjs";
import { checkFlow, MAX_FLOW_BYTES } from "./flow-check.mjs";
import { impact, routeWith } from "./golden-route.mjs";

const REGISTRY = JSON.parse(readFileSync(new URL("../../site/data/flows/index.json", import.meta.url), "utf8")).flows;
const LOCK = "data/corpus.lock.json";
const GOLDEN = "tests/fixtures/golden-personas.json";

function bad(message, status = 400, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}
const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
const text = (obj) => JSON.stringify(obj, null, 2) + "\n";
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

export function createFlowRepo({ gh, corpus, requests }) {
  function meta(id) {
    const m = REGISTRY.find((f) => f.id === id);
    if (!m) throw bad("No workflow called " + id, 404);
    return m;
  }
  const draftPath = (id) => `drafts/${id}.json`;

  async function published(id) {
    const m = meta(id);
    const cur = await gh.readText("main", m.file);
    if (!cur) throw bad("The published copy of " + m.title + " is missing.", 500);
    return { flow: JSON.parse(cur.text), sha: cur.sha };
  }

  async function versions(id) {
    const commits = await gh.listCommits("main", meta(id).file, 100);
    // Offline (no GitHub token) the file on disk is v1 and local publishes follow.
    const local = gh.kind === "local";
    const n = commits.length + (local ? 1 : 0);
    const out = commits.map((c, i) => {
      const firstLine = c.message.split("\n")[0];
      const by = (c.message.match(/^Published by (.+?) from the VISION360 editor/m) || [])[1];
      return { version: n - i, sha: c.sha, date: c.date, author: by || c.author, title: firstLine, note: (c.message.match(/^Note: (.+)$/m) || [])[1] || "" };
    });
    if (local) out.push({ version: 1, sha: "working-copy", date: null, author: "", title: "The copy shipped with this site", note: "" });
    return out;
  }

  async function readDraft(id) {
    const cur = await gh.readText(DATA_BRANCH, draftPath(id));
    if (!cur) return null;
    const d = JSON.parse(cur.text);
    return d && d.flow ? { ...d, _sha: cur.sha } : null;
  }

  function check(id, flow) {
    const m = meta(id);
    return checkFlow(flow, { organizations: corpus.organizations, routing: !!m.routing });
  }

  async function goldenFixture() {
    const cur = await gh.readText("main", GOLDEN);
    return cur ? JSON.parse(cur.text) : null;
  }

  async function impactOf(id, flow) {
    const m = meta(id);
    if (!m.routing) return null;
    const fx = await goldenFixture();
    if (!fx) return null;
    const pub = await published(id);
    const personas = fx.personas.map((p) => ({ ...p, label: p.description || p.id }));
    return impact(corpus, pub.flow, flow, personas);
  }

  async function commitVersion(id, flow, { name, note, title, revertedFrom }) {
    const m = meta(id);
    const result = check(id, flow);
    if (!result.ok) throw bad("This workflow doesn't pass its checks yet, so it can't be published.", 422, { code: "checks_failed", details: result });
    const files = [{ path: m.file, text: text(flow) }];
    let imp = null;
    if (m.routing) {
      imp = await impactOf(id, flow);
      // Keep the repo's own guards in step with the new rules.
      const lockCur = await gh.readText("main", LOCK);
      if (lockCur) {
        const lock = JSON.parse(lockCur.text);
        lock.files[m.file] = sha256(files[0].text);
        lock.counts.questions = flow.questions.length;
        lock.counts.handoffs = (flow.handoffs || []).length;
        files.push({ path: LOCK, text: text(lock) });
      }
      const fx = await goldenFixture();
      if (fx) {
        for (const p of fx.personas) {
          const r = routeWith(corpus, flow, p);
          p.expected = { matches: r.matches, handoffs: r.handoffs };
        }
        files.push({ path: GOLDEN, text: text(fx) });
      }
    }
    const prior = await versions(id);
    const version = (prior.length ? prior[0].version : 0) + 1;
    const who = clean(name, 60) || "Someone";
    const why = clean(note, 300);
    const head = title || `${m.title} v${version}${why ? ": " + why : ""}`;
    const lines = [head.slice(0, 120), "", `Published by ${who} from the VISION360 editor.`];
    if (why) lines.push(`Note: ${why}`);
    if (revertedFrom) lines.push(`Reverted to the content of v${revertedFrom}.`);
    if (imp) lines.push(`Impact: ${imp.changed} of ${imp.personas} test people get different suggestions.`);
    const { sha } = await gh.commitFiles("main", files, lines.join("\n"));
    // Clear the draft: it is now the published version.
    try { const d = await gh.readText(DATA_BRANCH, draftPath(id)); if (d) await gh.writeText(DATA_BRANCH, draftPath(id), text({ flow: null, cleared_at: new Date().toISOString() }), d.sha, `Clear draft: ${id}`); } catch (e) { /* a stale draft is harmless */ }
    if (requests) {
      await requests.logChange({
        title: revertedFrom ? `${m.title} reverted to v${revertedFrom} (now v${version})` : `${m.title} v${version} published`,
        summary: [why, imp ? `${imp.changed} of ${imp.personas} test people get different suggestions.` : ""].filter(Boolean).join(" "),
        kind: "workflow", ref: sha, highlight: { page: "/admin/workflows/edit/?flow=" + id, target: "versions" },
      }).catch(() => {});
    }
    return { version, sha, impact: imp, checks: result };
  }

  return {
    registry: REGISTRY,

    async list() {
      return Promise.all(REGISTRY.map(async (m) => {
        const [pub, vs, draft] = await Promise.all([published(m.id), versions(m.id).catch(() => []), readDraft(m.id).catch(() => null)]);
        return {
          id: m.id, title: m.title, description: m.description, usedBy: m.usedBy, routing: !!m.routing, file: m.file,
          sections: pub.flow.blocks.length, questions: pub.flow.questions.length, followUps: pub.flow.questions.filter((q) => q.ask_if).length,
          version: vs.length || 1, lastPublished: vs[0] || null,
          draft: draft ? { updated_at: draft.updated_at, author: draft.author, draftRevision: draft.draftRevision } : null,
        };
      }));
    },

    async get(id) {
      const m = meta(id);
      const [pub, vs, draft] = await Promise.all([published(id), versions(id), readDraft(id)]);
      return { meta: m, published: pub.flow, version: vs.length || 1, versions: vs, draft: draft ? { flow: draft.flow, draftRevision: draft.draftRevision, updated_at: draft.updated_at, author: draft.author, base_version: draft.base_version } : null };
    },

    async versionAt(id, sha) {
      const m = meta(id);
      if (sha !== "working-copy" && !/^[0-9a-f]{7,40}$/.test(sha)) throw bad("Invalid version id");
      const cur = await gh.readText(sha, m.file);
      if (!cur) throw bad("That version wasn't found", 404);
      return JSON.parse(cur.text);
    },

    async saveDraft(id, { flow, draftRevision, author }) {
      meta(id);
      if (!flow || typeof flow !== "object") throw bad("Send the whole workflow as `flow`.");
      if (Buffer.byteLength(JSON.stringify(flow)) > MAX_FLOW_BYTES) throw bad("The workflow is too large.");
      const cur = await gh.readText(DATA_BRANCH, draftPath(id));
      const prev = cur ? JSON.parse(cur.text) : null;
      const prevRev = prev && prev.flow ? prev.draftRevision || 0 : 0;
      if (draftRevision != null && Number(draftRevision) !== prevRev) throw bad("Someone else changed this draft. Reload to see their changes.", 409, { code: "stale", currentRevision: prevRev });
      const vs = await versions(id).catch(() => []);
      const next = { flow, draftRevision: prevRev + 1, updated_at: new Date().toISOString(), author: clean(author, 60) || "Someone", base_version: (prev && prev.flow && prev.base_version) || vs.length || 1 };
      try {
        await gh.writeText(DATA_BRANCH, draftPath(id), text(next), cur ? cur.sha : null, `Draft: ${meta(id).title} (rev ${next.draftRevision}) by ${next.author}`);
      } catch (e) {
        if (e instanceof StoreConflict) throw bad("Someone else changed this draft. Reload to see their changes.", 409, { code: "stale" });
        throw e;
      }
      return { draftRevision: next.draftRevision, updated_at: next.updated_at, checks: check(id, flow) };
    },

    async discardDraft(id) {
      const cur = await gh.readText(DATA_BRANCH, draftPath(id));
      if (cur) await gh.writeText(DATA_BRANCH, draftPath(id), text({ flow: null, cleared_at: new Date().toISOString() }), cur.sha, `Discard draft: ${id}`);
      return { ok: true };
    },

    async check(id, flow) {
      const target = flow || (await readDraft(id) || {}).flow || (await published(id)).flow;
      return { checks: check(id, target), impact: await impactOf(id, target) };
    },

    async publish(id, { name, note }) {
      const d = await readDraft(id);
      if (!d) throw bad("There's no draft to publish. Make a change first.", 409);
      return commitVersion(id, d.flow, { name, note });
    },

    async revert(id, { version, sha, name, note }) {
      const vs = await versions(id);
      const v = vs.find((x) => (sha && x.sha.startsWith(sha)) || (version != null && x.version === Number(version)));
      if (!v) throw bad("That version wasn't found.", 404);
      const flow = await this.versionAt(id, v.sha);
      return commitVersion(id, flow, { name, note: note || `Revert to v${v.version}`, revertedFrom: v.version, title: `${meta(id).title}: revert to v${v.version}` });
    },
  };
}
