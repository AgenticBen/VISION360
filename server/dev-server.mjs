#!/usr/bin/env node
// Local demo server: serves the static site (including /demo and /staff) and
// the /api routes, and runs the email worker every few seconds.
//
//   npm run demo            -> http://localhost:8360/demo
//
// Reads optional settings from .env.local (never committed): RESEND_API_KEY,
// V360_EMAIL_FROM, V360_EMAIL_ALLOWLIST, V360_DB_PATH, PORT.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { createApp } from "./lib/api.mjs";
import { ROOT_DIR } from "./lib/corpus.mjs";

loadEnvFile(path.join(ROOT_DIR, ".env.local"));

const PORT = Number(process.env.PORT || 8360);
const SITE = path.join(ROOT_DIR, "site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const app = await createApp();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) return app.handle(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  let file = path.join(SITE, rel);
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
  if (!existsSync(file)) {
    // /demo -> /demo/index.html (Vercel does the same)
    const idx = path.join(SITE, rel, "index.html");
    if (existsSync(idx)) file = idx; else { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "microphone=(self), camera=()",
  });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Vision 360 CONNECT demo: http://localhost:${PORT}/demo   staff: http://localhost:${PORT}/staff`);
  console.log(`corpus ${app.corpus.version} · email transport: ${app.ctx.actions.transportName()} · db: ${app.store.path}`);
});

// Durable worker loop: picks up queued/retrying actions even after a restart.
setInterval(() => app.ctx.actions.drain(5).catch((e) => console.error("worker", e.message)), 3000);
// Retention purge.
const purge = () => { const n = app.store.purgeExpired(); if (n) console.log(`purged ${n} expired session(s)`); };
purge();
setInterval(purge, 3600 * 1000);

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
