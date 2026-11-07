// Email delivery reports: signed Resend (Svix) webhooks mark an email
// delivered or bounced; a bounce opens a staff follow-up.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { verifyWebhook, deliveryEvent } from "../server/lib/email-webhook.mjs";
import { makeApp } from "./helpers.mjs";

const SECRET = "whsec_" + Buffer.from("test-signing-secret-123").toString("base64");
function sign(body, id = "msg_1", ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(SECRET.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": "v1," + sig };
}
function post(app, body, headers) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(body)]);
    req.method = "POST"; req.url = "/api/webhooks/email"; req.headers = { host: "x", "content-type": "application/json", ...headers };
    req.socket = { remoteAddress: "wh" };
    const res = { writeHead(s) { this.status = s; }, end(b) { resolve({ status: this.status, json: b ? JSON.parse(String(b)) : null }); } };
    app.handle(req, res);
  });
}

test("signature check: valid, tampered, stale", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
  assert.equal(verifyWebhook(SECRET, sign(body), body), true);
  assert.equal(verifyWebhook(SECRET, sign(body), body + " "), false);
  assert.equal(verifyWebhook(SECRET, sign(body, "m", 1000), body), false);
  assert.deepEqual(deliveryEvent(JSON.parse(body)), { receipt: "resend:e1", outcome: "delivered", detail: null });
  assert.equal(deliveryEvent({ type: "email.opened", data: { email_id: "e1" } }), null);
});

test("delivered and bounced reports update the email and open a follow-up on bounce", async () => {
  const app = await makeApp({ RESEND_WEBHOOK_SECRET: SECRET });
  const id = app.store.createSession({ tokenHash: "h", corpusVersion: "v", state: {} });
  const mk = (n) => app.store.enqueueAction({ sessionId: id, type: "email_plan", idempotencyKey: "k" + n, authorizationId: null, revision: 0, payload: { to: "a@example.com" } });
  const a1 = mk(1).action, a2 = mk(2).action;
  app.store.updateAction(a1.id, { status: "provider_accepted", provider_receipt: "resend:e1" });
  app.store.updateAction(a2.id, { status: "provider_accepted", provider_receipt: "resend:e2" });
  let body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
  assert.equal((await post(app, body, sign(body))).json.matched, true);
  body = JSON.stringify({ type: "email.bounced", data: { email_id: "e2", bounce: { message: "Mailbox does not exist" } } });
  assert.equal((await post(app, body, sign(body))).status, 200);
  const acts = Object.fromEntries(app.store.actionsForSession(id).map((a) => [a.id, a.status]));
  assert.equal(acts[a1.id], "delivered");
  assert.equal(acts[a2.id], "bounced");
  assert.ok(app.store.staffReviews(id).some((r) => /bounced/.test(r.reason)));
  assert.equal((await post(app, body, { ...sign(body), "svix-signature": "v1,AAAA" })).status, 401);
});
