// Durable, idempotent actions (for this MVP: the consented email plan).
//
//   authorise -> queued -> running -> provider_accepted        (real provider)
//                                  -> mock_written             (local test outbox; NOT a real send)
//                                  -> retrying -> ... -> failed (+ staff review)
//   provider_accepted -> delivered | bounced (+ staff review)  (provider webhook)
//   any not-yet-started action -> cancelled when answers change
//
// "provider_accepted" means the email service accepted it. It does not prove
// the email arrived. Nothing is marked sent without a provider receipt.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./corpus.mjs";
import { TEST_FORM_ID } from "./form-recipes.mjs";

const MAX_ATTEMPTS = 5;

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

export const EMAIL_PURPOSE = "Send the confirmed referral plan to the person";
export { ORG_EMAIL_PURPOSE } from "./outreach-mail.mjs";

// The same person, address, plan and answer revision always give the same
// key, so a retried "yes" can never queue a second email.
export function emailIdempotencyKey(sessionId, recipient, planHash, revision) {
  return sha([sessionId, "email_plan", recipient.toLowerCase(), planHash, revision].join("|"));
}
// The same rule for any action type (one key per type, destination, content and revision).
export function actionIdempotencyKey(sessionId, type, destination, hash, revision) {
  if (type === "email_plan") return emailIdempotencyKey(sessionId, destination, hash, revision);
  return sha([sessionId, type, String(destination).toLowerCase(), hash, revision].join("|"));
}

// Emails to organizations reach the real organization only when this is on.
// Until then they go to the demo test inbox, marked with who they were for.
export function outreachLive(env) {
  return String(env.V360_OUTREACH_LIVE || "").toLowerCase() === "on";
}
// Where demo emails to organizations go instead of the organization.
export function outreachTestInbox(env) {
  if (env.V360_OUTREACH_TEST_INBOX) return String(env.V360_OUTREACH_TEST_INBOX).trim();
  const exact = String(env.V360_EMAIL_ALLOWLIST || "").split(",").map((s) => s.trim()).find((e) => e && !e.startsWith("@"));
  return exact || null;
}

export function createActions(ctx) {
  const { store } = ctx;
  const env = ctx.env || process.env;

  const transport = pickTransport(env);

  function transportName() {
    return transport.name;
  }

  // Demo destinations are controlled. With a real provider, only addresses on
  // V360_EMAIL_ALLOWLIST (exact addresses or @domain entries) are allowed.
  function recipientAllowed(address) {
    const list = String(env.V360_EMAIL_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const a = address.toLowerCase();
    if (transport.name === "outbox" && !list.length) return { ok: true };
    const ok = list.some((e) => (e.startsWith("@") ? a.endsWith(e) : a === e));
    return ok ? { ok: true } : { ok: false, reason: "In this demo I can only send to approved test inboxes, and that address isn't on the list, so I haven't sent anything." };
  }

  // Worker: claims one due action and runs it. Re-checks authorisation and the
  // answer revision immediately before acting, so a correction made after the
  // yes cancels the send.
  // Form jobs need a longer-running function than a conversation turn, so the
  // turn's worker skips them (formsHere is false there).
  const formsHere = !env.V360_SERVERLESS || !!env.V360_FORM_WORKER;
  async function runOnce(opts = {}) {
    const action = store.claimDueAction(60000, { types: opts.types || null, skip: formsHere ? null : ["org_form_submit"] });
    if (!action) return null;
    if (ctx.markDirty) ctx.markDirty(action.session_id);
    const session = store.getSession(action.session_id);
    const auth = action.authorization_id ? store.getAuthorization(action.authorization_id) : null;
    const payload = JSON.parse(action.payload_json);
    const rec = store.currentRecommendation(action.session_id);
    const problems = [];
    if (!session) problems.push("session missing");
    if (!auth) problems.push("no authorisation");
    if (auth && auth.payload_hash !== payload.hash) problems.push("payload differs from what was authorised");
    const destProblem = auth ? destinationProblem(action.type, auth, payload) : null;
    if (destProblem) problems.push(destProblem);
    if (session && session.revision !== action.revision) problems.push("answers changed after authorisation");
    if (!rec || rec.id !== payload.recommendationId) problems.push("recommendation is no longer current");
    if (problems.length) {
      store.updateAction(action.id, { status: "cancelled", error: problems.join("; "), lease_until: null });
      store.audit("worker", action.session_id, "action_cancelled", { actionId: action.id, problems });
      return { id: action.id, status: "cancelled" };
    }
    if (action.type === "org_form_submit") return runForm(action, payload);
    try {
      const receipt = await transport.send({ to: payload.to, cc: payload.cc || null, replyTo: payload.replyTo || null, subject: payload.subject, text: payload.text, html: payload.html, idempotencyKey: action.idempotency_key, actionId: action.id });
      const status = transport.name === "outbox" ? "mock_written" : "provider_accepted";
      store.updateAction(action.id, { status, provider: transport.name, provider_receipt: receipt, error: null, lease_until: null });
      store.audit("worker", action.session_id, "action_" + status, { actionId: action.id, provider: transport.name });
      return { id: action.id, status };
    } catch (e) {
      const attempts = action.attempts;
      const msg = redact(String(e && e.message || e));
      if (attempts >= MAX_ATTEMPTS || e.permanent) {
        store.updateAction(action.id, { status: "failed", error: msg, lease_until: null, provider: transport.name });
        store.createStaffReview(action.session_id, action.type === "org_referral_email"
          ? `Automatic: couldn't reach ${payload.orgName || "an organization"} by email — ` + msg.slice(0, 120) + ". Please contact them for the person."
          : "Automatic: email plan failed to send — " + msg.slice(0, 120), null, false);
        store.audit("worker", action.session_id, "action_failed", { actionId: action.id });
        return { id: action.id, status: "failed" };
      }
      const delay = Math.min(300, 5 * 2 ** (attempts - 1));
      store.updateAction(action.id, { status: "retrying", error: msg, lease_until: null, next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(), provider: transport.name });
      return { id: action.id, status: "retrying" };
    }
  }

  // One form job: fill the organization's online form from its approved
  // recipe. If the form can't be used (bot check, changed page, runner not set
  // up), the prepared email to the organization goes instead; with no email,
  // a staff member gets a task with the answers ready to type in.
  async function runForm(action, payload) {
    const r = ctx.formRunner ? await ctx.formRunner.fill(payload) : { outcome: "not_set_up", detail: "Automatic form filling isn't set up yet." };
    const org = payload.orgName || "the organization";
    if (r.outcome === "submitted") {
      const status = payload.demo ? "mock_submitted" : "submitted";
      store.updateAction(action.id, { status, provider: "form", error: null, lease_until: null });
      store.audit("worker", action.session_id, "action_" + status, { actionId: action.id, orgId: payload.orgId });
      return { id: action.id, status };
    }
    if (r.outcome === "unconfirmed") {
      // It may have gone through, so don't also email them: ask staff to check.
      store.updateAction(action.id, { status: "unconfirmed", provider: "form", error: redact(String(r.detail || "")), lease_until: null });
      store.createStaffReview(action.session_id, `Automatic: ${org}'s online form was submitted for the person, but the page didn't confirm it. Please check with ${org}.`, payload.person || null, !!payload.person, null, { orgId: payload.orgId, orgName: org, formUrl: payload.formUrl || null, tried: "online form", error: r.detail || null, fields: payload.staffFields || {} });
      return { id: action.id, status: "unconfirmed" };
    }
    if ((r.outcome === "timeout" || r.outcome === "error") && action.attempts < 3) {
      store.updateAction(action.id, { status: "retrying", error: redact(String(r.detail || r.outcome)), lease_until: null, next_attempt_at: new Date(Date.now() + 60000 * action.attempts).toISOString(), provider: "form" });
      return { id: action.id, status: "retrying" };
    }
    const why = redact(String(r.detail || r.outcome));
    store.updateAction(action.id, { status: "fell_back", provider: "form", error: why, lease_until: null });
    store.audit("worker", action.session_id, "form_fell_back", { actionId: action.id, orgId: payload.orgId, outcome: r.outcome });
    if (payload.fallbackActionId && store.activateAction(payload.fallbackActionId)) return { id: action.id, status: "fell_back", fallback: "email" };
    store.createStaffReview(action.session_id, `Automatic: couldn't fill ${org}'s online form (${why.slice(0, 120)}). Please submit it for the person — the answers are ready below.`, payload.person || null, !!payload.person, null, { orgId: payload.orgId, orgName: org, formUrl: payload.formUrl || null, tried: "online form", error: why, fields: payload.staffFields || {} });
    return { id: action.id, status: "fell_back", fallback: "staff" };
  }

  async function drain(limit = 10, opts = {}) {
    const out = [];
    for (let i = 0; i < limit; i++) {
      const r = await runOnce(opts);
      if (!r) break;
      out.push(r);
    }
    return out;
  }

  function retry(actionId) {
    const a = store.getAction(actionId);
    if (!a || a.status !== "failed") return false;
    store.updateAction(actionId, { status: "queued", next_attempt_at: new Date().toISOString(), attempts: 0, error: null });
    return true;
  }

  // Delivery report from the email provider (see /api/webhooks/email).
  function recordDelivery(receipt, outcome, detail) {
    const a = store.actionByReceipt(receipt);
    if (!a) return null;
    if (a.status === "delivered" || a.status === "bounced") return a.session_id;
    if (outcome === "delivered") {
      store.updateAction(a.id, { status: "delivered" });
      store.audit("provider", a.session_id, "action_delivered", { actionId: a.id });
    } else {
      store.updateAction(a.id, { status: "bounced", error: redact(String(detail || outcome)).slice(0, 200) });
      const what = a.type === "org_referral_email" ? `The referral email to ${orgNameOf(a)}` : "The emailed plan";
      store.createStaffReview(a.session_id, "Automatic: " + what.charAt(0).toLowerCase() + what.slice(1) + " " + (outcome === "complained" ? "was marked as spam" : "bounced") + " — please follow up another way", null, false);
      store.audit("provider", a.session_id, "action_" + outcome, { actionId: a.id });
    }
    return a.session_id;
  }

  // Destination rules per action type, checked again just before sending.
  function destinationProblem(type, auth, payload) {
    const to = String(payload.to || "").toLowerCase();
    if (type === "org_form_submit") {
      if (auth.destination !== `form:${payload.orgId}:${payload.recipeId}:v${payload.recipeVersion}`) return "form differs from what was authorised";
      if (payload.recipeId === TEST_FORM_ID) return payload.demo && !outreachLive(env) ? null : "the practice form is only for the demo";
      if (payload.recipeId !== payload.orgId) return "form differs from what was authorised";
      return outreachLive(env) && !payload.demo ? null : "filling real organizations' forms isn't switched on (V360_OUTREACH_LIVE)";
    }
    if (type === "org_referral_email") {
      const intended = String(payload.intendedTo || "").toLowerCase();
      if (auth.destination.toLowerCase() !== `org:${payload.orgId}:${intended}`) return "organization differs from what was authorised";
      if (to === intended) return outreachLive(env) ? null : "emails to organizations aren't switched on (V360_OUTREACH_LIVE)";
      if (payload.demoRedirect && !outreachLive(env) && recipientAllowed(payload.to).ok) return null;
      return "recipient differs from what was authorised";
    }
    return auth.destination.toLowerCase() !== to ? "recipient differs from what was authorised" : null;
  }

  function orgNameOf(a) {
    try { return JSON.parse(store.getAction(a.id).payload_json).orgName || "the organization"; } catch { return "the organization"; }
  }

  return { transportName, recipientAllowed, runOnce, drain, runForm, retry, recordDelivery, outreachLive: () => outreachLive(env), outreachTestInbox: () => outreachTestInbox(env) };
}

function redact(s) {
  return s.replace(/re_[A-Za-z0-9_]{8,}/g, "re_***").replace(/Bearer\s+\S+/g, "Bearer ***").slice(0, 300);
}

function pickTransport(env) {
  const wantResend = (env.V360_EMAIL_TRANSPORT || (env.RESEND_API_KEY && env.V360_EMAIL_FROM ? "resend" : "outbox")) === "resend";
  if (wantResend) {
    return {
      name: "resend",
      async send({ to, cc, replyTo, subject, text, html, idempotencyKey }) {
        if (!env.RESEND_API_KEY || !env.V360_EMAIL_FROM) {
          const e = new Error("Email provider is not configured (RESEND_API_KEY / V360_EMAIL_FROM)"); e.permanent = true; throw e;
        }
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.slice(0, 64) },
          body: JSON.stringify({ from: env.V360_EMAIL_FROM, to: [to], ...(cc ? { cc: [cc] } : {}), ...(replyTo ? { reply_to: replyTo } : {}), subject, text, html }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const e = new Error(`Provider error ${res.status}: ${body && (body.message || body.name) || "unknown"}`);
          e.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
          throw e;
        }
        return body.id ? "resend:" + body.id : "resend:accepted";
      },
    };
  }
  const dir = env.V360_OUTBOX_DIR || path.join(ROOT_DIR, ".data", "outbox");
  return {
    name: "outbox",
    async send({ to, cc, replyTo, subject, text, html, actionId }) {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${actionId}.eml`);
      const boundary = "v360-" + actionId;
      const eml = [
        `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), ...(replyTo ? [`Reply-To: ${replyTo}`] : []), `From: Vision 360 CONNECT demo <demo@localhost>`, `Subject: ${subject}`, "MIME-Version: 1.0",
        `X-V360-Notice: LOCAL TEST OUTBOX - NOT SENT`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
        `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", text, "",
        `--${boundary}`, "Content-Type: text/html; charset=utf-8", "", html, "", `--${boundary}--`, "",
      ].join("\r\n");
      writeFileSync(file, eml);
      return "outbox:" + path.basename(file);
    },
  };
}
