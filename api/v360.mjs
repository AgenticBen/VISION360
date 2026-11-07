// Vercel function for the Vision 360 CONNECT demo API. All /api/* requests are
// rewritten here (see vercel.json) and handled by the same code as the local
// server. With V360_SUPABASE_URL and V360_SUPABASE_SERVICE_KEY set,
// conversations and admin data are kept in Supabase and SQLite in /tmp is only
// a per-copy cache. Without them, everything in /tmp is TEMPORARY.
import { createApp } from "../server/lib/api.mjs";

let appPromise = null;

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = createApp({
      dbPath: process.env.V360_DB_PATH || "/tmp/v360-demo.sqlite",
      env: { V360_OUTBOX_DIR: "/tmp/v360-outbox", V360_ADMIN_STORE_DIR: "/tmp/v360-admin-store", ...process.env, V360_SERVERLESS: "1", V360_STORAGE: process.env.V360_SUPABASE_URL && process.env.V360_SUPABASE_SERVICE_KEY && !String(process.env.V360_SUPABASE_SERVICE_KEY).startsWith("sb_publishable_") ? "supabase" : process.env.V360_DB_PATH ? "configured" : "ephemeral" },
    });
  }
  const app = await appPromise;
  const u = new URL(req.url, "http://localhost");
  const original = u.searchParams.get("__path");
  if (original) {
    u.searchParams.delete("__path");
    const qs = u.searchParams.toString();
    req.url = original + (qs ? "?" + qs : "");
  }
  return app.handle(req, res);
}
