// QR encoder. The fingerprints below are of codes that were checked to scan
// back to exactly these texts with Chrome's barcode reader (2026-11-07); any
// change to the encoder that alters them must be re-checked the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qrMatrix, qrSvg } from "../server/lib/qr.mjs";
import { makeApp, call } from "./helpers.mjs";

const fp = (m) => createHash("sha256").update(m.modules.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex").slice(0, 16);

test("verified codes stay the same", () => {
  for (const [text, version, mask, hash] of [
    ["HI", 1, 2, "c5eab2c2fe1a4e59"],
    ["https://vision360.agenticarc.ai/f/v360-interest", 4, 4, "ade9a01684b720d5"],
    ["q".repeat(213), 10, 1, "86d0337bea63245b"],
  ]) {
    const m = qrMatrix(text);
    assert.equal(m.version, version);
    assert.equal(m.mask, mask);
    assert.equal(fp(m), hash, text.slice(0, 30));
  }
});

test("structure: finder patterns, timing, dark module, size", () => {
  const m = qrMatrix("https://vision360.agenticarc.ai/f/referral");
  assert.equal(m.size, m.version * 4 + 17);
  const g = m.modules;
  for (const [x0, y0] of [[0, 0], [m.size - 7, 0], [0, m.size - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(g[y0][x0 + i], true); assert.equal(g[y0 + 6][x0 + i], true);
      assert.equal(g[y0 + i][x0], true); assert.equal(g[y0 + i][x0 + 6], true);
    }
    assert.equal(g[y0 + 1][x0 + 1], false);
    assert.equal(g[y0 + 3][x0 + 3], true);
  }
  for (let i = 8; i < m.size - 8; i++) { assert.equal(g[6][i], i % 2 === 0); assert.equal(g[i][6], i % 2 === 0); }
  assert.equal(g[m.size - 8][8], true);
});

test("too long is refused; SVG has a quiet zone and a title", () => {
  assert.throws(() => qrMatrix("x".repeat(214)), /too long/);
  const svg = qrSvg("HI", { title: "Workflow <link>" });
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.match(svg, /<title>Workflow &lt;link&gt;<\/title>/);
});

test("QR endpoint: published workflows only, encodes the public link", async () => {
  const app = await makeApp();
  let r = await call(app, "GET", "/api/qr/v360-interest.svg");
  assert.equal(r.status, 200);
  assert.match(r.headers["Content-Type"], /image\/svg\+xml/);
  const want = qrSvg("http://localhost:8360/f/v360-interest", { title: "V360 TECH interest form" });
  assert.equal(String(r.raw), want);
  r = await call(app, "GET", "/api/qr/nope.svg");
  assert.equal(r.status, 404);
  const hosted = await makeApp({ V360_SERVERLESS: "1" });
  r = await call(hosted, "GET", "/api/qr/referral.svg");
  assert.equal(String(r.raw), qrSvg("https://vision360.agenticarc.ai/f/referral", { title: "Referral finder" }));
});
