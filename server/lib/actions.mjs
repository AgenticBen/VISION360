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

const MAX_ATTEMPTS = 5;

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

export const EMAIL_PURPOSE = "Send the confirmed referral plan to the person";

// The same person, address, plan and answer revision always give the same
// key, so a retried "yes" can never queue a second email.
export function emailIdempotencyKey(sessionId, recipient, planHash, revision) {
  return sha([sessionId, "email_plan", recipient.toLowerCase(), planHash, revision].join("|"));
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
  async function runOnce() {
    const action = store.claimDueAction();
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
    if (auth && auth.destination.toLowerCase() !== String(payload.to).toLowerCase()) problems.push("recipient differs from what was authorised");
    if (session && session.revision !== action.revision) problems.push("answers changed after authorisation");
    if (!rec || rec.id !== payload.recommendationId) problems.push("recommendation is no longer current");
    if (problems.length) {
      store.updateAction(action.id, { status: "cancelled", error: problems.join("; "), lease_until: null });
      store.audit("worker", action.session_id, "action_cancelled", { actionId: action.id, problems });
      return { id: action.id, status: "cancelled" };
    }
    try {
      const receipt = await transport.send({ to: payload.to, subject: payload.subject, text: payload.text, html: payload.html, idempotencyKey: action.idempotency_key, actionId: action.id });
      const status = transport.name === "outbox" ? "mock_written" : "provider_accepted";
      store.updateAction(action.id, { status, provider: transport.name, provider_receipt: receipt, error: null, lease_until: null });
      store.audit("worker", action.session_id, "action_" + status, { actionId: action.id, provider: transport.name });
      return { id: action.id, status };
    } catch (e) {
      const attempts = action.attempts;
      const msg = redact(String(e && e.message || e));
      if (attempts >= MAX_ATTEMPTS || e.permanent) {
        store.updateAction(action.id, { status: "failed", error: msg, lease_until: null, provider: transport.name });
        store.createStaffReview(action.session_id, "Automatic: email plan failed to send — " + msg.slice(0, 120), null, false);
        store.audit("worker", action.session_id, "action_failed", { actionId: action.id });
        return { id: action.id, status: "failed" };
      }
      const delay = Math.min(300, 5 * 2 ** (attempts - 1));
      store.updateAction(action.id, { status: "retrying", error: msg, lease_until: null, next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(), provider: transport.name });
      return { id: action.id, status: "retrying" };
    }
  }

  async function drain(limit = 10) {
    const out = [];
    for (let i = 0; i < limit; i++) {
      const r = await runOnce();
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
      store.createStaffReview(a.session_id, "Automatic: the emailed plan " + (outcome === "complained" ? "was marked as spam" : "bounced") + " — please follow up another way", null, false);
      store.audit("provider", a.session_id, "action_" + outcome, { actionId: a.id });
    }
    return a.session_id;
  }

  return { transportName, recipientAllowed, runOnce, drain, retry, recordDelivery };
}

function redact(s) {
  return s.replace(/re_[A-Za-z0-9_]{8,}/g, "re_***").replace(/Bearer\s+\S+/g, "Bearer ***").slice(0, 300);
}

function pickTransport(env) {
  const wantResend = (env.V360_EMAIL_TRANSPORT || (env.RESEND_API_KEY && env.V360_EMAIL_FROM ? "resend" : "outbox")) === "resend";
  if (wantResend) {
    return {
      name: "resend",
      async send({ to, subject, text, html, idempotencyKey }) {
        if (!env.RESEND_API_KEY || !env.V360_EMAIL_FROM) {
          const e = new Error("Email provider is not configured (RESEND_API_KEY / V360_EMAIL_FROM)"); e.permanent = true; throw e;
        }
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.slice(0, 64) },
          body: JSON.stringify({ from: env.V360_EMAIL_FROM, to: [to], subject, text, html }),
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
    async send({ to, subject, text, html, actionId }) {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${actionId}.eml`);
      const boundary = "v360-" + actionId;
      const eml = [
        `To: ${to}`, `From: Vision 360 CONNECT demo <demo@localhost>`, `Subject: ${subject}`, "MIME-Version: 1.0",
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
