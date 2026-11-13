// Admin › Outreach: the switch, how each organization can be contacted, and
// every referral the assistant has sent for people. Kept out of api.mjs; it
// mounts these with one prefix check.
//
//   GET  /api/admin/outreach                  status, organizations, recent referrals
//   PUT  /api/admin/outreach/settings  {on}   the switch (features.orgOutreach)
//   PUT  /api/admin/outreach/orgs/:id  {channel: auto|email|none, email?, note?}
export function createOutreachRoutes({ store, settings, outreach, requests, h }) {
  // h: { requireStaff, requireSameSite, readJson, send, httpError, limiter, maskEmail }
  return async function handle(req, res, p, method, ip) {
    if (p === "/api/admin/outreach" && method === "GET") {
      await h.requireStaff(req);
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const [status, orgs] = await Promise.all([outreach.status(), outreach.table()]);
      const actions = store.adminOutreach(since).map((a) => ({ ...a, to: h.maskEmail(a.to) }));
      return h.send(res, 200, { status, orgs, actions });
    }
    if (p === "/api/admin/outreach/settings" && method === "PUT") {
      const u = await h.requireStaff(req);
      h.requireSameSite(req);
      if (!h.limiter(ip + ":write", 30)) throw h.httpError(429, "Too many changes at once — please wait a minute.");
      const body = await h.readJson(req);
      if (typeof body.on !== "boolean") throw h.httpError(400, "Say on: true or on: false.");
      await settings.updateSite({ features: { orgOutreach: body.on } });
      store.audit("staff:" + u.username, null, "settings_changed", { features: { orgOutreach: body.on } });
      await requests.logChange({ title: "Contacting organizations " + (body.on ? "switched on" : "switched off"), summary: body.on ? "The Resource Assistant now offers to contact organizations for people, after their suggestions." : "The Resource Assistant no longer offers to contact organizations.", kind: "app" }).catch(() => {});
      return h.send(res, 200, { status: await outreach.status() });
    }
    const m = p.match(/^\/api\/admin\/outreach\/orgs\/([a-z0-9-]+)$/);
    if (m && method === "PUT") {
      const u = await h.requireStaff(req);
      h.requireSameSite(req);
      if (!h.limiter(ip + ":write", 60)) throw h.httpError(429, "Too many changes at once — please wait a minute.");
      const body = await h.readJson(req);
      await outreach.setOverride(m[1], { channel: body.channel, email: body.email, note: body.note }, u.username);
      store.audit("staff:" + u.username, null, "outreach_contact_changed", { orgId: m[1], channel: body.channel });
      return h.send(res, 200, { ok: true, org: (await outreach.table()).find((o) => o.id === m[1]) });
    }
    throw h.httpError(404, "Not found");
  };
}
