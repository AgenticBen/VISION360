// Runs INSIDE a Vercel Sandbox VM (headless Chromium via Playwright), never on
// the site's own servers. Reads one job (base64 JSON in argv[2]) and prints one
// JSON result line.
//
//   mode "inspect"  load the page, list its form fields (nothing typed or sent)
//   mode "dry"      fill the fields and take a screenshot, but don't submit
//   mode "fill"     fill, submit, and check for the success sign
//
// Stops at once on any CAPTCHA or bot check (see detect.mjs), and when the
// page's fields no longer match the approved recipe.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { detectBlocker, fieldsKey } from "./detect.mjs";

const job = JSON.parse(Buffer.from(process.argv[2] || "", "base64").toString("utf8"));
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); };

async function listFields(page) {
  return page.$$eval("form input, form select, form textarea", (els) => els.map((el) => {
    const type = (el.getAttribute("type") || el.tagName).toLowerCase();
    if (["hidden", "submit", "button", "image", "reset", "file", "password"].includes(type)) return null;
    const id = el.getAttribute("id");
    const name = el.getAttribute("name");
    const selector = id ? `#${CSS.escape(id)}` : name ? `${el.tagName.toLowerCase()}[name="${name}"]` : null;
    if (!selector) return null;
    let label = "";
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) label = l.textContent; }
    if (!label && el.closest("label")) label = el.closest("label").textContent;
    if (!label) label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || name || "";
    const kind = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : ["email", "tel", "radio", "checkbox"].includes(type) ? type : "text";
    const options = el.tagName === "SELECT" ? [...el.options].map((o) => o.value || o.textContent.trim()) : undefined;
    return { selector, kind, label: label.replace(/\s+/g, " ").trim().slice(0, 120), required: el.required || el.getAttribute("aria-required") === "true", options, value: kind === "radio" || kind === "checkbox" ? el.value : undefined };
  }).filter(Boolean));
}

const shot = async (page) => (await page.screenshot({ type: "jpeg", quality: 55, fullPage: true })).toString("base64");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ userAgent: "Vision360-CONNECT-referral-helper (Lions Services; acting for a person who asked us to)" });
  const res = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  let blocker = detectBlocker({ html: await page.content(), status: res ? res.status() : 0 });
  if (blocker) { out({ outcome: "blocked", detail: blocker }); process.exit(0); }
  const fields = await listFields(page);
  const fieldsHash = createHash("sha256").update(fieldsKey(fields)).digest("hex");
  if (job.mode === "inspect") { out({ outcome: "inspected", fields, fieldsHash, title: await page.title(), screenshot: await shot(page) }); process.exit(0); }

  const r = job.recipe;
  if (r.fingerprint && r.fingerprint.fieldsHash && r.fingerprint.fieldsHash !== fieldsHash) { out({ outcome: "page_changed", detail: "The form's fields are different from the approved recipe." }); process.exit(0); }
  for (const f of r.fields) {
    const v = job.values[f.source];
    if (v === undefined || v === null || v === "") { if (f.required) { out({ outcome: "field_missing", detail: `No value for required field ${f.label || f.selector}` }); process.exit(0); } continue; }
    const loc = page.locator(f.selector).first();
    if (!(await loc.count())) { out({ outcome: "field_missing", detail: `Field not found: ${f.label || f.selector}` }); process.exit(0); }
    const val = String(v).slice(0, f.maxLength || 2000);
    if (f.kind === "select") await loc.selectOption((f.optionMap && f.optionMap[val]) || val);
    else if (f.kind === "radio") await page.locator(`${f.selector}[value="${(f.optionMap && f.optionMap[val]) || val}"]`).first().check();
    else if (f.kind === "checkbox") { if (val === "true" || val === true) await loc.check(); }
    else await loc.fill(val);
  }
  const filled = await shot(page);
  if (job.mode === "dry") { out({ outcome: "dry_run_ok", screenshot: filled }); process.exit(0); }

  await page.locator(r.submit.selector).first().click();
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const after = await page.content();
  blocker = detectBlocker({ html: after });
  if (blocker) { out({ outcome: "blocked", detail: "After pressing submit, " + blocker }); process.exit(0); }
  const s = r.success || {};
  const ok = (s.urlIncludes && page.url().includes(s.urlIncludes)) || (s.textIncludes && after.includes(s.textIncludes)) || (s.selectorVisible && await page.locator(s.selectorVisible).first().isVisible().catch(() => false));
  out(ok ? { outcome: "submitted" } : { outcome: "unconfirmed", detail: "The form was submitted but the page didn't show the expected confirmation." });
} catch (e) {
  out({ outcome: /timeout/i.test(String(e && e.message)) ? "timeout" : "error", detail: String(e && e.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
