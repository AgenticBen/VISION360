// Vercel function for contacting organizations for people: form jobs (a
// browser in a Vercel Sandbox VM can take a minute), "run now" from the admin,
// and Admin › Outreach. Same app code as api/v360.mjs, with a longer time
// limit (vercel.json) and form jobs allowed (V360_FORM_WORKER).
import { createApp } from "../server/lib/api.mjs";

let appPromise = null;

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = createApp({
      dbPath: process.env.V360_DB_PATH || "/tmp/v360-demo.sqlite",
      env: { V360_OUTBOX_DIR: "/tmp/v360-outbox", V360_ADMIN_STORE_DIR: "/tmp/v360-admin-store", ...process.env, V360_SERVERLESS: "1", V360_FORM_WORKER: "1", V360_STORAGE: process.env.V360_SUPABASE_URL && process.env.V360_SUPABASE_SERVICE_KEY && !String(process.env.V360_SUPABASE_SERVICE_KEY).startsWith("sb_publishable_") ? "supabase" : process.env.V360_DB_PATH ? "configured" : "ephemeral" },
    });
  }
  const app = await appPromise;
  const u = new URL(req.url, "http://localhost");
  const original = u.searchParams.get("__path");
  if (original) {
    u.searchParams.delete("__path");
    for (const k of ["path", "id"]) if (u.searchParams.get(k) !== null && original.includes(u.searchParams.get(k))) u.searchParams.delete(k);
    const qs = u.searchParams.toString();
    req.url = original + (qs ? "?" + qs : "");
  }
  return app.handle(req, res);
}
