// The emailed action plan. Built deterministically from the confirmed results
// (which come from directory records) — no model-written URLs, contacts or
// costs. It deliberately leaves out the person's answers about health, money,
// housing and so on: the email lists services, not the person's situation.
//
// The HTML follows the person's on-screen text size and colors (see
// email-style.mjs). It uses tables with inline colors because many email
// clients drop <body> and <style> rules. The plain-text part has the same
// content in the same order.
import { createHash } from "node:crypto";
import { emailStyle } from "./email-style.mjs";

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const UNPUBLISHED = /not published|unknown|verification call required/i;

// One card's facts, shared by the text and HTML parts.
function cardFacts(m) {
  const first = m.accessPath[0];
  return {
    title: `${m.rank || ""}. ${m.name}`.replace(/^\. /, ""),
    strength: m.strength ? (m.rank === 1 ? `#1 · ${m.strength.words}` : `#${m.rank} · ${m.strength.words}`) : null,
    reasons: (m.reasons || []).slice(0, 2),
    oneLine: m.oneLine,
    firstStep: first ? `${first.action}${first.detail ? " — " + first.detail : ""}` : null,
    phone: m.contacts.general_phone,
    email: m.contacts.general_email,
    form: m.contacts.intake_form_url,
    website: m.contacts.website,
    cost: m.cost,
    wait: m.typicalWait && !UNPUBLISHED.test(m.typicalWait) ? m.typicalWait : null,
    documents: (m.documentation || []).slice(0, 2),
    notes: m.uncertainty || [],
    url: m.url,
  };
}

// The first plain email address in a contact field (some list several, with notes).
function mailtoOf(email) {
  const m = String(email || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}
// Phone fields can hold several numbers or notes; link the first number.
function telOf(phone) {
  const m = String(phone || "").match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}

export function buildPlan(corpus, results, opts = {}) {
  const look = emailStyle(opts.display);
  const { colors: c, px } = look;
  const subject = "Your Vision 360 CONNECT plan (demo)";
  const cards = results.matches.map(cardFacts);

  // ---------------------------------------------------------- plain text
  const lines = [];
  if (opts.name) lines.push(`Hi ${opts.name},`, "");
  lines.push("Your Vision 360 CONNECT plan");
  lines.push("This is a DEMONSTRATION email from the Lions Services Vision 360 CONNECT prototype.");
  lines.push("");
  lines.push(`Here are ${results.matches.length} services suggested from the Lions Services directory, best match first.`);
  lines.push("Each organization decides who is eligible. Please contact them to confirm details before relying on them.");
  lines.push("");
  cards.forEach((f) => {
    lines.push(f.title);
    if (f.strength) lines.push(`   Match: ${f.strength}`);
    lines.push(`   What they do: ${f.oneLine}`);
    f.reasons.forEach((r) => lines.push(`   Why it's suggested: ${r}`));
    if (f.firstStep) lines.push(`   First step: ${f.firstStep}`);
    if (f.phone) lines.push(`   Phone: ${f.phone}`);
    if (f.email) lines.push(`   Email: ${f.email}`);
    if (f.form) lines.push(`   Online form: ${f.form}`);
    if (f.website) lines.push(`   Website: ${f.website}`);
    if (f.cost) lines.push(`   Cost: ${f.cost}`);
    if (f.wait) lines.push(`   Typical wait: ${f.wait}`);
    f.documents.forEach((d) => lines.push(`   Bring: ${d}`));
    f.notes.forEach((u) => lines.push(`   Note: ${u}`));
    lines.push(`   Full listing: ${f.url}`);
    lines.push("");
  });
  results.handoffs.forEach((h) => {
    lines.push(`Also: ${h.headline}`);
    lines.push(`   ${h.body}`);
    h.referTo.forEach((r) => lines.push(`   ${r.name}${r.contacts.general_phone ? " — " + r.contacts.general_phone : ""} — ${r.url}`));
    lines.push("");
  });
  lines.push(`Directory: ${results.directoryUrl}`);
  lines.push(`Generated from directory data version ${corpus.version}. Listing details were last verified on the dates shown in the directory.`);
  const text = lines.join("\n");

  // ---------------------------------------------------------------- HTML
  const link = (href, label) => `<a href="${esc(href)}" style="color:${c.accent};text-decoration:underline">${esc(label)}</a>`;
  const p = (inner, extra = "") => `<p style="margin:0 0 ${Math.round(px.base * 0.5)}px;${extra}">${inner}</p>`;
  const row = (label, value) => p(`<strong>${esc(label)}:</strong> ${value}`);
  const card = (f) => {
    const tel = telOf(f.phone), mail = mailtoOf(f.email);
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.surface}" style="background:${c.surface};border:2px solid ${c.line};border-radius:10px;margin:0 0 ${px.base}px">
<tr><td style="padding:${Math.round(px.base * 0.8)}px;color:${c.ink};font-size:${px.base}px;line-height:1.5">
  <h2 style="font-size:${px.h2}px;line-height:1.3;margin:0 0 6px;color:${c.ink}">${esc(f.title)}</h2>
  ${f.strength ? p(`<strong style="color:${c.accent}">${esc(f.strength)}</strong>`) : ""}
  ${p(esc(f.oneLine))}
  ${f.reasons.map((r) => row("Why it's suggested", esc(r))).join("")}
  ${f.firstStep ? row("First step", esc(f.firstStep)) : ""}
  ${f.phone ? row("Phone", tel ? `<a href="tel:${tel}" style="color:${c.accent};text-decoration:underline">${esc(f.phone)}</a>` : esc(f.phone)) : ""}
  ${f.email ? row("Email", mail ? `<a href="mailto:${esc(mail)}" style="color:${c.accent};text-decoration:underline">${esc(f.email)}</a>` : esc(f.email)) : ""}
  ${f.form ? row("Online form", link(f.form, f.form)) : ""}
  ${f.website ? row("Website", link(f.website, f.website)) : ""}
  ${f.cost ? row("Cost", esc(f.cost)) : ""}
  ${f.wait ? row("Typical wait", esc(f.wait)) : ""}
  ${f.documents.map((d) => row("Bring", esc(d))).join("")}
  ${f.notes.map((u) => p(`Note: ${esc(u)}`, `color:${c.muted}`)).join("")}
  ${p(link(f.url, "Full listing in the directory"), "margin:0")}
</td></tr></table>`;
  };
  const handoff = (h) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.noteBg}" style="background:${c.noteBg};border:2px solid ${c.noteLine};border-radius:10px;margin:0 0 ${px.base}px">
<tr><td style="padding:${Math.round(px.base * 0.8)}px;color:${c.noteInk};font-size:${px.base}px;line-height:1.5">
  <h2 style="font-size:${px.h2}px;margin:0 0 6px;color:${c.noteInk}">${esc(h.headline)}</h2>
  ${p(esc(h.body))}
  ${h.referTo.map((r) => p(`${link(r.url, r.name)}${r.contacts.general_phone ? " — " + esc(r.contacts.general_phone) : ""}`)).join("")}
</td></tr></table>`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="${look.display.theme === "standard" ? "light" : "dark"}"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title></head>
<body bgcolor="${c.page}" style="margin:0;padding:0;background:${c.page};color:${c.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background:${c.page}">
<tr><td align="center" style="padding:16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${Number(look.display.textSize) >= 300 ? "100%" : "720px"}">
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:${px.base}px;line-height:1.5;color:${c.ink};word-break:break-word">
  ${opts.name ? p(`Hi ${esc(opts.name)},`) : ""}
  <h1 style="font-size:${px.h1}px;line-height:1.25;margin:0 0 ${Math.round(px.base * 0.5)}px;color:${c.ink}">Your Vision 360 CONNECT plan</h1>
  ${p("This is a demonstration email from the Lions Services Vision 360 CONNECT prototype.", `background:${c.noteBg};color:${c.noteInk};border:2px solid ${c.noteLine};padding:8px 12px;border-radius:6px`)}
  ${p(`Here are ${results.matches.length} services suggested from the Lions Services directory, best match first. Each organization decides who is eligible, so please contact them to confirm details.`)}
  ${cards.map(card).join("")}
  ${results.handoffs.map(handoff).join("")}
  ${p(`Generated from directory data version ${esc(corpus.version)}. ${link(results.directoryUrl, "Open the full directory")}.`, `color:${c.muted};font-size:${px.small}px`)}
</td></tr></table>
</td></tr></table>
</body></html>`;

  // The hash covers everything that is sent, including how it looks, so the
  // consent matches exactly what goes out.
  const hash = createHash("sha256").update([subject, text, html, JSON.stringify(look.display)].join("\n")).digest("hex");
  return { subject, text, html, hash, display: look.display };
}
