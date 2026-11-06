// Checks a workflow before it can be published (from the admin editor or MCP).
// Errors block publishing; warnings are shown but don't.
//
//   checkFlow(flow, { organizations, routing }) -> { ok, errors[], warnings[], stats }
//
// Every message names where the problem is ({ where: "question:age_band" })
// so the editor can jump to it.

export const QUESTION_TYPES = ["single", "multi", "yes_no", "text", "long_text", "email", "phone", "address", "date", "consent"];
export const CHOICE_TYPES = ["single", "multi", "yes_no", "consent"];
const ID = /^[a-z][a-z0-9_]{0,47}$/;
const VALUE = /^[a-z0-9][a-z0-9_]{0,47}$/;
export const MAX_FLOW_BYTES = 450 * 1024;

export function checkFlow(flow, { organizations = [], routing = true } = {}) {
  const errors = [];
  const warnings = [];
  const err = (where, message) => errors.push({ where, message });
  const warn = (where, message) => warnings.push({ where, message });
  const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);

  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return { ok: false, errors: [{ where: "flow", message: "The workflow must be a JSON object." }], warnings, stats: {} };
  const size = Buffer.byteLength(JSON.stringify(flow));
  if (size > MAX_FLOW_BYTES) err("flow", `The workflow is too large (${Math.round(size / 1024)} KB; the limit is ${MAX_FLOW_BYTES / 1024} KB).`);
  if (!Array.isArray(flow.blocks) || !flow.blocks.length) err("flow", "The workflow needs at least one section.");
  if (!Array.isArray(flow.questions) || !flow.questions.length) err("flow", "The workflow needs at least one question.");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const orgIds = new Set(organizations.map((o) => o.id));
  const categories = new Set(organizations.flatMap((o) => o.categories || []));
  const conditions = new Set();
  organizations.forEach((o) => (o.access_path || []).forEach((s) => (s.branches || []).forEach((b) => { if (b.condition) conditions.add(b.condition); })));

  // ---- questions
  const byId = new Map();
  for (const q of flow.questions) {
    const w = "question:" + (q && q.id);
    if (!q || typeof q !== "object") { err("flow", "A question is empty."); continue; }
    if (!ID.test(q.id || "")) err(w, `Question id "${q.id}" must be lowercase letters, numbers and underscores, starting with a letter.`);
    if (byId.has(q.id)) err(w, `Two questions share the id "${q.id}".`);
    byId.set(q.id, q);
    if (!QUESTION_TYPES.includes(q.type)) err(w, `"${q.id}" has an unknown answer type "${q.type}".`);
    if (!str(q.prompt_screen, 600)) err(w, `"${q.id}" needs on-screen wording (up to 600 characters).`);
    if (!optStr(q.prompt_voice, 600)) err(w, `"${q.id}" spoken wording is too long.`);
    if (!q.prompt_voice && !q.voice_template) warn(w, `"${q.id}" has no spoken wording; the assistant would read the on-screen wording.`);
    if (!optStr(q.voice_template, 600)) err(w, `"${q.id}" spoken wording template is too long.`);
    if (q.voice_template && /\{(?!S\}|Sc\}|pos\}|obj\}|Do\}|do\}|Be\}|be\}|Have\}|have\}|s\}|re\})[^}]*\}/.test(q.voice_template)) warn(w, `"${q.id}" spoken wording has a placeholder the assistant doesn't know.`);
    if (!optStr(q.help, 1500)) err(w, `"${q.id}" help text is too long.`);
    const opts = Array.isArray(q.options) ? q.options : [];
    if (!Array.isArray(q.options)) err(w, `"${q.id}" needs an options list (it can be empty for typed answers).`);
    if (CHOICE_TYPES.includes(q.type) && q.type !== "consent" && opts.length < 2) err(w, `"${q.id}" is a choice question and needs at least two answers.`);
    if (q.type === "consent" && opts.length !== 1) err(w, `"${q.id}" is a consent question and needs exactly one answer (the agreement).`);
    if (!CHOICE_TYPES.includes(q.type) && opts.length) err(w, `"${q.id}" is a typed answer (${q.type}) and can't have answer options.`);
    const values = new Set();
    for (const o of opts) {
      const ow = w + ":" + (o && o.value);
      if (!o || !VALUE.test(o.value || "")) { err(ow, `An answer in "${q.id}" has an invalid value "${o && o.value}".`); continue; }
      if (values.has(o.value)) err(ow, `"${q.id}" has two answers with the value "${o.value}".`);
      values.add(o.value);
      if (!str(o.label_screen, 300)) err(ow, `Answer "${o.value}" in "${q.id}" needs a label.`);
      if (o.aliases != null && (!Array.isArray(o.aliases) || o.aliases.some((a) => typeof a !== "string" || a.length > 80))) err(ow, `Answer "${o.value}" in "${q.id}" has invalid alternative phrasings.`);
      for (const e of o.effects || []) {
        if (!routing) { err(ow, `"${q.id}" can't move organizations: this workflow doesn't rank services.`); break; }
        if (e.op !== "boost" && e.op !== "suppress") err(ow, `An effect on "${o.value}" must raise (boost) or lower (suppress).`);
        if (e.target === "org" && !orgIds.has(e.id)) err(ow, `An effect on "${o.value}" points at an organization that doesn't exist: "${e.id}".`);
        else if (e.target === "category" && !categories.has(e.id)) err(ow, `An effect on "${o.value}" points at a category that doesn't exist: "${e.id}".`);
        else if (e.target !== "org" && e.target !== "category") err(ow, `An effect on "${o.value}" must target an organization or a category.`);
        if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || Math.abs(e.weight) > 100) err(ow, `An effect on "${o.value}" needs a weight between -100 and 100.`);
        if (e.op === "suppress" && e.weight > 0) warn(ow, `A "lower" effect on "${o.value}" has a positive weight; it will be treated as negative.`);
        if (!str(e.because, 600)) err(ow, `An effect on "${o.value}" needs a reason people will see ("because…").`);
        // CLAUDE.md rule: every recommendation traces to a verified branch condition.
        if (!e.evidence || !conditions.has(e.evidence.branch_condition)) err(ow, `An effect on "${o.value}" must cite a verified referral condition from an organization's record (evidence).`);
      }
    }
  }

  // ---- sections and order
  const order = [];
  const seenBlock = new Set();
  for (const b of flow.blocks) {
    const w = "section:" + (b && b.id);
    if (!b || !ID.test(b.id || "")) { err(w, `Section id "${b && b.id}" is invalid.`); continue; }
    if (seenBlock.has(b.id)) err(w, `Two sections share the id "${b.id}".`);
    seenBlock.add(b.id);
    if (!str(b.title, 120)) err(w, `Section "${b.id}" needs a title.`);
    if (!optStr(b.preamble, 1000)) err(w, `Section "${b.id}" intro is too long.`);
    for (const id of b.questions || []) {
      if (!byId.has(id)) err(w, `Section "${b.id}" lists a question that doesn't exist: "${id}".`);
      else if (order.includes(id)) err("question:" + id, `"${id}" is in more than one section.`);
      else order.push(id);
    }
  }
  for (const id of byId.keys()) if (!order.includes(id)) err("question:" + id, `"${id}" isn't in any section, so it would never be asked.`);

  // ---- follow-up conditions: only earlier questions, only real answers, no loops
  const pos = new Map(order.map((id, i) => [id, i]));
  function checkCond(cond, w, ownerPos, depth = 0) {
    if (cond == null) return;
    if (depth > 6) { err(w, "A condition is nested too deeply."); return; }
    if (typeof cond !== "object") { err(w, "A condition is malformed."); return; }
    if (cond.all || cond.any) { const list = cond.all || cond.any; if (!Array.isArray(list) || !list.length) err(w, "An all/any condition needs at least one part."); else list.forEach((c) => checkCond(c, w, ownerPos, depth + 1)); return; }
    if (cond.not) { checkCond(cond.not, w, ownerPos, depth + 1); return; }
    if (!cond.q) { err(w, "A condition must name a question."); return; }
    const parent = byId.get(cond.q);
    if (!parent) { err(w, `A condition refers to a question that doesn't exist: "${cond.q}".`); return; }
    if (ownerPos != null && !(pos.get(cond.q) < ownerPos)) err(w, `A condition refers to "${cond.q}", which isn't asked earlier, so it could never be true (or it loops).`);
    if (!Array.isArray(cond.in) || !cond.in.length) { err(w, `A condition on "${cond.q}" needs at least one answer.`); return; }
    const valid = new Set((parent.options || []).map((o) => o.value));
    for (const v of cond.in) if (!valid.has(v)) err(w, `A condition on "${cond.q}" uses an answer that doesn't exist: "${v}".`);
  }
  for (const q of byId.values()) checkCond(q.ask_if, "question:" + q.id, pos.get(q.id));

  // ---- handoffs
  for (const h of flow.handoffs || []) {
    const w = "handoff:" + (h && h.id);
    if (!h || !ID.test(h.id || "")) { err(w, `Handoff id "${h && h.id}" is invalid.`); continue; }
    if (!str(h.headline, 300)) err(w, `Handoff "${h.id}" needs a headline.`);
    if (!str(h.body, 3000)) err(w, `Handoff "${h.id}" needs a body.`);
    checkCond(h.trigger, w, null);
    for (const id of h.refer_to || []) if (!orgIds.has(id)) err(w, `Handoff "${h.id}" refers to an organization that doesn't exist: "${id}".`);
  }

  if (routing) {
    const effects = flow.questions.flatMap((q) => (q.options || []).flatMap((o) => o.effects || []));
    if (!effects.length) warn("flow", "No answer moves any organization, so every suggestion list would be in default order.");
  }
  const followUps = flow.questions.filter((q) => q.ask_if).length;
  return { ok: errors.length === 0, errors, warnings, stats: { sections: flow.blocks.length, questions: flow.questions.length, followUps, handoffs: (flow.handoffs || []).length, bytes: size } };
}
