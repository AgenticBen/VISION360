// Admin › Outreach and the routes that run outreach jobs. Kept out of api.mjs;
// it mounts these with one prefix check.
//
//   GET  /api/admin/outreach                       status, organizations, referrals, practice-form entries
//   PUT  /api/admin/outreach/settings  {on}        the switch (features.orgOutreach)
//   PUT  /api/admin/outreach/orgs/:id  {channel: auto|email|none, email?, note?}
//   GET  /api/admin/outreach/recipes               organizations with a form link, and their recipes
//   PUT  /api/admin/outreach/recipes/:id           save a recipe draft
//   POST /api/admin/outreach/recipes/:id/status    {status, confirm: "APPROVE"} for approvals
//   POST /api/admin/outreach/recipes/:id/inspect   look at the form (nothing typed, nothing sent)
//   POST /api/admin/outreach/recipes/:id/dry-run   fill with made-up details, don't submit
//   POST /api/admin/outreach/recipes/:id/draft-ai  suggest a recipe from the form's field labels
//   POST /api/admin/outreach/run                   run due form jobs now
//   POST /api/session/:id/outreach/run             the person's page: run this conversation's form jobs
//   POST /api/outreach/test-form                   the practice form used while outreach isn't live
import { validateRecipe, formValues, hostOf, SOURCES } from "./form-recipes.mjs";
import { aiEnabled, callModel } from "./ai-understanding.mjs";

const SAMPLE = { name: "Pat Example", phone: "704-555-0100", email: "pat@example.org", preferred: "phone" };

export function createOutreachRoutes({ store, settings, outreach, recipes, formRunner, actions, requests, env, h }) {
  const write = async (req, ip, n = 30) => {
    const u = await h.requireStaff(req);
    h.requireSameSite(req);
    if (!h.limiter(ip + ":write", n)) throw h.httpError(429, "Too many changes at once — please wait a minute.");
    return u;
  };

  return async function handle(req, res, p, method, ip) {
    if (p === "/api/admin/outreach" && method === "GET") {
      await h.requireStaff(req);
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const [status, orgs] = await Promise.all([outreach.status(), outreach.table()]);
      const actionsList = store.adminOutreach(since).map((a) => ({ ...a, to: h.maskEmail(a.to) }));
      const practice = store.auditByEvent("practice_form_received", 10);
      return h.send(res, 200, { status, orgs, actions: actionsList, practice });
    }
    if (p === "/api/admin/outreach/settings" && method === "PUT") {
      const u = await write(req, ip);
      const body = await h.readJson(req);
      if (typeof body.on !== "boolean") throw h.httpError(400, "Say on: true or on: false.");
      await settings.updateSite({ features: { orgOutreach: body.on } });
      store.audit("staff:" + u.username, null, "settings_changed", { features: { orgOutreach: body.on } });
      await requests.logChange({ title: "Contacting organizations " + (body.on ? "switched on" : "switched off"), summary: body.on ? "The Resource Assistant now offers to contact organizations for people, after their suggestions." : "The Resource Assistant no longer offers to contact organizations.", kind: "app" }).catch(() => {});
      return h.send(res, 200, { status: await outreach.status() });
    }
    let m = p.match(/^\/api\/admin\/outreach\/orgs\/([a-z0-9-]+)$/);
    if (m && method === "PUT") {
      const u = await write(req, ip, 60);
      const body = await h.readJson(req);
      await outreach.setOverride(m[1], { channel: body.channel, email: body.email, note: body.note }, u.username);
      store.audit("staff:" + u.username, null, "outreach_contact_changed", { orgId: m[1], channel: body.channel });
      return h.send(res, 200, { ok: true, org: (await outreach.table()).find((o) => o.id === m[1]) });
    }

    // ------------------------------------------------------------ form recipes
    if (p === "/api/admin/outreach/recipes" && method === "GET") {
      await h.requireStaff(req);
      return h.send(res, 200, { recipes: await recipes.list(), sources: SOURCES, runner: formRunner.configured });
    }
    m = p.match(/^\/api\/admin\/outreach\/recipes\/([a-z0-9-]+)(?:\/(status|inspect|dry-run|draft-ai))?$/);
    if (m) {
      const [, orgId, op] = m;
      if (!op && method === "PUT") {
        const u = await write(req, ip, 60);
        const body = await h.readJson(req, 64 * 1024);
        const r = await recipes.save(orgId, body, u.username);
        store.audit("staff:" + u.username, null, "form_recipe_saved", { orgId, version: r.version });
        return h.send(res, 200, { recipe: r, problems: validateRecipe(r) });
      }
      if (op === "status" && method === "POST") {
        const u = await write(req, ip);
        const body = await h.readJson(req);
        if (/approved$/.test(String(body.status)) && body.confirm !== "APPROVE") throw h.httpError(400, 'Type APPROVE to approve this form recipe.');
        const r = await recipes.setStatus(orgId, String(body.status), u.username);
        store.audit("staff:" + u.username, null, "form_recipe_status", { orgId, status: r.status });
        await requests.logChange({ title: `Form recipe ${r.status.replace("_", " ")}`, summary: `${orgId}: online form recipe version ${r.version} is now ${r.status.replace("_", " ")}.`, kind: "app" }).catch(() => {});
        return h.send(res, 200, { recipe: r });
      }
      if (op === "inspect" && method === "POST") {
        const u = await write(req, ip, 10);
        const body = await h.readJson(req);
        const url = String(body.url || "");
        if (!/^https:\/\//.test(url)) throw h.httpError(400, "Give the form's https:// address.");
        const allow = Array.isArray(body.allowDomains) && body.allowDomains.length ? body.allowDomains.map(String) : [hostOf(url)];
        const r = await formRunner.inspect(url, allow);
        if (r.outcome === "inspected") await recipes.setFingerprint(orgId, r.fieldsHash, u.username);
        store.audit("staff:" + u.username, null, "form_inspected", { orgId, outcome: r.outcome });
        return h.send(res, 200, r);
      }
      if (op === "dry-run" && method === "POST") {
        const u = await write(req, ip, 10);
        const r = await recipes.get(orgId);
        if (!r) throw h.httpError(404, "Save a recipe first.");
        const out = await formRunner.dryRun(r, formValues(SAMPLE, { name: "Example organization" }));
        store.audit("staff:" + u.username, null, "form_dry_run", { orgId, outcome: out.outcome });
        return h.send(res, 200, out);
      }
      if (op === "draft-ai" && method === "POST") {
        await write(req, ip, 10);
        if (!aiEnabled(env)) throw h.httpError(503, "AI help isn't switched on (V360_AI_UNDERSTANDING).");
        const body = await h.readJson(req, 64 * 1024);
        const fields = (Array.isArray(body.fields) ? body.fields : []).slice(0, 60).map((f) => ({ selector: String(f.selector || ""), kind: String(f.kind || "text"), label: String(f.label || "").slice(0, 120), required: !!f.required }));
        if (!fields.length) throw h.httpError(400, "Inspect the form first, then send its fields.");
        return h.send(res, 200, { fields: await draftFields(fields) });
      }
    }

    // ------------------------------------------------------------ running jobs
    if (p === "/api/admin/outreach/run" && method === "POST") {
      await write(req, ip, 10);
      const done = await actions.drain(8, { types: ["org_form_submit", "org_referral_email"] });
      return h.send(res, 200, { processed: done });
    }
    m = p.match(/^\/api\/session\/([0-9a-f-]{36})\/outreach\/run$/);
    if (m && method === "POST") {
      h.checkOrigin(req);
      const s = await h.loadSession(req, m[1]);
      if (!h.limiter(ip + ":outreach-run", 20)) throw h.httpError(429, "Please wait a moment.");
      const mine = new Set(s.work.actionsForSession().filter((a) => a.type.startsWith("org_")).map((a) => a.id));
      const done = mine.size ? await actions.drain(8, { types: ["org_form_submit", "org_referral_email"] }) : [];
      h.markDirty(s.id);
      return h.send(res, 200, { processed: done.filter((d) => mine.has(d.id)).length });
    }

    // ----------------------------------------------- the practice form (demo)
    if (p === "/api/outreach/test-form" && method === "POST") {
      h.checkOrigin(req);
      if (!h.limiter(ip + ":practice-form", 20)) throw h.httpError(429, "Please wait a moment.");
      const body = await h.readJson(req);
      const pick = (k) => String(body[k] || "").slice(0, 300);
      store.audit("practice-form", null, "practice_form_received", { fullName: pick("full_name"), phone: pick("phone"), email: pick("email"), preferred: pick("preferred"), referrer: pick("referrer"), intendedOrg: pick("intended_org"), note: pick("note").slice(0, 600) });
      return h.send(res, 200, { ok: true, message: "Referral received" });
    }
    throw h.httpError(404, "Not found");
  };

  // AI only maps field LABELS to the allowed sources; it never sees anyone's details.
  async function draftFields(fields) {
    const prompt = `Map each web form field to what should go in it. Allowed values: ${SOURCES.join(", ")}, or "skip". Never map consent, terms, health, income or other personal questions; use "skip" for those. Reply with JSON only: {"fields": [{"selector": "...", "source": "..."}]}.\n\nFields:\n${JSON.stringify(fields)}`;
    const out = await callModel(env, globalThis.fetch, [{ role: "system", content: "You map form field labels to allowed data sources. Reply with JSON only." }, { role: "user", content: prompt }]);
    const list = out && Array.isArray(out.fields) ? out.fields : [];
    const bySel = new Map(list.map((x) => [x.selector, x.source]));
    return fields.map((f) => ({ ...f, source: SOURCES.includes(bySel.get(f.selector)) ? bySel.get(f.selector) : "skip" }));
  }
}
