// Golden routing: run a fixed sample person's answers through a flow and
// return the services recommended. Used by the golden tests and by the
// workflow editor's impact preview (before vs after a change).
import { buildResults } from "./results.mjs";

// Answers are applied in question order so follow-up questions (for example
// va_enrolled after veteran) are only kept when their condition holds.
export function routeWith(corpus, assessment, persona) {
  const E = corpus.engine;
  const c = assessment === corpus.assessment ? corpus : { ...corpus, assessment };
  const st = E.create(assessment);
  for (const b of persona.skippedBlocks || []) E.skipBlock(st, b);
  for (const q of assessment.questions) {
    if (Object.prototype.hasOwnProperty.call(persona.answers, q.id)) E.answer(st, q.id, persona.answers[q.id]);
  }
  const results = buildResults(c, st, []);
  return {
    matches: results.matches.map((m) => m.id),
    handoffs: results.handoffs.map((h) => h.id),
    detail: results.matches.map((m) => ({ id: m.id, points: m.points, reason: m.reasons[0] || "" })),
  };
}

// Before/after for every persona: who now gets different suggestions.
export function impact(corpus, before, after, personas) {
  const rows = personas.map((p) => {
    const a = routeWith(corpus, before, p);
    const b = routeWith(corpus, after, p);
    const added = b.matches.filter((id) => !a.matches.includes(id));
    const removed = a.matches.filter((id) => !b.matches.includes(id));
    const reordered = !added.length && !removed.length && JSON.stringify(a.matches) !== JSON.stringify(b.matches);
    const handoffs = JSON.stringify(a.handoffs) !== JSON.stringify(b.handoffs);
    return { id: p.id, label: p.label || p.id, before: a.matches, after: b.matches, added, removed, reordered, handoffsBefore: a.handoffs, handoffsAfter: b.handoffs, changed: !!(added.length || removed.length || reordered || handoffs) };
  });
  return { personas: rows.length, changed: rows.filter((r) => r.changed).length, rows };
}
