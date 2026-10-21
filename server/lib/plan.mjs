// The emailed action plan. Built deterministically from the confirmed results
// (which come from directory records) — no model-written URLs, contacts or
// costs. It deliberately leaves out the person's answers about health, money,
// housing and so on: the email lists services, not the person's situation.
import { createHash } from "node:crypto";

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function buildPlan(corpus, results, opts = {}) {
  const subject = "Your Vision 360 CONNECT plan (demo)";
  const lines = [];
  if (opts.name) lines.push(`Hi ${opts.name},`, "");
  lines.push("Your Vision 360 CONNECT plan");
  lines.push("This is a DEMONSTRATION email from the Lions Services Vision 360 CONNECT prototype.");
  lines.push("");
  lines.push(`Here are ${results.matches.length} services suggested from the Lions Services directory, best match first.`);
  lines.push("Each organization decides who qualifies. Please contact them to confirm details before relying on them.");
  lines.push("");
  results.matches.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.name}`);
    lines.push(`   What they do: ${m.oneLine}`);
    if (m.reasons[0]) lines.push(`   Why it's suggested: ${m.reasons[0]}`);
    if (m.accessPath[0]) lines.push(`   First step: ${m.accessPath[0].action}${m.accessPath[0].detail ? " — " + m.accessPath[0].detail : ""}`);
    if (m.contacts.general_phone) lines.push(`   Phone: ${m.contacts.general_phone}`);
    if (m.contacts.general_email) lines.push(`   Email: ${m.contacts.general_email}`);
    if (m.contacts.website) lines.push(`   Website: ${m.contacts.website}`);
    if (m.contacts.intake_form_url) lines.push(`   Referral or intake form: ${m.contacts.intake_form_url}`);
    if (m.cost) lines.push(`   Cost: ${m.cost}`);
    if (m.documentation.length) lines.push(`   Documents: ${m.documentation[0]}`);
    m.uncertainty.forEach((u) => lines.push(`   Note: ${u}`));
    lines.push(`   Full listing: ${m.url}`);
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

  const card = (m, i) => `
  <section style="border:1px solid #c9ced6;border-radius:8px;padding:14px 16px;margin:0 0 14px">
    <h2 style="font-size:20px;margin:0 0 6px">${i + 1}. ${esc(m.name)}</h2>
    <p style="margin:0 0 8px">${esc(m.oneLine)}</p>
    ${m.reasons[0] ? `<p style="margin:0 0 8px"><strong>Why it's suggested:</strong> ${esc(m.reasons[0])}</p>` : ""}
    ${m.accessPath[0] ? `<p style="margin:0 0 8px"><strong>First step:</strong> ${esc(m.accessPath[0].action)}${m.accessPath[0].detail ? " — " + esc(m.accessPath[0].detail) : ""}</p>` : ""}
    <ul style="margin:0 0 8px;padding-left:20px">
      ${m.contacts.general_phone ? `<li>Phone: ${esc(m.contacts.general_phone)}</li>` : ""}
      ${m.contacts.general_email ? `<li>Email: ${esc(m.contacts.general_email)}</li>` : ""}
      ${m.contacts.website ? `<li>Website: <a href="${esc(m.contacts.website)}">${esc(m.contacts.website)}</a></li>` : ""}
      ${m.contacts.intake_form_url ? `<li>Referral or intake form: <a href="${esc(m.contacts.intake_form_url)}">${esc(m.contacts.intake_form_url)}</a></li>` : ""}
      ${m.cost ? `<li>Cost: ${esc(m.cost)}</li>` : ""}
    </ul>
    ${m.uncertainty.map((u) => `<p style="margin:0 0 6px;color:#5a3b00">Note: ${esc(u)}</p>`).join("")}
    <p style="margin:0"><a href="${esc(m.url)}">Full listing in the directory</a></p>
  </section>`;
  const html = `<!doctype html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#14171c;max-width:680px;margin:0 auto;padding:16px">
  ${opts.name ? `<p>Hi ${esc(opts.name)},</p>` : ""}
  <h1 style="font-size:26px;margin:0 0 8px">Your Vision 360 CONNECT plan</h1>
  <p style="background:#fff2d6;border:1px solid #8a5300;padding:8px 12px;border-radius:6px">This is a demonstration email from the Lions Services Vision 360 CONNECT prototype.</p>
  <p>Here are ${results.matches.length} services suggested from the Lions Services directory, best match first. Each organization decides who qualifies — please contact them to confirm details.</p>
  ${results.matches.map(card).join("")}
  ${results.handoffs.map((h) => `<section style="border:1px solid #8a5300;border-radius:8px;padding:14px 16px;margin:0 0 14px"><h2 style="font-size:20px;margin:0 0 6px">${esc(h.headline)}</h2><p>${esc(h.body)}</p>${h.referTo.map((r) => `<p><a href="${esc(r.url)}">${esc(r.name)}</a>${r.contacts.general_phone ? " — " + esc(r.contacts.general_phone) : ""}</p>`).join("")}</section>`).join("")}
  <p style="color:#545b66;font-size:15px">Generated from directory data version ${esc(corpus.version)}. <a href="${esc(results.directoryUrl)}">Open the full directory</a>.</p>
  </body></html>`;

  const hash = createHash("sha256").update(subject + "\n" + text).digest("hex");
  return { subject, text, html, hash };
}
