// Grounded results: every name, reason, contact, cost and step below is copied
// from a directory record or from the assessment's own "because" text. The
// existing engine (site/quiz-engine.js) does the ranking; nothing here
// re-weights or filters records by rules of its own, except choosing how many
// of the top-ranked records to show so weak matches are not padded in.
import { canonicalUrl } from "./corpus.mjs";

export const MAX_RESULTS = 8;
export const MIN_POINTS = 30;          // below this a match rests on one weak signal
export const RELATIVE_FLOOR = 0.4;     // and must be within 40% of the top match

const NOT_PUBLISHED = /not published|verification call required|unknown/i;

function shortText(s, n = 220) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s;
}

function publicContacts(org) {
  const c = org.contacts || {};
  return {
    website: c.website || null,
    general_phone: c.general_phone || null,
    general_email: c.general_email || null,
    address: c.address || null,
    intake_form_url: c.intake_form_url || null,
    named_staff: (c.named_staff || []).filter((s) => s.public_safe === true).map((s) => ({ name: s.name, title: s.title, email: s.email || null, phone: s.phone || null })),
  };
}

export function recordView(corpus, org) {
  const steps = (org.access_path || []).slice().sort((a, b) => a.order - b.order).map((s) => ({
    order: s.order,
    actor: s.actor,
    action: s.action,
    detail: s.detail,
    duration: s.duration,
    blocking: !!s.blocking,
    requires: s.requires || [],
    branches: (s.branches || []).map((b) => ({
      condition: b.condition,
      note: b.note,
      goto: b.goto_org_id && corpus.byId.get(b.goto_org_id) ? { id: b.goto_org_id, name: corpus.byId.get(b.goto_org_id).name, url: canonicalUrl(b.goto_org_id) } : null,
    })),
  }));
  const uncertainty = [];
  if (org.needs_research) uncertainty.push("Some details in this listing still need to be verified with the organization.");
  if (NOT_PUBLISHED.test(org.cost || "")) uncertainty.push("Cost isn't published — ask when you contact them.");
  if (NOT_PUBLISHED.test(org.typical_wait || "")) uncertainty.push("Waiting time isn't published.");
  return {
    id: org.id,
    name: org.name,
    aliases: org.also_known_as || [],
    parent: org.parent_org_id && corpus.byId.get(org.parent_org_id) ? { id: org.parent_org_id, name: corpus.byId.get(org.parent_org_id).name } : null,
    oneLine: org.one_line,
    services: (org.services || []).map((s) => ({ label: s.label, plain: s.plain_language })),
    whoQualifies: org.who_qualifies || [],
    documentation: org.documentation_required || [],
    cost: org.cost || null,
    typicalWait: org.typical_wait || null,
    thirdPartyReferral: org.accepts_third_party_referral || null,
    serviceArea: org.service_area ? { counties: org.service_area.counties || [], note: org.service_area.note || null, tier: corpus.geoRank.tier(org) } : null,
    accessPath: steps,
    firstStep: steps[0] ? `${steps[0].action}` : null,
    contacts: publicContacts(org),
    lastVerified: org.last_verified || null,
    confidence: org.confidence || null,
    needsResearch: !!org.needs_research,
    openQuestionCount: (org.open_questions || []).length,
    uncertainty,
    url: canonicalUrl(org.id),
  };
}

export function buildResults(corpus, engineState, answers) {
  const E = corpus.engine;
  const ranked = E.score(engineState, corpus.organizations, corpus.geoRank);
  const top = ranked[0] ? ranked[0].points : 0;
  const floor = Math.max(MIN_POINTS, Math.round(top * RELATIVE_FLOOR));
  const chosen = ranked.filter((r) => r.points >= floor).slice(0, MAX_RESULTS);

  const matches = chosen.map((r, i) => {
    const view = recordView(corpus, r.org);
    const seen = new Set();
    const reasons = r.reasons.filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight).filter((x) => !seen.has(x.text) && seen.add(x.text)).map((x) => x.text);
    const cautions = r.reasons.filter((x) => x.weight < 0).map((x) => x.text);
    return { rank: i + 1, points: r.points, reasons, cautions, ...view };
  });

  const handoffs = E.handoffs(engineState).map((h) => ({
    id: h.id,
    headline: h.headline,
    body: h.body,
    missingRecordNote: h.missing_record_note || null,
    referTo: (h.refer_to || []).filter((id) => corpus.byId.has(id)).map((id) => recordView(corpus, corpus.byId.get(id))),
  }));

  const unresolved = answers.filter((a) => a.kind !== "answer").map((a) => ({ questionId: a.questionId, kind: a.kind }));

  return {
    generatedAt: new Date().toISOString(),
    totalRanked: ranked.length,
    shownBecause: `Showing the ${matches.length} best-matched services (score at least ${floor}). Every other service is still in the full directory.`,
    matches,
    handoffs,
    unresolved,
    directoryUrl: "https://vision360.agenticarc.ai/",
  };
}

// What the assistant says aloud: one or two starting points, not the whole list.
export function resultsSpeech(results) {
  const m = results.matches;
  const parts = ["Thank you for confirming."];
  if (!m.length) {
    parts.push("I couldn't find a strong match in the directory for those answers, and I won't guess. A staff member can help — just say talk to a person.");
  } else {
    parts.push(`Based on what you told me, a good place to start is ${m[0].name}. ${m[0].reasons[0] || m[0].oneLine}`);
    if (m[1]) parts.push(`Another good starting point is ${m[1].name}. ${m[1].reasons[0] || m[1].oneLine}`);
    if (m.length > 2) parts.push(`I've listed ${m.length} suggestions on screen, with what each one does, how to start, costs and contacts.`);
  }
  if (results.handoffs.length) parts.push(`You also mentioned something this directory doesn't cover, so I've added where to turn for that, and flagged it for staff.`);
  if (results.unresolved.length) parts.push("Some answers weren't known, so a few suggestions may change once those are clearer.");
  parts.push("Would you like me to email this plan, ask a staff member to follow up, or tell you more about one of them? For example, say: tell me about number two.");
  const text = parts.join(" ");
  return { text, speech: text };
}
