/* =========================================================================
   Assessment engine — pure logic, no DOM, no fetch, no page knowledge.

   This exists as its own file for one reason: Lions Services is building a
   VOICE AGENT that will run this same assessment over the phone. The web page
   and the phone agent must ask the same questions in the same order and reach
   the same answer, so the logic lives here and the branching lives in
   data/assessment.json. Neither can drift from the other.

   Everything it needs is passed in. Run it under node with no browser:

     const E = require("./site/quiz-engine.js");   // exposes VisionAssessment
     const s = E.create(assessment);
     E.answer(s, "veteran", "yes");
     E.score(s, organizations, geography).slice(0, 8);

   Scoring is SUMS ONLY, deliberately. A product or a weighting curve would be
   unexplainable out loud; a sum lets the agent say "I suggested this because
   you told me X and Y", which is the whole point.

   CLAUDE.md rule 2 applies here as much as to geography: `suppress` demotes and
   NEVER excludes. Every organization stays in the ranking, always.
   ========================================================================= */
/* Loader note: package.json sets "type": "module", so node treats this file as
   an ES module where `module` is undefined. It is also loaded in the browser by
   a plain <script> tag, which is not a module at all. globalThis is the one
   binding that exists and is writable in both, so the engine attaches there and
   a node test does:  await import("./site/quiz-engine.js"); globalThis.VisionAssessment
   The CommonJS export is kept for anyone requiring it from a .cjs harness. */
(function (factory) {
  var api = factory();
  globalThis.VisionAssessment = api;
  try { if (typeof module === "object" && module && module.exports) module.exports = api; }
  catch (e) { /* ESM: no module binding, globalThis is the export */ }
})(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     State. Answers are held in memory only and are never persisted — see
     the privacy note in the plan: this page is unlisted, not private, and
     the everyday block asks about a real person's housing and legal life.
     --------------------------------------------------------------------- */
  function create(assessment) {
    return {
      assessment: assessment || null,
      answers: Object.create(null),   /* questionId -> value | [values] */
      skippedBlocks: Object.create(null),
      order: []                       /* questionIds answered, in order */
    };
  }

  function questionById(state, id) {
    var qs = (state.assessment && state.assessment.questions) || [];
    for (var i = 0; i < qs.length; i++) if (qs[i].id === id) return qs[i];
    return null;
  }

  function blockOf(state, questionId) {
    var bs = (state.assessment && state.assessment.blocks) || [];
    for (var i = 0; i < bs.length; i++) {
      if ((bs[i].questions || []).indexOf(questionId) !== -1) return bs[i];
    }
    return null;
  }

  function asArray(v) {
    if (v === null || v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }

  /* ---------------------------------------------------------------------
     ask_if — a tiny condition language, kept deliberately small so the voice
     agent can implement it identically without a parser.

       null                         always ask
       {q, in:[...]}                ask when that answer is one of these
       {all:[cond, ...]}            every child true
       {any:[cond, ...]}            at least one child true
       {not: cond}                  child false
     --------------------------------------------------------------------- */
  function condTrue(state, cond) {
    if (!cond) return true;
    if (cond.all) return cond.all.every(function (c) { return condTrue(state, c); });
    if (cond.any) return cond.any.some(function (c) { return condTrue(state, c); });
    if (cond.not) return !condTrue(state, cond.not);
    if (cond.q) {
      var given = asArray(state.answers[cond.q]);
      var want = cond["in"] || [];
      return given.some(function (g) { return want.indexOf(g) !== -1; });
    }
    return true;
  }

  function shouldAsk(state, q) {
    if (!q) return false;
    var b = blockOf(state, q.id);
    if (b && state.skippedBlocks[b.id]) return false;
    return condTrue(state, q.ask_if);
  }

  /* Next unanswered question that passes its ask_if, in block order. */
  function nextQuestion(state) {
    var a = state.assessment;
    if (!a) return null;
    var blocks = a.blocks || [];
    for (var i = 0; i < blocks.length; i++) {
      if (state.skippedBlocks[blocks[i].id]) continue;
      var ids = blocks[i].questions || [];
      for (var j = 0; j < ids.length; j++) {
        var q = questionById(state, ids[j]);
        if (!q) continue;
        if (Object.prototype.hasOwnProperty.call(state.answers, q.id)) continue;
        if (!condTrue(state, q.ask_if)) continue;
        return q;
      }
    }
    return null;
  }

  function answer(state, questionId, value) {
    var q = questionById(state, questionId);
    if (!q) return state;
    state.answers[questionId] = value;
    if (state.order.indexOf(questionId) === -1) state.order.push(questionId);

    /* An answer can invalidate a later one: say yes to veteran, answer the VA
       questions, then change to no — those follow-ups must not keep scoring. */
    (state.assessment.questions || []).forEach(function (other) {
      if (other.id === questionId) return;
      if (!Object.prototype.hasOwnProperty.call(state.answers, other.id)) return;
      if (!condTrue(state, other.ask_if)) {
        delete state.answers[other.id];
        var at = state.order.indexOf(other.id);
        if (at !== -1) state.order.splice(at, 1);
      }
    });
    return state;
  }

  function skipBlock(state, blockId, skipped) {
    state.skippedBlocks[blockId] = skipped !== false;
    if (state.skippedBlocks[blockId]) {
      var b = null, bs = (state.assessment.blocks || []);
      for (var i = 0; i < bs.length; i++) if (bs[i].id === blockId) b = bs[i];
      if (b) (b.questions || []).forEach(function (id) {
        delete state.answers[id];
        var at = state.order.indexOf(id);
        if (at !== -1) state.order.splice(at, 1);
      });
    }
    return state;
  }

  function progress(state) {
    var asked = 0, answered = 0;
    (state.assessment.questions || []).forEach(function (q) {
      if (!shouldAsk(state, q)) return;
      asked++;
      if (Object.prototype.hasOwnProperty.call(state.answers, q.id)) answered++;
    });
    return { answered: answered, askable: asked, done: nextQuestion(state) === null };
  }

  /* ---------------------------------------------------------------------
     Scoring
     --------------------------------------------------------------------- */
  function chosenOptions(state, q) {
    var given = asArray(state.answers[q.id]);
    return (q.options || []).filter(function (o) { return given.indexOf(o.value) !== -1; });
  }

  /* Ranking is a plain sum plus the same tie-breaks the directory sort uses,
     so the quiz and the list never disagree about which of two equals comes
     first. geoRankFn is injected rather than imported: the engine must not
     know how geography works, only that some records are nearer. */
  var CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 };

  function score(state, orgs, geoRankFn) {
    var byId = Object.create(null);
    orgs.forEach(function (o) { byId[o.id] = o; });

    var points = Object.create(null);
    var reasons = Object.create(null);
    orgs.forEach(function (o) { points[o.id] = 0; reasons[o.id] = []; });

    function credit(orgId, weight, why, evidence) {
      if (!Object.prototype.hasOwnProperty.call(points, orgId)) return;  /* unknown id never invents a record */
      points[orgId] += weight;
      if (why) reasons[orgId].push({ text: why, weight: weight, evidence: evidence || null });
    }

    (state.assessment.questions || []).forEach(function (q) {
      if (!shouldAsk(state, q)) return;
      chosenOptions(state, q).forEach(function (opt) {
        (opt.effects || []).forEach(function (e) {
          var w = typeof e.weight === "number" ? e.weight : 0;
          if (e.op === "suppress") w = -Math.abs(w);
          if (e.target === "category") {
            orgs.forEach(function (o) {
              if ((o.categories || []).indexOf(e.id) !== -1) credit(o.id, w, e.because, e.evidence);
            });
          } else {
            credit(e.id, w, e.because, e.evidence);
          }
        });
      });
    });

    var ranked = orgs.map(function (o) {
      return {
        org: o,
        id: o.id,
        points: points[o.id],
        reasons: reasons[o.id],
        /* Surfaced so the UI can state quality honestly rather than implying
           every suggestion is equally solid. 52 of 96 records are unverified. */
        needs_research: o.needs_research === true,
        confidence: o.confidence
      };
    });

    ranked.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (geoRankFn) {
        var g = geoRankFn(a.org) - geoRankFn(b.org);
        if (g) return g;
      }
      var c = (CONFIDENCE_ORDER[a.confidence] || 3) - (CONFIDENCE_ORDER[b.confidence] || 3);
      if (c) return c;
      if (a.needs_research !== b.needs_research) return a.needs_research ? 1 : -1;
      return a.org.name.localeCompare(b.org.name);
    });

    return ranked;
  }

  /* Hand-offs whose trigger the current answers satisfy. These are the honest
     "we have nothing for this" paths — housing, food, utilities, benefits,
     general legal. They carry no score because there is nothing to score. */
  function handoffs(state) {
    return ((state.assessment && state.assessment.handoffs) || [])
      .filter(function (h) { return condTrue(state, h.trigger); });
  }

  /* Why a specific organization is where it is. Used by the UI and, later, by
     the phone agent reading a recommendation aloud. */
  function explain(state, orgId, ranked) {
    for (var i = 0; i < ranked.length; i++) {
      if (ranked[i].id === orgId) {
        return { rank: i + 1, points: ranked[i].points, reasons: ranked[i].reasons };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------------
     Geography. CLAUDE.md rule 3: geography SORTS, it never excludes.
     Every channel (directory, chat, voice, phone) ranks with these, so the
     order cannot drift between them. `geography` is site/data/geography.json
     or null; without it, ranking falls back to each record's verdict.

     Rank on (counties ∩ config) FIRST and verdict SECOND, never on counties
     alone: a county the config has never heard of must not demote an in_area
     record.
     --------------------------------------------------------------------- */
  var GEO_RANK = { home: 0, statewide: 1, adjacent: 2, region: 3, travel: 4, elsewhere: 5 };

  function tierCounties(geography, id) {
    var tiers = (geography && geography.tiers) || [];
    for (var i = 0; i < tiers.length; i++) if (tiers[i].id === id) return tiers[i].counties || [];
    return [];
  }

  function intersects(counties, list) {
    for (var i = 0; i < counties.length; i++) if (list.indexOf(counties[i]) !== -1) return true;
    return false;
  }

  function geoTier(org, geography) {
    var area = (org && org.service_area) || {};
    var counties = area.counties || [];
    var verdict = area.verdict;
    if (geography && counties.indexOf(geography.home_county) !== -1) return "home";
    if (!counties.length && verdict === "in_area") return "statewide";
    if (counties.length && intersects(counties, tierCounties(geography, "adjacent"))) return "adjacent";
    if (counties.length && intersects(counties, tierCounties(geography, "region"))) return "region";
    if (verdict === "statewide_travel_required") return "travel";
    /* A county we do not recognise, or partial/out_of_area. Fall back to the
       verdict so an unlisted-county in_area record is not buried. */
    if (verdict === "in_area") return "statewide";
    return "elsewhere";
  }

  /* Returns a rank function for score(); rank.tier(org) gives the tier id. */
  function geoRank(geography) {
    function rank(org) { return GEO_RANK[geoTier(org, geography)]; }
    rank.tier = function (org) { return geoTier(org, geography); };
    return rank;
  }

  /* ---------------------------------------------------------------------
     Result selection: how many of the ranked records each channel shows.
     Ranking is the same everywhere; only how much is shown differs.
       conversation  spoken/chat: up to 8 strong matches, no padding
       directory     Find services page: everything that scored, first 8
                     shown, the rest behind "show the other N"
     A policy can be overridden per name via settings.results[name].
     --------------------------------------------------------------------- */
  var RESULT_POLICIES = {
    conversation: { max: 8, minPoints: 30, relativeFloor: 0.4, showRest: false },
    directory: { max: 8, minPoints: 0, relativeFloor: 0, showRest: true }
  };

  function resultPolicy(name, settings) {
    var base = RESULT_POLICIES[name];
    if (!base) throw new Error("Unknown result policy: " + name);
    var over = (settings && settings.results && settings.results[name]) || {};
    var out = {};
    for (var k in base) out[k] = Object.prototype.hasOwnProperty.call(over, k) ? over[k] : base[k];
    return out;
  }

  function selectResults(ranked, name, settings) {
    var p = resultPolicy(name, settings);
    var top = ranked[0] ? ranked[0].points : 0;
    var floor = Math.max(p.minPoints, Math.round(top * p.relativeFloor));
    /* Nothing at or below zero is ever "a match"; suppress never excludes it
       from the directory, but it is not suggested. */
    var hits = ranked.filter(function (r) { return r.points > 0 && r.points >= floor; });
    return { top: hits.slice(0, p.max), rest: p.showRest ? hits.slice(p.max) : [], floor: floor, policy: p };
  }

  return {
    create: create,
    nextQuestion: nextQuestion,
    shouldAsk: shouldAsk,
    questionById: questionById,
    blockOf: blockOf,
    answer: answer,
    skipBlock: skipBlock,
    progress: progress,
    score: score,
    handoffs: handoffs,
    explain: explain,
    condTrue: condTrue,
    geoTier: geoTier,
    geoRank: geoRank,
    resultPolicy: resultPolicy,
    selectResults: selectResults
  };
});
