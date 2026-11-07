// Serves the admin pages (the admin/ folder) from the server, so they are
// only sent to someone who is signed in. The sign-in page and its own files
// (admin/login/) are always public. Signed out: a page request goes to the
// sign-in page, anything else gets 401.
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./corpus.mjs";

export const ADMIN_DIR = path.join(ROOT_DIR, "admin");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

// Maps a URL path under /admin to a file, or null. Never leaves admin/.
export function adminFile(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (!rel.startsWith("/admin") || rel.includes("\0")) return null;
  rel = rel.slice("/admin".length) || "/";
  const file = path.normalize(path.join(ADMIN_DIR, rel));
  if (file !== ADMIN_DIR && !file.startsWith(ADMIN_DIR + path.sep)) return null;
  let f = file;
  if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
  if (!existsSync(f) || !statSync(f).isFile()) return null;
  if (!TYPES[path.extname(f)]) return null;
  return f;
}

export function isPublicAdminPath(pathname) {
  return /^\/admin\/login(\/|$)/.test(pathname);
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
};

// signedIn: whether the request carries a valid admin session.
export function serveAdmin(req, res, url, signedIn) {
  const p = url.pathname;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  if (!signedIn && !isPublicAdminPath(p)) {
    const wantsPage = !path.extname(p) || p.endsWith(".html");
    if (wantsPage) {
      const next = p + (url.search || "");
      res.writeHead(302, { Location: "/admin/login/?next=" + encodeURIComponent(next), ...HEADERS });
      return res.end();
    }
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", ...HEADERS });
    return res.end("Sign in to the admin first.");
  }
  const file = adminFile(p);
  if (!file) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...HEADERS }); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], ...HEADERS });
  return res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}
