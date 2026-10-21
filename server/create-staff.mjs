#!/usr/bin/env node
// Creates (or resets) a staff account for the protected staff queue.
//   npm run staff:create -- <username> [output-file]
// A random password is generated and written to the output file (default:
// ../private-audit/staff-login.txt, outside the public repo). It is not printed.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openStore } from "./lib/store.mjs";
import { hashPassword } from "./lib/auth.mjs";
import { ROOT_DIR } from "./lib/corpus.mjs";

const username = String(process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9._-]{3,40}$/.test(username)) { console.error("Usage: npm run staff:create -- <username>"); process.exit(1); }
const out = process.argv[3] || path.join(ROOT_DIR, "..", "private-audit", "staff-login.txt");
const password = randomBytes(12).toString("base64url");
const store = openStore();
store.createStaffUser(username, hashPassword(password));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `Vision 360 CONNECT demo — staff sign-in (local)\nURL: http://localhost:8360/staff\nUsername: ${username}\nPassword: ${password}\n`, { mode: 0o600 });
console.log(`Staff account "${username}" ready. Password written to ${out}`);
