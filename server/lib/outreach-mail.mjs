// The referral email sent to an organization on the person's behalf, only
// after they agreed to exactly this message. Built from fixed sentences, the
// organization's public directory record and the name and contact details the
// person confirmed. It never includes their answers (health, money, housing…)
// or the reasons a service was suggested, and it never says they "qualify":
// each organization decides eligibility.
import { createHash } from "node:crypto";

export const ORG_EMAIL_PURPOSE = "Ask the organization to contact the person, as the person agreed";

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// The service names from the public record, as a short readable list.
function serviceList(match) {
  const labels = (match.services || []).map((s) => s.label).filter(Boolean).slice(0, 3);
  if (!labels.length) return "your services";
  return labels.length === 1 ? labels[0] : labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1];
}

// person: { name, helperName?, phone?, email?, preferred: "phone"|"email" }
export function buildOrgReferral(match, person, opts = {}) {
  const name = person.name;
  const subject = `${opts.demo ? "[DEMO] " : ""}Referral request: please contact ${name} (Vision 360 CONNECT)`;
  const how = [person.phone ? `Phone: ${person.phone}` : null, person.email ? `Email: ${person.email}` : null].filter(Boolean);
  const preferred = person.preferred === "email" && person.email ? "email" : person.phone ? "phone" : "email";
  const lines = [];
  if (opts.demo) {
    lines.push(`DEMO — this message was meant for ${match.name}${opts.intendedTo ? " <" + opts.intendedTo + ">" : ""}. It was sent to the demo test inbox instead; nothing went to the organization.`, "");
  }
  lines.push(`Hello ${match.name} team,`, "");
  lines.push(`I'm writing from Vision 360 CONNECT, the Lions Services vision resource assistant, on behalf of ${name}${person.helperName ? ` (with help from ${person.helperName})` : ""}. ${name} asked us to put them in touch with you.`);
  lines.push("");
  lines.push(`Based on what they told us, they may be eligible for ${serviceList(match)}. Your team decides eligibility.`);
  lines.push("");
  lines.push(`Please reach out to ${name}:`);
  how.forEach((h) => lines.push(`   ${h}`));
  lines.push(`   Best way to reach them: ${preferred}`);
  lines.push("");
  lines.push("They agreed to us sharing their name and contact details with you. We haven't shared anything else about them.");
  lines.push("If this isn't the right place for referrals, please reply and let us know.");
  lines.push("");
  lines.push("Thank you,");
  lines.push("Vision 360 CONNECT · Lions Services, Inc. · Charlotte, NC");
  const text = lines.join("\n");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:16px;background:#ffffff;color:#16191d;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:1.5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px"><tr><td>
${opts.demo ? `<p style="background:#fff2d6;color:#5a3b00;border:2px solid #8a5300;padding:8px 12px;border-radius:6px">${esc(lines[0])}</p>` : ""}
<p>Hello ${esc(match.name)} team,</p>
<p>I'm writing from Vision 360 CONNECT, the Lions Services vision resource assistant, on behalf of <strong>${esc(name)}</strong>${person.helperName ? ` (with help from ${esc(person.helperName)})` : ""}. ${esc(name)} asked us to put them in touch with you.</p>
<p>Based on what they told us, they may be eligible for ${esc(serviceList(match))}. Your team decides eligibility.</p>
<p><strong>Please reach out to ${esc(name)}:</strong></p>
<ul>${person.phone ? `<li>Phone: <a href="tel:${esc(person.phone.replace(/[^\d+]/g, ""))}">${esc(person.phone)}</a></li>` : ""}${person.email ? `<li>Email: <a href="mailto:${esc(person.email)}">${esc(person.email)}</a></li>` : ""}<li>Best way to reach them: ${preferred}</li></ul>
<p>They agreed to us sharing their name and contact details with you. We haven't shared anything else about them. If this isn't the right place for referrals, please reply and let us know.</p>
<p>Thank you,<br>Vision 360 CONNECT · Lions Services, Inc. · Charlotte, NC</p>
</td></tr></table></body></html>`;

  const hash = createHash("sha256").update([subject, text, html].join("\n")).digest("hex");
  return { subject, text, html, hash };
}
