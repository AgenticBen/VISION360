// VISION360 MCP server: lets Claude or ChatGPT edit workflows and work
// through change requests. Streamable HTTP, stateless: each POST to /api/mcp
// carries one JSON-RPC message (or a batch) and gets a JSON reply.
//
// Every tool goes through flow-repo (workflows) or requests (requests and the
// change log); nothing here touches storage directly. No sign-in for now (the
// owner's decision); set V360_MCP_KEY to require an `x-v360-key` header.

const SERVER = { name: "vision360", title: "VISION360 (Lions Services)", version: "1.0.0" };
const KNOWN_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const AUTHOR = "Claude (MCP)";

export const INSTRUCTIONS = `VISION360 is Lions Services' vision-loss referral tool: a public directory, a voice and chat assistant, and an admin side.

Workflows are the question flows. "referral" is live: the assistant and the directory's Find services ask it, and its answers move organizations up or down the suggestions. "v360-interest" is the V360 TECH interest form, not used live yet.

How to change a workflow:
1. get_workflow to read it (you get the draft if there is one, otherwise the live version).
2. Edit the draft with add_question, update_question, move_question, set_follow_up, set_option, set_effect or delete_question (or update_draft for a whole new copy). Each edit saves to the draft and returns any check problems.
3. check_draft shows remaining problems and, for referral, how suggestions would change for the test people.
4. publish_draft opens a pull request that goes live by itself in about 3–5 minutes once the repo's checks pass (the change log shows proposed → live). Every publish is a version; revert_to_version undoes one.
Rules: effects that raise or lower an organization must cite a verified referral condition from an organization's record (use find_organizations). Keep wording plain and short. Follow-ups are questions only asked after a certain answer.

Requests: Ben files "content" and "app" requests from the request button. Work oldest first: set_request_status in_progress, do the change, verify it, then set_request_status done with a summary of at most two sentences (it goes in the change log). Content requests can usually be done with the workflow tools. App requests need code changes: if you can't make them here, set needs_ben with a comment saying what a coding session should do. Never touch cancelled requests.`;

const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const FLOW = { type: "string", description: "Workflow id: referral or v360-interest" };
const str = (description) => ({ type: "string", description });
const RO = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const LIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const TOOLS = [
  { name: "list_workflows", title: "List workflows", description: "List the workflows with their versions and whether they have an unpublished draft.", inputSchema: S({}), annotations: RO },
  { name: "get_workflow", title: "Get a workflow", description: "Read a workflow as JSON: the draft if there is one, otherwise the live version. Pass version to read an older version.", inputSchema: S({ flow: FLOW, version: { type: "integer", description: "Optional version number" } }, ["flow"]), annotations: RO },
  { name: "list_versions", title: "List versions", description: "The version history of a workflow, newest first.", inputSchema: S({ flow: FLOW }, ["flow"]), annotations: RO },
  { name: "get_draft", title: "Get the draft", description: "The unpublished draft of a workflow, or null.", inputSchema: S({ flow: FLOW }, ["flow"]), annotations: RO },
  { name: "update_draft", title: "Replace the draft", description: "Replace the whole draft with a new copy of the workflow JSON (same shape as get_workflow returns).", inputSchema: S({ flow: FLOW, workflow: { type: "object", description: "The full workflow JSON" } }, ["flow", "workflow"]), annotations: EDIT },
  { name: "add_question", title: "Add a question", description: "Add a question to a section of the draft.", inputSchema: S({
    flow: FLOW, section: str("Section id"), after: str("Optional question id to insert after; default end of section"),
    id: str("Optional id (lowercase_with_underscores); made from the wording if omitted"),
    type: { type: "string", enum: ["single", "multi", "yes_no", "text", "long_text", "email", "phone", "address", "date", "consent"] },
    prompt_screen: str("Wording on screen"), prompt_voice: str("Wording the assistant says (optional)"), help: str("Help text (optional)"),
    required: { type: "boolean" }, sensitive: { type: "boolean" },
    options: { type: "array", items: { type: "string" }, description: "Answer labels for choice questions" },
    follow_up_of: { type: "object", properties: { question: { type: "string" }, answers: { type: "array", items: { type: "string" } } }, required: ["question", "answers"], description: "Only ask after these answer values of that question" },
  }, ["flow", "section", "type", "prompt_screen"]), annotations: EDIT },
  { name: "update_question", title: "Change a question", description: "Change a question's wording, spoken wording, help, type or flags in the draft.", inputSchema: S({
    flow: FLOW, id: str("Question id"),
    changes: { type: "object", properties: { prompt_screen: { type: "string" }, prompt_voice: { type: "string" }, voice_template: { type: "string" }, help: { type: "string" }, type: { type: "string" }, required: { type: "boolean" }, sensitive: { type: "boolean" }, skippable: { type: "boolean" } }, additionalProperties: false },
  }, ["flow", "id", "changes"]), annotations: EDIT },
  { name: "delete_question", title: "Delete a question", description: "Delete a question from the draft. Follow-ups that depended on it become always asked.", inputSchema: S({ flow: FLOW, id: str("Question id") }, ["flow", "id"]), annotations: EDIT },
  { name: "move_question", title: "Move a question", description: "Move a question (with its follow-ups) to a section, after a given question or to the start or end.", inputSchema: S({ flow: FLOW, id: str("Question id"), section: str("Target section id"), after: str("Optional question id to place it after"), position: { type: "string", enum: ["start", "end"] } }, ["flow", "id", "section"]), annotations: EDIT },
  { name: "set_follow_up", title: "Make a follow-up", description: "Ask a question only after certain answers to an earlier question. Omit parent to make it always asked.", inputSchema: S({ flow: FLOW, id: str("Question id"), parent: str("Earlier question id"), answers: { type: "array", items: { type: "string" }, description: "Answer values of the parent" } }, ["flow", "id"]), annotations: EDIT },
  { name: "set_option", title: "Add, change or remove an answer", description: "Add an answer to a choice question, change its labels, or remove it.", inputSchema: S({ flow: FLOW, question: str("Question id"), value: str("Answer value (omit to add a new one)"), label: str("On-screen label"), label_voice: str("Spoken label"), aliases: { type: "array", items: { type: "string" } }, remove: { type: "boolean" } }, ["flow", "question"]), annotations: EDIT },
  { name: "set_effect", title: "Add or remove an effect", description: "Make an answer raise or lower an organization or a category in the suggestions (referral workflow only). Must cite a verified referral condition (see find_organizations).", inputSchema: S({
    flow: FLOW, question: str("Question id"), answer: str("Answer value"), target_type: { type: "string", enum: ["org", "category"] }, target: str("Organization id or category"),
    op: { type: "string", enum: ["raise", "lower"] }, weight: { type: "number", description: "1–100" }, because: str("Reason the person sees"),
    evidence_org: str("Organization id whose record holds the condition"), evidence_condition: str("The verified condition text, exactly"), remove: { type: "boolean", description: "Remove the matching effect instead" },
  }, ["flow", "question", "answer", "target_type", "target"]), annotations: EDIT },
  { name: "find_organizations", title: "Find organizations", description: "Search the directory for organization ids, categories and their verified referral conditions (for effects).", inputSchema: S({ query: str("Words to search for") }, ["query"]), annotations: RO },
  { name: "check_draft", title: "Check the draft", description: "Run the publish checks on the draft and show how suggestions would change for the test people.", inputSchema: S({ flow: FLOW }, ["flow"]), annotations: RO },
  { name: "publish_draft", title: "Publish the draft", description: "Publish the draft: opens a pull request that goes live by itself once the checks pass (about 3–5 minutes). Fails if checks fail.", inputSchema: S({ flow: FLOW, note: str("What changed and why"), name: str("Who asked for it (optional)") }, ["flow", "note"]), annotations: LIVE },
  { name: "revert_to_version", title: "Revert to a version", description: "Publish an earlier version's content as a new version.", inputSchema: S({ flow: FLOW, version: { type: "integer" }, note: str("Why") }, ["flow", "version"]), annotations: LIVE },
  { name: "list_requests", title: "List requests", description: "Change requests filed with the request button, oldest first.", inputSchema: S({ status: { type: "string", enum: ["open", "in_progress", "needs_ben", "done", "cancelled"] }, kind: { type: "string", enum: ["content", "app"] }, include_done: { type: "boolean" } }), annotations: RO },
  { name: "comment_on_request", title: "Reply on a request", description: "Add a reply to a request's thread.", inputSchema: S({ id: str("Request id"), body: str("Your reply") }, ["id", "body"]), annotations: EDIT },
  { name: "set_request_status", title: "Set a request's status", description: "Mark a request in_progress, needs_ben (handing it back with a comment) or done (with a summary of at most 400 characters, which goes in the change log).", inputSchema: S({ id: str("Request id"), status: { type: "string", enum: ["open", "in_progress", "needs_ben", "done"] }, summary: str("Required for done: two sentences at most"), ref: str("Optional commit or version reference") }, ["id", "status"]), annotations: EDIT },
  { name: "log_change", title: "Add to the change log", description: "Record a change in the change log (workflow publishes and finished requests are logged automatically).", inputSchema: S({ title: str("Short title"), summary: str("One or two sentences"), kind: { type: "string", enum: ["workflow", "app", "content"] }, ref: str("Optional commit"), page: str("Optional page path to highlight, e.g. /admin/") }, ["title"]), annotations: EDIT },
  { name: "get_dashboard", title: "Get the dashboard", description: "The admin dashboard's 30-day numbers: conversations, emails, staff requests and costs.", inputSchema: S({}), annotations: RO },
];
export const TOOL_NAMES = TOOLS.map((t) => t.name);

function bad(message) { const e = new Error(message); e.status = 400; return e; }
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "q_$1").slice(0, 40) || "item";
function uniq(base, taken) { let id = base, n = 2; while (taken(id)) id = `${base}_${n++}`; return id; }
const leaves = (c, out = []) => { if (!c) return out; if (c.all || c.any) (c.all || c.any).forEach((x) => leaves(x, out)); else if (c.not) leaves(c.not, out); else if (c.q) out.push(c); return out; };

export function createMcp({ flows, requests, corpus, overview, canWrite = () => true }) {
  async function working(flowId) {
    const w = await flows.get(flowId);
    return { flow: structuredClone(w.draft ? w.draft.flow : w.published), rev: w.draft ? w.draft.draftRevision : 0 };
  }
  async function editDraft(flowId, fn) {
    const { flow, rev } = await working(flowId);
    const q = (id) => { const x = flow.questions.find((y) => y.id === id); if (!x) throw bad(`No question "${id}" in ${flowId}.`); return x; };
    const block = (id) => { const b = flow.blocks.find((y) => y.id === id); if (!b) throw bad(`No section "${id}". Sections: ${flow.blocks.map((b) => b.id).join(", ")}.`); return b; };
    const blockOf = (id) => flow.blocks.find((b) => b.questions.includes(id));
    const descendants = (id) => flow.questions.filter((x) => leaves(x.ask_if).some((l) => l.q === id)).flatMap((x) => [x.id, ...descendants(x.id)]);
    const result = fn({ flow, q, block, blockOf, descendants });
    const saved = await flows.saveDraft(flowId, { flow, draftRevision: rev, author: AUTHOR });
    return { ...(result || {}), draftRevision: saved.draftRevision, checks: summary(saved.checks) };
  }
  const summary = (c) => ({ ok: c.ok, errors: c.errors.slice(0, 20), warnings: c.warnings.slice(0, 10), stats: c.stats });

  const handlers = {
    list_workflows: () => flows.list(),
    async get_workflow({ flow, version }) {
      if (version != null) {
        const w = await flows.get(flow);
        const v = w.versions.find((x) => x.version === Number(version));
        if (!v) throw bad(`No version ${version}. Versions: ${w.versions.map((x) => x.version).join(", ")}.`);
        return { flow, version: v.version, workflow: await flows.versionAt(flow, v.sha) };
      }
      const w = await flows.get(flow);
      return { flow, title: w.meta.title, usedBy: w.meta.usedBy, liveVersion: w.version, isDraft: !!w.draft, workflow: w.draft ? w.draft.flow : w.published };
    },
    async list_versions({ flow }) { return (await flows.get(flow)).versions; },
    async get_draft({ flow }) { return (await flows.get(flow)).draft; },
    async update_draft({ flow, workflow }) {
      const { rev } = await working(flow);
      const saved = await flows.saveDraft(flow, { flow: workflow, draftRevision: rev, author: AUTHOR });
      return { draftRevision: saved.draftRevision, checks: summary(saved.checks) };
    },
    add_question: (a) => editDraft(a.flow, ({ flow, block, q }) => {
      const b = block(a.section);
      const id = uniq(a.id ? slug(a.id) : slug(a.prompt_screen).slice(0, 30), (x) => flow.questions.some((y) => y.id === x));
      const choice = ["single", "multi", "yes_no", "consent"].includes(a.type);
      let labels = a.options || [];
      if (a.type === "yes_no" && !labels.length) labels = ["Yes", "No"];
      if (a.type === "consent" && !labels.length) labels = ["Yes, I agree"];
      const options = choice ? labels.map((l, i) => ({ value: a.type === "consent" && i === 0 ? "yes" : uniq(slug(l), () => false), label_screen: l, label_voice: l.toLowerCase(), aliases: [], effects: [] })) : [];
      const usesTemplate = flow.questions.some((x) => x.voice_template);
      const question = {
        id, domain: b.id, type: a.type, prompt_screen: a.prompt_screen, prompt_voice: a.prompt_voice || a.prompt_screen,
        voice_template: usesTemplate ? a.prompt_voice || a.prompt_screen : null, help: a.help || null,
        required: !!a.required, sensitive: !!a.sensitive, skippable: !a.required, ask_if: null, options,
      };
      if (a.follow_up_of) { q(a.follow_up_of.question); question.ask_if = { q: a.follow_up_of.question, in: a.follow_up_of.answers }; }
      flow.questions.push(question);
      const at = a.after ? b.questions.indexOf(a.after) + 1 : b.questions.length;
      if (a.after && at === 0) throw bad(`"${a.after}" isn't in section "${b.id}".`);
      b.questions.splice(at, 0, id);
      return { id };
    }),
    update_question: (a) => editDraft(a.flow, ({ q }) => {
      const x = q(a.id);
      for (const [k, v] of Object.entries(a.changes || {})) {
        if (k === "type" && !["single", "multi", "yes_no", "consent"].includes(v)) x.options = [];
        x[k] = v;
      }
      if ("required" in (a.changes || {})) x.skippable = !x.required;
      return { id: x.id };
    }),
    delete_question: (a) => editDraft(a.flow, ({ flow, q }) => {
      q(a.id);
      const freed = [];
      flow.questions.forEach((x) => { if (leaves(x.ask_if).some((l) => l.q === a.id)) { x.ask_if = null; freed.push(x.id); } });
      flow.handoffs = (flow.handoffs || []).filter((h) => !leaves(h.trigger).some((l) => l.q === a.id));
      flow.questions = flow.questions.filter((x) => x.id !== a.id);
      flow.blocks.forEach((b) => { b.questions = b.questions.filter((id) => id !== a.id); });
      return { deleted: a.id, nowAlwaysAsked: freed };
    }),
    move_question: (a) => editDraft(a.flow, ({ flow, q, block, descendants, blockOf }) => {
      q(a.id);
      const group = [a.id, ...descendants(a.id).filter((d) => blockOf(d) === blockOf(a.id))];
      const b = block(a.section);
      flow.blocks.forEach((x) => { x.questions = x.questions.filter((id) => !group.includes(id)); });
      let at = a.position === "start" ? 0 : b.questions.length;
      if (a.after) { const i = b.questions.indexOf(a.after); if (i === -1) throw bad(`"${a.after}" isn't in section "${b.id}".`); at = i + 1; }
      b.questions.splice(at, 0, ...group);
      return { moved: group };
    }),
    set_follow_up: (a) => editDraft(a.flow, ({ q }) => {
      const x = q(a.id);
      if (!a.parent) { x.ask_if = null; return { id: x.id, alwaysAsked: true }; }
      const p = q(a.parent);
      const valid = (p.options || []).map((o) => o.value);
      const bad1 = (a.answers || []).filter((v) => !valid.includes(v));
      if (!a.answers || !a.answers.length || bad1.length) throw bad(`Give answers from: ${valid.join(", ")}.`);
      x.ask_if = { q: p.id, in: a.answers };
      return { id: x.id, askedIf: x.ask_if };
    }),
    set_option: (a) => editDraft(a.flow, ({ flow, q }) => {
      const x = q(a.question);
      if (a.remove) {
        x.options = x.options.filter((o) => o.value !== a.value);
        flow.questions.forEach((y) => leaves(y.ask_if).forEach((l) => { if (l.q === x.id) l.in = l.in.filter((v) => v !== a.value); }));
        flow.questions.forEach((y) => { if (y.ask_if && y.ask_if.q && !(y.ask_if.in || []).length) y.ask_if = null; });
        return { removed: a.value };
      }
      let o = a.value ? x.options.find((y) => y.value === a.value) : null;
      if (!o) {
        if (!a.label) throw bad("A new answer needs a label.");
        o = { value: a.value ? slug(a.value) : uniq(slug(a.label), (v) => x.options.some((y) => y.value === v)), label_screen: a.label, label_voice: a.label.toLowerCase(), aliases: [], effects: [] };
        x.options.push(o);
      }
      if (a.label) o.label_screen = a.label;
      if (a.label_voice) o.label_voice = a.label_voice;
      if (a.aliases) o.aliases = a.aliases;
      return { option: o.value };
    }),
    set_effect: (a) => editDraft(a.flow, ({ q }) => {
      const x = q(a.question);
      const o = x.options.find((y) => y.value === a.answer);
      if (!o) throw bad(`"${a.question}" has no answer "${a.answer}".`);
      o.effects = o.effects || [];
      const same = (e) => e.target === a.target_type && e.id === a.target;
      if (a.remove) { o.effects = o.effects.filter((e) => !same(e)); return { removed: true }; }
      const w = Math.min(100, Math.abs(Number(a.weight) || 25));
      const e = { op: a.op === "lower" ? "suppress" : "boost", target: a.target_type, id: a.target, weight: a.op === "lower" ? -w : w, because: a.because || "", evidence: { org_id: a.evidence_org, branch_condition: a.evidence_condition } };
      const i = o.effects.findIndex(same);
      if (i === -1) o.effects.push(e); else o.effects[i] = e;
      return { effect: e };
    }),
    find_organizations({ query }) {
      const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
      return corpus.organizations.map((o) => {
        const hay = [o.id, o.name, (o.categories || []).join(" "), o.summary || "", o.description || ""].join(" ").toLowerCase();
        const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
        return { score, o };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12).map(({ o }) => ({
        id: o.id, name: o.name, categories: o.categories || [],
        verifiedConditions: [...new Set((o.access_path || []).flatMap((s) => (s.branches || []).map((b) => b.condition).filter(Boolean)))],
      }));
    },
    async check_draft({ flow }) { const r = await flows.check(flow); return { checks: summary(r.checks), impact: r.impact && { changed: r.impact.changed, personas: r.impact.personas, rows: r.impact.rows.filter((x) => x.changed).map((x) => ({ person: x.label, added: x.added, removed: x.removed, reordered: x.reordered })) } }; },
    async publish_draft({ flow, note, name }) { const r = await flows.publish(flow, { name: name ? `${name} via Claude` : AUTHOR, note }); return { version: r.version, commit: r.sha, state: r.state, pullRequest: r.prUrl || null, impact: r.impact && { changed: r.impact.changed, personas: r.impact.personas } }; },
    async revert_to_version({ flow, version, note }) { const r = await flows.revert(flow, { version, name: AUTHOR, note }); return { version: r.version, commit: r.sha, state: r.state, pullRequest: r.prUrl || null }; },
    async list_requests({ status, kind, include_done }) {
      const rows = await requests.list({ status, kind, includeDone: !!include_done || status === "done" || status === "cancelled" });
      return rows.slice().reverse().map((r) => ({ id: r.id, kind: r.kind, status: r.status, title: r.title, body: r.body, page: r.page_path, pageLabel: r.page_label, created: r.created_at, comments: r.comments, summary: r.summary }));
    },
    comment_on_request: ({ id, body }) => requests.comment(id, { author: "claude", body }),
    set_request_status: ({ id, status, summary, ref }) => requests.setStatus(id, { status, summary, ref }),
    log_change: ({ title, summary, kind, ref, page }) => requests.logChange({ title, summary, kind, ref, highlight: page ? { page } : null }),
    get_dashboard: () => { const o = overview(); return { since: o.since, usage: o.usage, costs: o.costs, emails: o.emails.length, failedEmails: o.emails.filter((e) => e.status === "failed").length, settings: o.settings }; },
  };

  async function one(msg) {
    // One line per call in the Vercel logs, so connection problems can be traced.
    try { console.log("mcp", JSON.stringify({ method: msg && msg.method, tool: msg && msg.params && msg.params.name, client: msg && msg.params && msg.params.clientInfo, version: msg && msg.params && msg.params.protocolVersion })); } catch (e) {}
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: "Invalid request" } };
    const isNote = msg.id === undefined || msg.id === null;
    const reply = (result) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params && msg.params.protocolVersion;
        return reply({ protocolVersion: KNOWN_VERSIONS.includes(asked) ? asked : KNOWN_VERSIONS[0], capabilities: { tools: { listChanged: false }, resources: {}, prompts: {}, logging: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS });
      }
      case "ping": return reply({});
      // Some clients ask for these even when not advertised; answer with empty lists.
      case "resources/list": return reply({ resources: [] });
      case "resources/templates/list": return reply({ resourceTemplates: [] });
      case "prompts/list": return reply({ prompts: [] });
      case "logging/setLevel": return reply({});
      case "completion/complete": return reply({ completion: { values: [], hasMore: false } });
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const name = msg.params && msg.params.name;
        const h = handlers[name];
        if (!h) return fail(-32602, `Unknown tool: ${name}`);
        const def = TOOLS.find((t) => t.name === name);
        if (!def.annotations.readOnlyHint && !canWrite()) return reply({ content: [{ type: "text", text: "Editing is switched off on this site (V360_FLOW_EDITS=off)." }], isError: true });
        try {
          const out = await h((msg.params && msg.params.arguments) || {});
          const data = out === undefined ? { ok: true } : out;
          return reply({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: Array.isArray(data) ? { items: data } : data, isError: false });
        } catch (e) {
          const detail = e.details ? "\n" + JSON.stringify(e.details.errors ? e.details.errors.slice(0, 15) : e.details, null, 2) : "";
          return reply({ content: [{ type: "text", text: (e.message || String(e)) + detail }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  // Returns { status, body } for the HTTP layer.
  async function handle(payload) {
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map(one))).filter(Boolean);
      return out.length ? { status: 200, body: out } : { status: 202, body: null };
    }
    const r = await one(payload);
    return r ? { status: 200, body: r } : { status: 202, body: null };
  }

  return { handle, tools: TOOLS };
}
