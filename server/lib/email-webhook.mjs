// Resend delivery webhooks (sent through Svix). Verifies the signature with
// RESEND_WEBHOOK_SECRET ("whsec_..."), then maps the event to an outcome.
//   signed content: `${svix-id}.${svix-timestamp}.${raw body}`
//   svix-signature: space-separated "v1,<base64 HMAC-SHA256>" entries
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SEC = 5 * 60;

export function verifyWebhook(secret, headers, raw, now = Date.now()) {
  if (!secret) return false;
  const id = headers["svix-id"], ts = headers["svix-timestamp"], sigs = String(headers["svix-signature"] || "");
  if (!id || !ts || !sigs) return false;
  if (Math.abs(now / 1000 - Number(ts)) > TOLERANCE_SEC) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const want = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  return sigs.split(" ").some((s) => {
    const [v, b64] = s.split(",");
    if (v !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

// Returns { receipt, outcome, detail } for the events we track, else null.
export function deliveryEvent(evt) {
  const map = { "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained" };
  const outcome = evt && map[evt.type];
  const id = evt && evt.data && evt.data.email_id;
  if (!outcome || !id) return null;
  const detail = evt.data.bounce && (evt.data.bounce.message || evt.data.bounce.type);
  return { receipt: "resend:" + id, outcome, detail: detail || null };
}
