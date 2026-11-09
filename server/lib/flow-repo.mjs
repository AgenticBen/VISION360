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
import { createHash } from "node:crypto";
import { DATA_BRANCH, StoreConflict } from "./gh-store.mjs";
import { checkFlow, MAX_FLOW_BYTES, GROUPS, groupOf } from "./flow-check.mjs";
import { impact, routeWith } from "./golden-route.mjs";

// The registry (site/data/flows/index.json on main) lists every workflow.
// A workflow created in the admin or over MCP waits in PENDING (admin data)
// until its first publish adds it to the registry. Deleting a workflow marks
// it "retired": it disappears from the admin, links and the assistant, but its
// file stays so old conversations still show their answers.
const REGISTRY_FILE = "site/data/flows/index.json";
const PENDING = "drafts/registry-pending.json";
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

function prBody({ who, why, imp, revertedFrom, version, title }) {
  const out = [`**${title} v${version}**, published by ${who} from the VISION360 editor.`, ""];
  if (why) out.push(`Note: ${why}`, "");
  if (revertedFrom) out.push(`Reverts the content to v${revertedFrom}.`, "");
  if (imp) {
    out.push(`**Routing impact:** ${imp.changed} of ${imp.personas} test people get different suggestions.`, "");
    for (const r of (imp.rows || imp.changes || []).filter((x) => x.changed).slice(0, 12)) {
      out.push(`- ${r.label || r.id}: ${(r.before || []).join(", ") || "none"} → ${(r.after || []).join(", ") || "none"}`);
    }
    out.push("");
  }
  out.push("The publish workflow merges this automatically once `npm run verify` passes. Vercel then deploys main, and the admin change log marks it live.");
  return out.join("\n");
}

export const FLOW_ID = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

// A new form-style workflow starts with one section and one question.
function starterFlow(title) {
  return {
    version: 1,
    title,
    intro: "",
    privacy_notice: "Your information is kept private and used only by Lions Services to follow up.",
    handoffs: [],
    on_complete: { action: "staff_followup", message: "Thank you — a Lions Services team member will follow up soon." },
    blocks: [{ id: "contact", title: "Contact information", questions: ["full_name"] }],
    questions: [{ id: "full_name", type: "text", required: true, skippable: false, sensitive: true, prompt_screen: "What is your full name?", prompt_voice: "What is your full name?", recap_label: "Name", options: [] }],
  };
}

export function createFlowRepo({ gh, corpus, requests }) {
  async function mainRegistry() {
    const cur = await gh.readText("main", REGISTRY_FILE);
    return cur ? JSON.parse(cur.text) : { flows: [] };
  }
  async function pending() {
    const cur = await gh.readText(DATA_BRANCH, PENDING).catch(() => null);
    return cur ? JSON.parse(cur.text).flows || [] : [];
  }
  // Every workflow that can be edited: published ones from main, then new ones not published yet.
  async function registry({ withRetired = false } = {}) {
    const main = (await mainRegistry()).flows || [];
    const ids = new Set(main.map((m) => m.id));
    const all = main.concat((await pending()).filter((p) => !ids.has(p.id)).map((p) => ({ ...p, status: "draft" })));
    return withRetired ? all : all.filter((m) => m.status !== "retired");
  }
  async function meta(id) {
    const m = (await registry()).find((f) => f.id === id);
    if (!m) throw bad("No workflow called " + id, 404);
    return m;
  }
  const draftPath = (id) => `drafts/${id}.json`;

  // null when the workflow has never been published.
  async function published(id) {
    const m = await meta(id);
    const cur = await gh.readText("main", m.file);
    if (!cur) {
      if (m.status === "draft") return null;
      throw bad("The published copy of " + m.title + " is missing.", 500);
    }
    return { flow: JSON.parse(cur.text), sha: cur.sha };
  }

  async function versions(id) {
    const m = await meta(id);
    if (m.status === "draft") return [];
    const commits = await gh.listCommits("main", m.file, 100);
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

  async function check(id, flow) {
    const m = await meta(id);
    return checkFlow(flow, { organizations: corpus.organizations, routing: !!m.routing });
  }

  async function goldenFixture() {
    const cur = await gh.readText("main", GOLDEN);
    return cur ? JSON.parse(cur.text) : null;
  }

  async function impactOf(id, flow) {
    const m = await meta(id);
    if (!m.routing) return null;
    const fx = await goldenFixture();
    if (!fx) return null;
    const pub = await published(id);
    const personas = fx.personas.map((p) => ({ ...p, label: p.description || p.id }));
    return impact(corpus, pub.flow, flow, personas);
  }

  async function commitVersion(id, flow, { name, note, title, revertedFrom }) {
    const m = await meta(id);
    const result = await check(id, flow);
    if (!result.ok) throw bad("This workflow doesn't pass its checks yet, so it can't be published.", 422, { code: "checks_failed", details: result });
    const prior = await versions(id);
    const version = (prior.length ? prior[0].version : 0) + 1;
    if (!m.routing) flow = { ...flow, version };
    const files = [{ path: m.file, text: text(flow) }];
    // A new workflow's first publish also adds it to the registry, so the
    // assistant can run it once the site redeploys.
    if (m.status === "draft") {
      const reg = await mainRegistry();
      reg.flows = (reg.flows || []).filter((x) => x.id !== id).concat([{ id, title: m.title, description: m.description || "", file: m.file, usedBy: [`Voice and chat assistant (its own link: /f/${id})`], routing: false, group: groupOf(m), status: "published" }]);
      files.push({ path: REGISTRY_FILE, text: text(reg) });
    }
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
    const who = clean(name, 60) || "Someone";
    const why = clean(note, 300);
    const head = title || `${m.title} v${version}${why ? ": " + why : ""}`;
    const lines = [head.slice(0, 120), "", `Published by ${who} from the VISION360 editor.`];
    if (why) lines.push(`Note: ${why}`);
    if (revertedFrom) lines.push(`Reverted to the content of v${revertedFrom}.`);
    if (imp) lines.push(`Impact: ${imp.changed} of ${imp.personas} test people get different suggestions.`);
    const message = lines.join("\n");
    let sha, proposal = null;
    if (gh.proposeToMain) {
      // Hosted with GitHub: a pull request that merges itself once CI passes.
      const branch = `publish/${id}-v${version}-${Date.now().toString(36)}`;
      proposal = await gh.proposeToMain(files, message, { branch, title: head.slice(0, 120), body: prBody({ who, why, imp, revertedFrom, version, title: m.title }) });
      sha = proposal.sha;
    } else {
      ({ sha } = await gh.commitFiles("main", files, message));
    }
    // Clear the draft: it is now the published (or proposed) version.
    try { const d = await gh.readText(DATA_BRANCH, draftPath(id)); if (d) await gh.writeText(DATA_BRANCH, draftPath(id), text({ flow: null, cleared_at: new Date().toISOString() }), d.sha, `Clear draft: ${id}`); } catch (e) { /* a stale draft is harmless */ }
    if (requests) {
      await requests.logChange({
        title: revertedFrom ? `${m.title} reverted to v${revertedFrom} (now v${version})` : `${m.title} v${version} published`,
        summary: [why, imp ? `${imp.changed} of ${imp.personas} test people get different suggestions.` : ""].filter(Boolean).join(" "),
        kind: "workflow", ref: sha, highlight: { page: "/admin/workflows/edit/?flow=" + id, target: "versions" },
        ...(proposal ? { state: "proposed", pr: proposal.pr, pr_url: proposal.url } : {}),
      }).catch(() => {});
    }
    return { version, sha, impact: imp, checks: result, ...(proposal ? { state: "proposed", pr: proposal.pr, prUrl: proposal.url } : { state: "live" }) };
  }

  // Brings "proposed" change-log entries up to date: live once the merge is
  // in the commit this server runs, failed if the PR closed without merging.
  async function reconcile(running) {
    if (!requests || !gh.pullState) return 0;
    const open = (await requests.changelog()).filter((e) => e.state === "proposed" && e.pr).slice(0, 10);
    let n = 0;
    for (const e of open) {
      try {
        const p = await gh.pullState(e.pr);
        if (p.merged && p.mergeSha && (await gh.includes(p.mergeSha, running))) { await requests.setChangeState(e.id, { state: "live", ref: p.mergeSha }); n++; }
        else if (p.state === "closed" && !p.merged) { await requests.setChangeState(e.id, { state: "failed", note: "The checks didn't pass, so it wasn't published. See the pull request." }); n++; }
      } catch (err) { /* GitHub busy: try again next time */ }
    }
    return n;
  }

  return {
    registry,
    reconcile,

    async list() {
      return Promise.all((await registry()).map(async (m) => {
        const [pub, vs, draft] = await Promise.all([published(m.id), versions(m.id).catch(() => []), readDraft(m.id).catch(() => null)]);
        const shown = pub ? pub.flow : draft ? draft.flow : { blocks: [], questions: [] };
        return {
          id: m.id, title: m.title, description: m.description, usedBy: m.usedBy || [], routing: !!m.routing, group: groupOf(m), file: m.file,
          status: pub ? "published" : "draft",
          sections: shown.blocks.length, questions: shown.questions.length, followUps: shown.questions.filter((q) => q.ask_if).length,
          version: pub ? vs.length || 1 : 0, lastPublished: vs[0] || null,
          draft: draft ? { updated_at: draft.updated_at, author: draft.author, draftRevision: draft.draftRevision } : null,
        };
      }));
    },

    async get(id) {
      const m = await meta(id);
      const [pub, vs, draft] = await Promise.all([published(id), versions(id), readDraft(id)]);
      return { meta: m, published: pub ? pub.flow : null, version: pub ? vs.length || 1 : 0, versions: vs, draft: draft ? { flow: draft.flow, draftRevision: draft.draftRevision, updated_at: draft.updated_at, author: draft.author, base_version: draft.base_version } : null };
    },

    // New form-style workflow: a draft plus a pending registry entry. It runs
    // publicly only after its first publish (and the redeploy that follows).
    async create({ id, title, description, copyFrom, author, group }) {
      id = String(id || "").trim().toLowerCase();
      if (!FLOW_ID.test(id)) throw bad("The workflow id must be 3–40 lowercase letters, numbers and dashes, starting with a letter (for example spring-workshop).");
      const name = clean(title, 120);
      if (!name) throw bad("Give the workflow a title.");
      if ((await registry({ withRetired: true })).some((m) => m.id === id)) throw bad(`There's already a workflow called ${id}. Pick another id.`, 409);
      let flow = starterFlow(name);
      if (copyFrom) {
        const src = await meta(String(copyFrom));
        if (src.routing) throw bad("Only form-style workflows can be copied. The referral finder ranks services and can't be duplicated.");
        if (group === undefined) group = groupOf(src);
        const p = await published(src.id);
        const d = await readDraft(src.id).catch(() => null);
        flow = { ...structuredClone((p && p.flow) || (d && d.flow)), version: 1, title: name };
      }
      if (group !== undefined && !GROUPS.includes(group)) throw bad("Pick a row for the workflow: Resource Assistant or Vision Assessment.");
      const entry = { id, title: name, description: clean(description, 400), file: `site/data/flows/${id}.json`, usedBy: [], routing: false, group: group || "assistant", created_at: new Date().toISOString(), author: clean(author, 60) || "Someone" };
      await gh.updateJson(DATA_BRANCH, PENDING, (d) => { d.flows = (d.flows || []).filter((x) => x.id !== id).concat([entry]); }, `New workflow: ${name}`, { flows: [] });
      const saved = await this.saveDraft(id, { flow, author });
      if (requests) await requests.logChange({ title: `New workflow: ${name}`, summary: `Created as a draft (${id}). Publish it to get its link and QR code.`, kind: "workflow", highlight: { page: "/admin/workflows/", target: "flow-list" } }).catch(() => {});
      return { id, title: name, status: "draft", draftRevision: saved.draftRevision, checks: saved.checks };
    },

    // Deleting a published workflow opens a pull request that marks it retired.
    // A workflow that was never published is simply removed.
    async remove(id, { name, mainFlow, live = [] } = {}) {
      const m = await meta(id);
      if (id === "referral") throw bad("The referral finder can't be deleted: the directory's Find services uses it.", 400);
      if (id === mainFlow || live.includes(id)) throw bad("This workflow is live on the public site. Make another workflow live in its row first.", 400);
      if (m.status === "draft") {
        await gh.updateJson(DATA_BRANCH, PENDING, (d) => { d.flows = (d.flows || []).filter((x) => x.id !== id); }, `Remove draft workflow: ${id}`, { flows: [] });
        await this.discardDraft(id);
        if (requests) await requests.logChange({ title: `Draft workflow deleted: ${m.title}`, summary: "It was never published.", kind: "workflow" }).catch(() => {});
        return { state: "removed" };
      }
      const reg = await mainRegistry();
      reg.flows = (reg.flows || []).map((x) => (x.id === id ? { ...x, status: "retired", retired_at: new Date().toISOString() } : x));
      const who = clean(name, 60) || "Someone";
      const message = `Delete workflow: ${m.title}\n\nDeleted by ${who} from the VISION360 admin. The file stays so earlier conversations still show their answers.`;
      const files = [{ path: REGISTRY_FILE, text: text(reg) }];
      let sha, proposal = null;
      if (gh.proposeToMain) {
        proposal = await gh.proposeToMain(files, message, { branch: `publish/retire-${id}-${Date.now().toString(36)}`, title: `Delete workflow: ${m.title}`, body: `**${m.title}** deleted by ${who} from the VISION360 admin.\n\nIt's marked retired in the registry: its link, QR code and admin card go away, and conversations already saved keep their answers.\n\nThe publish workflow merges this automatically once \`npm run verify\` passes.` });
        sha = proposal.sha;
      } else {
        ({ sha } = await gh.commitFiles("main", files, message));
      }
      if (requests) await requests.logChange({ title: `Workflow deleted: ${m.title}`, summary: "Its link and QR code stop working once this is live. Saved conversations are kept.", kind: "workflow", ref: sha, ...(proposal ? { state: "proposed", pr: proposal.pr, pr_url: proposal.url } : {}) }).catch(() => {});
      return { sha, ...(proposal ? { state: "proposed", pr: proposal.pr, prUrl: proposal.url } : { state: "live" }) };
    },

    async versionAt(id, sha) {
      const m = await meta(id);
      if (sha !== "working-copy" && !/^[0-9a-f]{7,40}$/.test(sha)) throw bad("Invalid version id");
      const cur = await gh.readText(sha, m.file);
      if (!cur) throw bad("That version wasn't found", 404);
      return JSON.parse(cur.text);
    },

    async saveDraft(id, { flow, draftRevision, author }) {
      const m = await meta(id);
      if (!flow || typeof flow !== "object") throw bad("Send the whole workflow as `flow`.");
      if (Buffer.byteLength(JSON.stringify(flow)) > MAX_FLOW_BYTES) throw bad("The workflow is too large.");
      const cur = await gh.readText(DATA_BRANCH, draftPath(id));
      const prev = cur ? JSON.parse(cur.text) : null;
      const prevRev = prev && prev.flow ? prev.draftRevision || 0 : 0;
      if (draftRevision != null && Number(draftRevision) !== prevRev) throw bad("Someone else changed this draft. Reload to see their changes.", 409, { code: "stale", currentRevision: prevRev });
      const vs = await versions(id).catch(() => []);
      const next = { flow, draftRevision: prevRev + 1, updated_at: new Date().toISOString(), author: clean(author, 60) || "Someone", base_version: (prev && prev.flow && prev.base_version) || vs.length || 1 };
      try {
        await gh.writeText(DATA_BRANCH, draftPath(id), text(next), cur ? cur.sha : null, `Draft: ${m.title} (rev ${next.draftRevision}) by ${next.author}`);
      } catch (e) {
        if (e instanceof StoreConflict) throw bad("Someone else changed this draft. Reload to see their changes.", 409, { code: "stale" });
        throw e;
      }
      return { draftRevision: next.draftRevision, updated_at: next.updated_at, checks: await check(id, flow) };
    },

    async discardDraft(id) {
      const cur = await gh.readText(DATA_BRANCH, draftPath(id));
      if (cur) await gh.writeText(DATA_BRANCH, draftPath(id), text({ flow: null, cleared_at: new Date().toISOString() }), cur.sha, `Discard draft: ${id}`);
      return { ok: true };
    },

    async check(id, flow) {
      const target = flow || (await readDraft(id) || {}).flow || ((await published(id)) || {}).flow;
      if (!target) throw bad("This workflow has nothing to check yet.", 404);
      return { checks: await check(id, target), impact: await impactOf(id, target) };
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
      return commitVersion(id, flow, { name, note: note || `Revert to v${v.version}`, revertedFrom: v.version, title: `${(await meta(id)).title}: revert to v${v.version}` });
    },
  };
}
