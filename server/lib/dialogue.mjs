// Dialogue manager shared by voice and typed chat.
//
// The browser sends what the person said or typed; this module decides what
// happens and what the assistant says. Voice and text use exactly the same
// path, so there is one set of business rules. Policies enforced here (not in
// a prompt):
//   - one question at a time, from site/data/assessment.json, in its order
//   - proposed answers are kept separate from confirmed ones
//   - unknown, declined, skipped and not-asked are never treated as "no"
//   - personalised matching only after an explicit recap confirmation that
//     names the CURRENT answer revision; a stale "yes" is rejected
//   - any change after confirmation invalidates results and cancels
//     not-yet-started actions
// Wording lives in phrasing.mjs: names, "you" vs their name, open questions,
// natural acknowledgements. It never changes questions, options or routing.
import { createHash } from "node:crypto";
import {
  interpretAnswer, extractMany, detectGlobal, yesNo, strictConfirm, findCorrectionTarget, mentionedTopics,
  looksLikeCorrection, parseEmail, parseName, spellEmail, normalize,
} from "./understand.mjs";
import { buildResults, resultsSpeech } from "./results.mjs";
import { buildPlan } from "./plan.mjs";
import { who, askOpen, askWithChoices, sectionIntro, ack, recapLine, screenLabel, greetingText, joinList, noConcernTopic } from "./phrasing.mjs";

export const POLICY_VERSION = "dialogue-2026-10-21.2";

const KIND_TEXT = { unknown: "not sure", declined: "preferred not to say", skipped: "skipped" };

const RECAP_LABEL = {
  actor: "Looking for",
  county: "Where they live",
  goals: "Help wanted with",
  age_band: "Age",
  hearing_loss: "Hearing loss",
  eye_doctor: "Has an eye doctor",
  eye_exam_recency: "Last eye exam",
  insurance: "Health insurance",
  veteran: "Served in the military",
  va_enrolled: "Signed up for VA health care",
  discharge: "Discharge",
  housing_stable: "Housing steady",
  food_worry: "Food running out",
  utilities: "Utility shut-off threats",
  transport_barrier: "Transportation problems",
  legal_matter: "Legal matters",
  loneliness: "Feeling lonely or cut off",
  broadband: "Internet at home",
  devices: "Devices",
};

// ------------------------------------------------------------------ helpers
export function newDialogueState() {
  return {
    phase: "name",
    names: { caller: null, subject: null },
    subjectNameAsked: false,
    currentQuestion: null,
    pending: null,
    skippedBlocks: [],
    offeredBlocks: [],
    unclearCount: {},
    recapRevision: null,
    confirmedRevision: null,
    email: null,
    staff: null,
    wrapStep: null,
    ackN: 0,
    lastAssistant: null,
    turnSeq: 0,
  };
}

function q(corpus, id) {
  return corpus.questionById.get(id);
}

export function optionLabel(question, value, screen = false) {
  const one = (v) => {
    const o = (question.options || []).find((x) => x.value === v);
    if (!o) return String(v);
    return screen ? (o.label_screen || o.label_voice) : (o.label_voice || o.label_screen);
  };
  if (Array.isArray(value)) return joinList(value.map(one));
  return one(value);
}

function answerText(corpus, a, screen = false) {
  const question = q(corpus, a.questionId);
  if (a.kind === "answer" && a.detail && ["age_band", "county"].includes(a.questionId)) return a.detail;
  if (a.kind === "answer") return optionLabel(question, a.value, screen);
  // "I don't know" shows as "not sure" everywhere, matching what the assistant said,
  // even when the closest option reads differently ("Never, or cannot remember").
  if (a.kind === "unknown") return KIND_TEXT.unknown;
  return KIND_TEXT[a.kind] || a.kind;
}

// Build a quiz-engine state from stored answers. Unknown/declined/skipped are
// recorded as "asked, nothing chosen" (null) so they are never re-asked and
// never count as an option — except a real "not sure" option, which the
// directory's own rules use (for example the benefits-counselling hand-off).
export function engineState(corpus, answers, skippedBlocks) {
  const E = corpus.engine;
  const st = E.create(corpus.assessment);
  for (const a of answers) {
    if (a.kind === "answer" || (a.kind === "unknown" && a.value)) st.answers[a.questionId] = a.value;
    else st.answers[a.questionId] = null;
    st.order.push(a.questionId);
  }
  for (const b of skippedBlocks || []) st.skippedBlocks[b] = true;
  return st;
}

function questionPayload(question, w) {
  if (!question) return null;
  const prompt = askOpen(question, w);
  return {
    id: question.id,
    prompt,
    prompt_screen: prompt,
    help: question.help,
    type: question.type,
    skippable: question.skippable !== false,
    sensitive: !!question.sensitive,
    options: (question.options || []).map((o) => ({ value: o.value, label: o.label_screen || o.label_voice })),
  };
}

// ------------------------------------------------------------------ engine
export function createDialogue(ctx) {
  const { corpus } = ctx;
  // Optional AI readings for the current turn, passed in explicitly by the
  // turn service (never stored on the session). Empty when AI is off.
  let turnAi = {};

  function answersOf(session) {
    const order = corpus.assessment.questions.map((x) => x.id);
    return session.work.getAnswers().sort((a, b) => order.indexOf(a.questionId) - order.indexOf(b.questionId));
  }

  function whoFor(session) {
    return who(answersOf(session), session.state.names);
  }

  function bumpRevision(session) {
    session.revision += 1;
    // Any change after a confirmation invalidates the confirmation, the results
    // built from it, and any action not yet started.
    if (session.state.confirmedRevision !== null || session.state.recapRevision !== null) {
      const staleRecs = session.work.markRecommendationsStale();
      const cancelled = session.work.cancelStaleActions(session.revision);
      // Anything already handed over can't be unsent: flag it for staff to reconcile.
      const sent = session.work.actionsForSession().filter((a) => ["provider_accepted", "mock_written", "running"].includes(a.status) && a.revision < session.revision);
      if (sent.length && !session.work.staffReviews().some((r) => r.reason.startsWith("Automatic: answers changed after"))) {
        session.work.createStaffReview("Automatic: answers changed after an email plan was already sent — please reconcile", null, false);
        session.state.sentBeforeChange = true;
      }
      if (staleRecs || cancelled) session.work.audit("system", "invalidated", { staleRecommendations: staleRecs, cancelledActions: cancelled, revision: session.revision });
    }
    session.state.confirmedRevision = null;
    session.state.recapRevision = null;
  }

  function setAnswer(session, questionId, kind, value, source, detail = null) {
    bumpRevision(session);
    session.work.putAnswer({ questionId, kind, value: value ?? null, revision: session.revision, source, detail });
    session.work.answerEvent(questionId, "proposed", value ?? null, kind, session.revision);
    pruneNotApplicable(session);
  }

  // Changing "veteran" to no means the VA follow-ups no longer apply. Remove
  // them (recorded as an event) rather than letting them keep scoring.
  function pruneNotApplicable(session) {
    let changed = true;
    while (changed) {
      changed = false;
      const answers = answersOf(session);
      const st = engineState(corpus, answers, session.state.skippedBlocks);
      for (const a of answers) {
        if (!corpus.engine.shouldAsk(st, q(corpus, a.questionId))) {
          session.work.deleteAnswer(a.questionId);
          session.work.answerEvent(a.questionId, "removed_not_applicable", null, null, session.revision);
          changed = true;
          break;
        }
      }
    }
  }

  function nextQuestion(session) {
    const st = engineState(corpus, answersOf(session), session.state.skippedBlocks);
    return corpus.engine.nextQuestion(st);
  }

  function progress(session) {
    const st = engineState(corpus, answersOf(session), session.state.skippedBlocks);
    return corpus.engine.progress(st);
  }

  // ---------------------------------------------------------------- output
  function reply(session, parts, extra = {}) {
    const text = parts.filter(Boolean).join(" ");
    session.state.turnSeq += 1;
    const turnId = `${session.id.slice(0, 8)}-${session.state.turnSeq}`;
    const speech = extra.speech || text;
    session.state.lastAssistant = { turnId, text, speech };
    return { turnId, text, speech, ...extra };
  }

  function snapshot(session) {
    const w = whoFor(session);
    const answers = answersOf(session).map((a) => ({
      questionId: a.questionId,
      label: screenLabel(a.questionId, w, RECAP_LABEL[a.questionId] || a.questionId),
      kind: a.kind,
      value: a.value,
      detail: a.detail || null,
      display: answerText(corpus, a, true),
      status: a.confirmedRevision !== null && a.confirmedRevision !== undefined && a.confirmedRevision === session.state.confirmedRevision ? "confirmed" : "proposed",
      source: a.source,
    }));
    const rec = session.work.currentRecommendation();
    return {
      sessionId: session.id,
      revision: session.revision,
      phase: session.state.phase,
      names: session.state.names,
      confirmedRevision: session.state.confirmedRevision,
      currentQuestion: session.state.phase === "intake" && session.state.currentQuestion ? questionPayload(q(corpus, session.state.currentQuestion), w) : null,
      pending: session.state.pending ? { type: session.state.pending.type, options: session.state.pending.options || null } : null,
      answers,
      progress: progress(session),
      results: rec && rec.revision === session.revision ? rec.result : null,
      actions: session.work.actionsForSession().map(publicAction),
      staffRequested: session.work.staffReviews().some((r) => r.reason.startsWith("Requested")),
      email: session.state.email ? { address: session.state.email.address || null, step: session.state.email.step } : null,
      corpusVersion: session.corpus_version,
      policyVersion: POLICY_VERSION,
      lastAssistant: session.state.lastAssistant,
    };
  }

  function recapPayload(session) {
    const w = whoFor(session);
    const items = answersOf(session).map((a) => ({
      questionId: a.questionId,
      label: screenLabel(a.questionId, w, RECAP_LABEL[a.questionId] || a.questionId),
      display: answerText(corpus, a, true),
      kind: a.kind,
    }));
    return { revision: session.revision, items };
  }

  function lineFor(session, a) {
    return recapLine(q(corpus, a.questionId), a, whoFor(session), RECAP_LABEL[a.questionId] || a.questionId);
  }

  function recapSpeech(session) {
    const lines = [];
    const fine = [];
    for (const a of answersOf(session)) {
      const topic = noConcernTopic(a);
      if (topic) fine.push(topic); else lines.push(lineFor(session, a));
    }
    if (fine.length) lines.push(`no concerns about ${joinList(fine, "or")}`);
    return joinList(lines, "and");
  }

  // ---------------------------------------------------------------- phases
  function askNext(session, lead = []) {
    const st = session.state;
    const w = whoFor(session);
    // Helping someone else: learn their first name once, so we can use it.
    if (!w.self && !st.subjectNameAsked && !st.names.subject) {
      st.subjectNameAsked = true;
      st.phase = "intake";
      st.pending = { type: "subject_name" };
      return reply(session, [...lead, "What's their first name? It helps me and the staff keep things straight. You can skip that if you'd like."], { expect: "name" });
    }
    const nq = nextQuestion(session);
    if (!nq) return startRecap(session, lead);
    st.phase = "intake";
    st.currentQuestion = nq.id;
    st.pending = null;
    const block = corpus.engine.blockOf(engineState(corpus, answersOf(session), st.skippedBlocks), nq.id);
    const parts = [...lead];
    if (block && !st.offeredBlocks.includes(block.id)) {
      st.offeredBlocks.push(block.id);
      const intro = sectionIntro(block.id, w);
      if (block.skippable_as_block) {
        st.pending = { type: "block_offer", blockId: block.id };
        parts.push(intro || "The next questions are optional. Would you like to go through them, or skip them?");
        return reply(session, parts, { expect: "block_offer", question: null, block: { id: block.id, title: block.title } });
      }
      if (intro) parts.push(intro);
    }
    parts.push(askOpen(nq, w));
    return reply(session, parts, { expect: "answer", question: questionPayload(nq, w) });
  }

  function startRecap(session, lead = []) {
    const st = session.state;
    st.phase = "recap";
    st.currentQuestion = null;
    st.pending = null;
    st.recapAwaitingChange = false;
    st.recapRevision = session.revision;
    const recap = recapPayload(session);
    const name = st.names.caller;
    const text = [...lead, `Okay${name ? ", " + name : ""}, before I suggest anything, let me make sure I have this right.`, `${recapSpeech(session).replace(/^./, (c) => c.toUpperCase())}.`, "Does that all sound right? If anything's off, just tell me what to change."];
    return reply(session, text, { expect: "confirm_recap", recap });
  }

  function confirmRecap(session) {
    const st = session.state;
    st.confirmedRevision = session.revision;
    session.work.confirmAllAnswers(session.revision);
    session.work.answerEvent(null, "recap_confirmed", null, null, session.revision);
    session.work.audit("caller", "recap_confirmed", { revision: session.revision });
    let results;
    try {
      results = buildResults(corpus, engineState(corpus, answersOf(session), st.skippedBlocks), answersOf(session));
    } catch (e) {
      session.work.createStaffReview("Automatic: matching failed — " + String(e.message).slice(0, 120), null, false);
      st.phase = "results";
      st.wrapStep = "staff";
      return reply(session, ["Thank you. Something went wrong on my side while finding services, so I can't give you suggestions right now, and I won't guess.", "I've flagged this for a Lions Services staff member to review.", staffQuestion(session)], { expect: "yes_no" });
    }
    results.revision = session.revision;
    results.corpusVersion = corpus.version;
    results.policyVersion = POLICY_VERSION;
    // Which deployed code produced this result (set by Vercel; "local" otherwise).
    results.commit = (ctx.env || process.env).VERCEL_GIT_COMMIT_SHA || "local";
    const recId = session.work.saveRecommendation(session.revision, corpus.version, results);
    results.recommendationId = recId;
    if (results.handoffs.length && !session.work.staffReviews().some((r) => r.reason.startsWith("Automatic: needs help"))) {
      session.work.createStaffReview("Automatic: needs help this directory does not cover — " + results.handoffs.map((h) => h.id).join(", "), null, false);
    }
    st.phase = "results";
    st.wrapStep = "email";
    const speech = resultsSpeech(results, { name: st.names.caller, closing: "Would you like me to email you this plan?" });
    return reply(session, [speech.text], { expect: "results", results, speech: speech.speech });
  }

  // -------------------------------------------------------------- wrap-up
  function staffQuestion(session) {
    const w = whoFor(session);
    return w.self || !w.name
      ? "Would you like someone from Lions Services to reach out and help with next steps?"
      : `Would you like someone from Lions Services to reach out to you about next steps for ${w.name}?`;
  }

  function anythingElse() {
    return "Is there anything else I can help with today?";
  }

  function closeSession(session, lead = []) {
    const st = session.state;
    const name = st.names.caller;
    const bits = [];
    if (session.work.actionsForSession().some((a) => a.type === "email_plan" && !["cancelled", "failed"].includes(a.status))) bits.push("your plan is on its way by email");
    if (session.work.staffReviews().some((r) => r.reason.startsWith("Requested"))) bits.push("your request is with the Lions Services team");
    st.phase = "closed";
    st.wrapStep = "done";
    session.status = "ended";
    session.work.audit("caller", "session_completed", null);
    return reply(session, [...lead, `You're all set${name ? ", " + name : ""}.`, `Your suggestions will stay on the screen${bits.length ? ", and " + joinList(bits) : ""}.`, "Thanks so much for talking with me. Take care!"], { expect: "ended" });
  }

  // -------------------------------------------------------------- corrections
  function tryCorrection(session, text, { requireCue }) {
    if (requireCue && !looksLikeCorrection(text)) return null;
    const askable = answersOf(session).map((a) => a.questionId);
    const target = findCorrectionTarget(text, corpus.assessment, askable, { geography: corpus.geography });
    if (!target) return null;
    if (target.ambiguousTargets) {
      session.state.pending = { type: "which_correction", candidates: target.ambiguousTargets, resumePhase: session.state.phase };
      const names = target.ambiguousTargets.map((id) => (RECAP_LABEL[id] || id).toLowerCase());
      return reply(session, [`Which one do you want to change: ${joinList(names, "or")}?`], { expect: "free" });
    }
    const question = q(corpus, target.questionId);
    const interp = target.interpretation;
    if (interp.kind === "answer" || interp.kind === "unknown" || interp.kind === "declined") {
      setAnswer(session, target.questionId, interp.kind, interp.value ?? null, "correction", interp.detail || null);
      session.work.answerEvent(target.questionId, "corrected", interp.value ?? null, interp.kind, session.revision);
      const now = answersOf(session).find((a) => a.questionId === target.questionId);
      return { applied: true, questionId: target.questionId, ack: `Okay, I've changed that — ${now ? lineFor(session, now) : "noted"}.` };
    }
    // We know which question, not the new value: ask it again.
    session.state.pending = { type: "reask_for_correction", questionId: target.questionId, resumePhase: session.state.phase };
    return reply(session, ["Sure, let's fix that.", askOpen(question, whoFor(session))], { expect: "answer", question: questionPayload(question, whoFor(session)) });
  }

  // ------------------------------------------------------------------ turn
  // input: {text, choice?: {questionId, value}, action?, revision?, mode}
  function handle(session, input) {
    turnAi = (input && input.interpretations) || {};
    try { return handleTurn(session, input); } finally { turnAi = {}; }
  }

  function handleTurn(session, input) {
    const text = String(input.text || "").slice(0, 1000);
    const st = session.state;
    if (!st.names) st.names = { caller: null, subject: null };
    const g = detectGlobal(text);

    // Explicit structured actions from buttons -------------------------------
    if (input.action === "confirm_recap") {
      if (st.phase !== "recap") return reply(session, ["There's no summary waiting for confirmation right now."], { expect: "free" });
      if (Number(input.revision) !== session.revision || st.recapRevision !== session.revision) {
        session.work.audit("system", "stale_confirmation_rejected", { offered: input.revision, current: session.revision });
        return startRecap(session, ["Something changed since that summary, so I can't use that confirmation."]);
      }
      return confirmRecap(session);
    }
    if (input.action === "edit_answer" && input.questionId) {
      const question = q(corpus, input.questionId);
      if (!question || !answersOf(session).some((a) => a.questionId === input.questionId)) return reply(session, ["I can't find that answer to change."], { expect: "free" });
      st.pending = { type: "reask_for_correction", questionId: question.id, resumePhase: st.phase === "intake" ? "intake" : "recap" };
      return reply(session, ["Sure, let's change that.", askOpen(question, whoFor(session))], { expect: "answer", question: questionPayload(question, whoFor(session)) });
    }
    if (input.action === "request_email") return beginEmail(session);
    if (input.action === "request_staff") return beginStaff(session);
    if (input.action === "finish") return closeSession(session);
    if (input.action === "skip") return handleAnswerText(session, "skip", null);
    if (input.action === "unknown") return handleAnswerText(session, "I don't know", null);
    if (input.action === "decline") return handleAnswerText(session, "I'd rather not say", null);

    if (!text.trim() && !input.choice) return reply(session, ["Take your time."], { expect: "same", silent: true });

    // Global intents ---------------------------------------------------------
    if (g.repeat && st.lastAssistant) {
      return { ...st.lastAssistant, repeated: true };
    }
    if (g.end && !g.staff) return closeSession(session);
    if (g.startOver) {
      st.pending = { type: "confirm_restart", resumePhase: st.phase };
      return reply(session, ["Do you want to clear everything and start over? Say yes to start over, or no to carry on."], { expect: "yes_no" });
    }
    if (g.staff && !["staff_contact", "staff_confirm", "name"].includes(st.phase)) return beginStaff(session);

    // First name ------------------------------------------------------------
    if (st.phase === "name") return handleName(session, text);

    // Pending sub-dialogues -----------------------------------------------
    if (st.pending && st.pending.type === "subject_name") {
      st.pending = null;
      const nm = g.declined || g.skip ? null : parseName(text);
      if (nm) st.names.subject = nm;
      const leadText = nm ? `Thanks — I'll call them ${nm}.` : (g.declined || g.skip ? "No problem." : "That's okay, we'll carry on.");
      return askNext(session, [leadText]);
    }
    if (st.pending && st.pending.type === "confirm_restart") {
      const yn = yesNo(text);
      const resume = st.pending.resumePhase;
      st.pending = null;
      if (yn === "yes") {
        bumpRevision(session);
        session.work.deleteAllAnswers();
        session.work.answerEvent(null, "restarted", null, null, session.revision);
        const keep = { turnSeq: st.turnSeq, lastAssistant: st.lastAssistant, names: { caller: st.names.caller, subject: null } };
        session.state = Object.assign(newDialogueState(), keep);
        session.state.phase = "intake";
        return askNext(session, ["Okay, starting over."]);
      }
      st.phase = resume;
      return resumeAfterAside(session, ["Okay, carrying on."]);
    }
    if (st.pending && st.pending.type === "which_correction") {
      const cand = st.pending.candidates.find((id) => normalize(text).includes(normalize(RECAP_LABEL[id] || id).trim()) || normalize(text).includes(" " + id.replace(/_/g, " ") + " "));
      if (cand) {
        const question = q(corpus, cand);
        st.pending = { type: "reask_for_correction", questionId: cand, resumePhase: st.pending.resumePhase };
        return reply(session, [askOpen(question, whoFor(session))], { expect: "answer", question: questionPayload(question, whoFor(session)) });
      }
    }
    if (st.pending && st.pending.type === "reask_for_correction") {
      const question = q(corpus, st.pending.questionId);
      const interp = input.choice && input.choice.questionId === question.id ? { kind: "answer", value: input.choice.value } : interpretAnswer(text, question, { geography: corpus.geography });
      if (interp.kind === "ambiguous") return clarify(session, question, interp, st.pending);
      if (interp.kind === "unclear") return reply(session, ["Sorry, I didn't quite catch that.", askWithChoices(question, whoFor(session))], { expect: "answer", question: questionPayload(question, whoFor(session)) });
      const resume = st.pending.resumePhase;
      st.pending = null;
      setAnswer(session, question.id, interp.kind, interp.value ?? null, "correction", interp.detail || null);
      session.work.answerEvent(question.id, "corrected", interp.value ?? null, interp.kind, session.revision);
      const after = answersOf(session).find((a) => a.questionId === question.id);
      const ackText = `Okay, I've changed that — ${after ? lineFor(session, after) : "noted"}.`;
      if (resume === "intake") return askNext(session, [ackText]);
      return afterCorrection(session, ackText);
    }

    // Phase handlers ---------------------------------------------------------
    switch (st.phase) {
      case "opening": return handleOpening(session, text);
      case "intake": return handleIntake(session, text, input);
      case "recap": return handleRecap(session, text, input);
      case "results": return handleResults(session, text);
      case "email_address":
      case "email_confirm_address":
      case "email_consent": return handleEmail(session, text);
      case "staff_contact":
      case "staff_confirm": return handleStaff(session, text);
      case "closed": return reply(session, ["This session has ended. Start a new one to begin again."], { expect: "ended" });
      default: return askNext(session);
    }
  }

  function handleName(session, text) {
    const st = session.state;
    const g = detectGlobal(text);
    const name = g.declined || g.skip ? null : parseName(text);
    const words = normalize(text).trim().split(" ").filter(Boolean).length;
    if (!name && !g.declined && !g.skip && words <= 4) {
      st.nameTries = (st.nameTries || 0) + 1;
      if (st.nameTries < 2) return reply(session, ["Sorry, I didn't catch your name. What should I call you? You can also say skip."], { expect: "name" });
    }
    st.names.caller = name;
    st.phase = "opening";
    // They jumped straight into describing things: treat that as the opening.
    if (!name && words > 4) return handleOpening(session, text, ["Thanks for telling me."]);
    const hello = name ? `Nice to meet you, ${name}!` : "No problem.";
    return reply(session, [hello, "So, tell me a little about what's going on. Is this for you or for someone else, and what kind of help are you looking for?"], { expect: "free" });
  }

  function resumeAfterAside(session, lead) {
    const st = session.state;
    if (st.phase === "intake") return askNext(session, lead);
    if (st.phase === "recap") return startRecap(session, lead);
    if (st.phase === "results") return reply(session, [...lead, wrapQuestion(session)], { expect: "results" });
    return askNext(session, lead);
  }

  function wrapQuestion(session) {
    const st = session.state;
    if (st.wrapStep === "email") return "Would you like me to email you this plan?";
    if (st.wrapStep === "staff") return staffQuestion(session);
    if (st.wrapStep === "anything") return anythingElse();
    return "You can ask me about any of the suggestions, or say you're all done.";
  }

  function afterCorrection(session, ackText) {
    // After confirmation, a change means the old suggestions no longer apply.
    const hadResults = ["results", "email_address", "email_confirm_address", "email_consent", "staff_contact", "staff_confirm"].includes(session.state.phase);
    const lead = [ackText];
    if (hadResults) lead.push("That changes things, so I've set aside the earlier suggestions and cancelled anything that hadn't started.");
    if (session.state.sentBeforeChange) { lead.push("The earlier email had already gone out, so I can't take it back — I've flagged it for a staff member to sort out."); session.state.sentBeforeChange = false; }
    // New follow-up questions may now apply (e.g. veteran changed to yes).
    if (nextQuestion(session)) {
      session.state.phase = "intake";
      return askNext(session, [...lead, "That opens up a follow-up question."]);
    }
    return startRecap(session, lead);
  }

  function handleOpening(session, text, leadIn = []) {
    const st = session.state;
    const n = normalize(text);
    const justAsk = /just ask|ask me|questions|not sure where to start|don't know where to start/.test(n);
    const lead = [...leadIn];
    if (!justAsk) {
      const found = extractMany(text, corpus.assessment, { geography: corpus.geography });
      // Optional AI extraction fills questions the rules didn't catch.
      for (const a of (turnAi.extract || [])) if (!found.some((f) => f.questionId === a.questionId)) found.push({ ...a, phrase: "ai", ai: true });
      for (const f of found) {
        const est = engineState(corpus, answersOf(session), st.skippedBlocks);
        if (!corpus.engine.shouldAsk(est, q(corpus, f.questionId))) continue;
        setAnswer(session, f.questionId, "answer", f.value, f.ai ? "opening (AI-understood)" : "opening", f.detail || null);
      }
      const got = answersOf(session);
      if (got.length) {
        lead.push(`Thanks${st.names.caller ? ", " + st.names.caller : ""}. So far I've got that ${joinList(got.map((a) => lineFor(session, a)))}.`);
        lead.push("I'll double-check everything with you at the end.");
      } else if (!leadIn.length) {
        lead.push("Thanks for sharing that. I'll ask a few quick questions to find the right services.");
      }
    } else {
      lead.push("Sure thing.");
    }
    st.phase = "intake";
    return askNext(session, lead);
  }

  function clarify(session, question, interp, keepPending) {
    const names = interp.options.map((v) => optionLabel(question, v));
    const reason = interp.reason ? `Just to check — ${interp.reason}.` : "Just to check.";
    const w = whoFor(session);
    session.state.pending = keepPending && keepPending.type === "reask_for_correction"
      ? { ...keepPending, clarifyOptions: interp.options }
      : { type: "clarify", questionId: question.id, options: interp.options };
    const qp = questionPayload(question, w);
    return reply(session, [reason, `Would you say ${joinList(names, "or")}?`], {
      expect: "answer",
      question: { ...qp, options: qp.options.filter((o) => interp.options.includes(o.value)).concat(qp.options.filter((o) => ["not_sure", "never_or_unknown"].includes(o.value) && !interp.options.includes(o.value))) },
    });
  }

  function handleIntake(session, text, input) {
    const st = session.state;
    // Section offer ("go through them, or skip them?")
    if (st.pending && st.pending.type === "block_offer") {
      const n = normalize(text);
      const blockId = st.pending.blockId;
      st.pending = null;
      if (detectGlobal(text).skipSection || detectGlobal(text).skip || / skip /.test(n) || yesNo(text) === "no") {
        bumpRevision(session);
        st.skippedBlocks.push(blockId);
        session.work.answerEvent(null, "section_skipped:" + blockId, null, "skipped", session.revision);
        return askNext(session, ["No problem, we'll skip those."]);
      }
      const nq = nextQuestion(session);
      st.currentQuestion = nq ? nq.id : null;
      // If they started answering straight away ("we're behind on rent"),
      // treat it as an answer — but a plain "yes, go ahead" only accepts the
      // section and must never be recorded as an answer.
      if (nq) {
        const w = whoFor(session);
        const interp = interpretAnswer(text, nq, { geography: corpus.geography });
        if (input && input.action === "answer_section") return reply(session, ["Great.", askOpen(nq, w)], { expect: "answer", question: questionPayload(nq, w) });
        if (interp.kind === "answer" && yesNo(text) !== "yes") return handleAnswerText(session, text, input);
        return reply(session, ["Great.", askOpen(nq, w)], { expect: "answer", question: questionPayload(nq, w) });
      }
      return askNext(session);
    }
    if (detectGlobal(text).skipSection) {
      const block = corpus.engine.blockOf(engineState(corpus, answersOf(session), st.skippedBlocks), st.currentQuestion);
      if (block && block.skippable_as_block) {
        bumpRevision(session);
        st.skippedBlocks.push(block.id);
        // Drop anything already answered in that section.
        for (const id of block.questions) if (answersOf(session).some((a) => a.questionId === id)) session.work.deleteAnswer(id);
        session.work.answerEvent(null, "section_skipped:" + block.id, null, "skipped", session.revision);
        return askNext(session, ["Okay, we'll skip the rest of those."]);
      }
      return reply(session, ["This section can't be skipped as a whole, but you can skip any single question by saying skip."], { expect: "answer", question: questionPayload(q(corpus, st.currentQuestion), whoFor(session)) });
    }
    return handleAnswerText(session, text, input);
  }

  function handleAnswerText(session, text, input) {
    const st = session.state;
    const question = q(corpus, st.currentQuestion || (nextQuestion(session) || {}).id);
    if (!question) return startRecap(session);
    st.currentQuestion = question.id;
    const w = whoFor(session);
    const g = detectGlobal(text);

    if (g.help) {
      return reply(session, [question.help || "It helps me find the right services.", askOpen(question, w)], { expect: "answer", question: questionPayload(question, w) });
    }

    // A button press for a question that is no longer current is stale.
    if (input && input.choice) {
      if (input.choice.questionId !== question.id) {
        return reply(session, ["That answer was for an earlier question, so I didn't use it.", askOpen(question, w)], { expect: "answer", question: questionPayload(question, w) });
      }
      const vals = [].concat(input.choice.value);
      const valid = vals.every((v) => (question.options || []).some((o) => o.value === v));
      if (!valid) return reply(session, ["That isn't one of the choices for this question.", askOpen(question, w)], { expect: "answer", question: questionPayload(question, w) });
      const value = question.type === "multi" ? vals : vals[0];
      const kind = ["not_sure", "never_or_unknown"].includes(vals[0]) && vals.length === 1 ? "unknown" : "answer";
      return acceptAnswer(session, question, { kind, value });
    }

    // Correction of an EARLIER answer while answering this one ("actually I live in Gaston").
    if (looksLikeCorrection(text)) {
      const askable = answersOf(session).map((a) => a.questionId).filter((id) => id !== question.id);
      const target = findCorrectionTarget(text, corpus.assessment, askable, { geography: corpus.geography });
      const own = interpretAnswer(text, question, { geography: corpus.geography });
      if (target && !target.ambiguousTargets && target.interpretation.kind === "answer" && !(own.kind === "answer")) {
        const r = tryCorrection(session, text, { requireCue: false });
        if (r && r.applied) return askNext(session, [r.ack]);
        if (r) return r;
      }
    }

    let interp = interpretAnswer(text, question, { geography: corpus.geography });
    // Within a clarification, restrict to the options we offered when possible.
    if (st.pending && st.pending.type === "clarify" && st.pending.questionId === question.id) {
      if (interp.kind === "ambiguous") {
        const narrowed = interp.options.filter((o) => st.pending.options.includes(o));
        if (narrowed.length === 1) interp = { kind: "answer", value: narrowed[0] };
      }
    }
    const ai = turnAi.interp;
    if (interp.kind === "unclear" && ai && ai.questionId === question.id && ai.kind !== "unclear") {
      const noted = [];
      for (const o of ai.others || []) {
        if (answersOf(session).some((a) => a.questionId === o.questionId)) continue;
        setAnswer(session, o.questionId, "answer", o.value, "volunteered (AI-understood)");
        const a = answersOf(session).find((x) => x.questionId === o.questionId);
        if (a) noted.push(lineFor(session, a));
      }
      if (ai.kind === "ambiguous") return clarify(session, question, { kind: "ambiguous", options: ai.options, reason: "I want to be sure I understood" });
      return acceptAnswer(session, question, { kind: ai.kind, value: ai.value }, "intake (AI-understood)", noted);
    }
    switch (interp.kind) {
      case "answer":
      case "unknown":
      case "declined":
      case "skipped":
        return acceptAnswer(session, question, interp);
      case "ambiguous":
        return clarify(session, question, interp);
      default: {
        // Not an answer to this question, but maybe a clear answer to a later
        // one ("she has an eye doctor"). Note it as proposed and re-ask.
        const extra = noteOtherAnswers(session, text, question.id);
        if (extra.length) {
          return reply(session, [`Thanks — I've noted that ${joinList(extra)}.`, askOpen(question, w)], { expect: "answer", question: questionPayload(question, w) });
        }
        st.unclearCount[question.id] = (st.unclearCount[question.id] || 0) + 1;
        const tail = st.unclearCount[question.id] >= 2 ? " You can also say skip, or that you're not sure." : "";
        return reply(session, ["Sorry, I didn't quite catch that.", askWithChoices(question, w) + tail], { expect: "answer", question: questionPayload(question, w) });
      }
    }
  }

  function noteOtherAnswers(session, text, currentId) {
    const already = new Set(answersOf(session).map((a) => a.questionId));
    const noted = [];
    for (const f of extractMany(text, corpus.assessment, { geography: corpus.geography })) {
      if (f.questionId === currentId || already.has(f.questionId)) continue;
      const est = engineState(corpus, answersOf(session), session.state.skippedBlocks);
      if (!corpus.engine.shouldAsk(est, q(corpus, f.questionId))) continue;
      setAnswer(session, f.questionId, "answer", f.value, "volunteered", f.detail || null);
      const a = answersOf(session).find((x) => x.questionId === f.questionId);
      if (a) noted.push(lineFor(session, a));
    }
    return noted;
  }

  function acceptAnswer(session, question, interp, source = "intake", alsoNoted = []) {
    const st = session.state;
    st.pending = null;
    setAnswer(session, question.id, interp.kind, interp.value ?? null, source, interp.detail || null);
    let text = ack(question, interp.kind, interp.value, interp.detail || null, whoFor(session), st.ackN++);
    if (alsoNoted.length) text += ` I've also noted that ${joinList(alsoNoted)}.`;
    return askNext(session, [text]);
  }

  function handleRecap(session, text, input) {
    const st = session.state;
    if (detectGlobal(text).email) return beginEmail(session);
    // A reply that talks about one of the answers ("I do have an eye doctor")
    // is a correction even if it contains a yes-word. Never treat it as "yes".
    const namesAnswer = mentionedTopics(text, answersOf(session).map((a) => a.questionId)).length > 0;
    if (strictConfirm(text) && !namesAnswer) {
      // We just asked "what should I change?", so a bare yes doesn't answer
      // that. Read the summary back and ask again rather than confirming.
      if (st.recapAwaitingChange) return startRecap(session, ["Thanks."]);
      // A typed/spoken yes must be for the summary currently on screen.
      const offered = input.revision === undefined || input.revision === null ? session.revision : Number(input.revision);
      if (offered !== session.revision || st.recapRevision !== session.revision) {
        session.work.audit("system", "stale_confirmation_rejected", { offered, current: session.revision });
        return startRecap(session, ["Something changed since that summary, so I need you to check it again."]);
      }
      return confirmRecap(session);
    }
    const corr = tryCorrection(session, text, { requireCue: false });
    if (corr && corr.applied) return afterCorrection(session, corr.ack);
    if (corr) return corr;
    const yn = yesNo(text);
    if (yn === "no" || yn === "mixed") {
      st.recapAwaitingChange = true;
      return reply(session, ["No problem. What should I change? For example, you could say: change the county to Gaston. You can also use the Change buttons."], { expect: "free", recap: recapPayload(session) });
    }
    return reply(session, ["I just need a clear yes before I suggest anything. Does the summary sound right? Say yes, or tell me what to change."], { expect: "confirm_recap", recap: recapPayload(session) });
  }

  function currentResults(session) {
    const rec = session.work.currentRecommendation();
    return rec && rec.revision === session.revision ? { ...rec.result, recommendationId: rec.id } : null;
  }

  function handleResults(session, text) {
    const st = session.state;
    const g = detectGlobal(text);
    const results = currentResults(session);
    if (looksLikeCorrection(text)) {
      const corr = tryCorrection(session, text, { requireCue: false });
      if (corr && corr.applied) return afterCorrection(session, corr.ack);
      if (corr) return corr;
    }
    if (!results) return startRecap(session, ["Your answers changed, so I need to check them with you again."]);
    if (g.email) return beginEmail(session);
    if (g.noEmail) {
      st.wrapStep = "staff";
      return reply(session, ["That's fine — you don't need email. Everything is on the screen.", staffQuestion(session)], { expect: "results" });
    }
    // "Tell me about number 2" / by name
    const n = normalize(text);
    const num = (n.match(/ (?:number|option|suggestion) (\d+|one|two|three|four|five|six|seven|eight|nine|ten) /) || [])[1];
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    let pick = num ? (/\d/.test(num) ? Number(num) : words[num]) : null;
    if (!pick) {
      const idx = results.matches.findIndex((m) => n.includes(normalize(m.name).trim()) || (m.aliases || []).some((a) => a.length > 4 && n.includes(normalize(a).trim())));
      if (idx !== -1) pick = idx + 1;
    }
    if (pick && results.matches[pick - 1]) {
      const m = results.matches[pick - 1];
      const step = m.firstStep ? `To get started: ${m.firstStep}.` : "";
      const contact = m.contacts.general_phone ? `Their phone number is ${m.contacts.general_phone}.` : m.contacts.website ? "Their website link is on the screen." : "";
      const cost = m.cost ? `Cost: ${m.cost}.` : "";
      return reply(session, [`Number ${pick} is ${m.name}. ${m.oneLine}`, m.reasons[0] ? m.reasons[0] : "", step, contact, cost, m.uncertainty.length ? m.uncertainty[0] : "", wrapQuestion(session)], { expect: "results", focusResult: m.id });
    }
    const yn = yesNo(text);
    const done = /that's all|that is all|i'm done|im done|all done|nothing else|i'm good|im good|that's it|no thanks|no thank you|we're done|finished/.test(n);
    // "Yes, I live in Gaston" while the email question is open: that changes an
    // answer, so the old suggestions must not carry on as if nothing happened.
    if (yn !== "no" && !done && !strictConfirm(text)) {
      const corr = tryCorrection(session, text, { requireCue: false });
      if (corr && corr.applied) return afterCorrection(session, corr.ack);
      if (corr) return corr;
    }
    switch (st.wrapStep) {
      case "email":
        if (yn === "yes") return beginEmail(session);
        if (yn === "no" || done) { st.wrapStep = "staff"; return reply(session, ["No problem — everything stays on the screen.", staffQuestion(session)], { expect: "results" }); }
        break;
      case "staff":
        if (yn === "yes") return beginStaff(session);
        if (yn === "no" || done) { st.wrapStep = "anything"; return reply(session, ["Okay.", anythingElse()], { expect: "results" }); }
        break;
      case "anything":
        if (yn === "no" || done) return closeSession(session);
        if (yn === "yes") { st.wrapStep = "open"; return reply(session, ["Sure — what else can I help with? You can ask about any of the suggestions, or change one of your answers."], { expect: "results" }); }
        break;
      default:
        if (done || yn === "no") return closeSession(session);
    }
    return reply(session, ["Sorry, I didn't quite catch that.", wrapQuestion(session)], { expect: "results" });
  }

  // ---------------------------------------------------------------- email
  function beginEmail(session) {
    const results = currentResults(session);
    if (!results) {
      if (session.state.phase === "recap") return reply(session, ["I can email the plan once you've confirmed the summary and seen the suggestions."], { expect: "confirm_recap", recap: recapPayload(session) });
      return reply(session, ["I can email the plan once we've finished the questions and you've confirmed the summary."], { expect: "same" });
    }
    session.state.phase = "email_address";
    session.state.email = { step: "address" };
    return reply(session, ["Sure. What's your email address? You can say it out loud, like \"sam at example dot com,\" or type it in the box below. Since this is a demo, please use a test address."], { expect: "email" });
  }

  function leaveEmail(session, lead) {
    const st = session.state;
    st.phase = "results"; st.email = null; st.wrapStep = "staff";
    return reply(session, [...lead, staffQuestion(session)], { expect: "results" });
  }

  function handleEmail(session, text) {
    const st = session.state;
    const results = currentResults(session);
    if (!results) return startRecap(session, ["Your answers changed, so the plan needs re-checking first."]);
    const yn = yesNo(text);
    if (normalize(text).includes(" cancel ") || detectGlobal(text).noEmail) return leaveEmail(session, ["Okay, I won't send anything."]);
    if (st.phase === "email_address") {
      const addr = parseEmail(text) || (turnAi.email || null);
      if (!addr) {
        if (yn === "no") return leaveEmail(session, ["Okay, no email."]);
        return reply(session, ["Sorry, I didn't catch the email address. Could you say it again, slowly — like \"sam at example dot com\"? Or type it in the box below."], { expect: "email" });
      }
      st.email = { step: "confirm_address", address: addr };
      st.phase = "email_confirm_address";
      return reply(session, [`I have ${addr}.`, `That's ${spellEmail(addr)}. Is that right?`], { expect: "yes_no", speech: `I have ${spellEmail(addr)}. Is that right?` });
    }
    if (st.phase === "email_confirm_address") {
      const newAddr = parseEmail(text);
      if (newAddr && newAddr !== st.email.address) {
        st.email.address = newAddr;
        return reply(session, [`Okay, ${newAddr}. That's ${spellEmail(newAddr)}. Is that right?`], { expect: "yes_no", speech: `Okay. ${spellEmail(newAddr)}. Is that right?` });
      }
      if (yn === "no") { st.phase = "email_address"; st.email = { step: "address" }; return reply(session, ["Okay, let's try again. What's the email address? Typing it in the box below works too."], { expect: "email" }); }
      // Only a clear yes: "yes but it's dot org" or "yes, wait" is not.
      if (!strictConfirm(text)) return reply(session, [`Is ${st.email.address} exactly right? Say yes, or tell me the correct address.`], { expect: "yes_no" });
      const allowed = ctx.actions.recipientAllowed(st.email.address);
      if (!allowed.ok) return leaveEmail(session, [allowed.reason, "Everything is still on the screen."]);
      const plan = buildPlan(corpus, results, { name: st.names.caller });
      st.email.payloadHash = plan.hash;
      st.email.matchCount = results.matches.length;
      st.email.step = "consent";
      st.email.consentRevision = session.revision;
      st.phase = "email_consent";
      const consent = `Great. Here's exactly what I'll do: send one email to ${st.email.address} with the ${results.matches.length} suggested services, their contact details and next steps. It won't include your answers about health, money or anything else personal. Shall I send it?`;
      return reply(session, [consent], { expect: "consent", consent: { recipient: st.email.address, matchCount: results.matches.length, payloadHash: plan.hash, revision: session.revision } });
    }
    if (st.phase === "email_consent") {
      if (st.email.consentInterrupted) {
        st.email.consentInterrupted = false;
        const consent = `Before I send anything, let me finish that question, since it was cut off. I'll send one email to ${st.email.address} with ${st.email.matchCount} suggested services and their contact details, and nothing personal about you. Shall I send it?`;
        return reply(session, [consent], { expect: "consent", consent: { recipient: st.email.address, matchCount: st.email.matchCount, payloadHash: st.email.payloadHash, revision: session.revision } });
      }
      // "Yes, send it to bob at example dot com": a different address must be
      // read back and confirmed before anything is sent.
      const otherAddr = parseEmail(text);
      if (otherAddr && otherAddr !== st.email.address) {
        st.email = { step: "confirm_address", address: otherAddr };
        st.phase = "email_confirm_address";
        return reply(session, [`Okay, ${otherAddr} instead. That's ${spellEmail(otherAddr)}. Is that right?`], { expect: "yes_no", speech: `Okay. ${spellEmail(otherAddr)}. Is that right?` });
      }
      if (!strictConfirm(text)) {
        if (yn === "no") return leaveEmail(session, ["Okay, I won't send it."]);
        return reply(session, ["I just need a clear yes to send it. Shall I send the email?"], { expect: "consent" });
      }
      if (st.email.consentRevision !== session.revision) return leaveEmail(session, ["Your answers changed after I asked, so I haven't sent anything."]);
      const plan = buildPlan(corpus, results, { name: st.names.caller });
      if (plan.hash !== st.email.payloadHash) return leaveEmail(session, ["The plan changed after I asked, so I haven't sent anything."]);
      const res = session.work.enqueueEmail(session, { recipient: st.email.address, plan, recommendationId: results.recommendationId, method: "explicit_yes" });
      const addr = st.email.address;
      st.phase = "results";
      st.wrapStep = "staff";
      st.email = { step: "queued", address: addr, actionId: res.action.id };
      const mockNote = ctx.actions.transportName() === "outbox" ? " Since this demo isn't connected to a real email service yet, it'll go to a test outbox rather than your inbox." : "";
      return reply(session, [res.duplicate ? "That email was already queued, so I haven't sent a second copy." : `Done — I'm sending your plan to ${addr}.${mockNote}`, staffQuestion(session)], { expect: "results", actionId: res.action.id });
    }
    return reply(session, ["Let's carry on."], { expect: "results" });
  }

  // ---------------------------------------------------------------- staff
  function beginStaff(session) {
    const st = session.state;
    st.staff = { resumePhase: ["results", "recap", "intake", "opening"].includes(st.phase) ? st.phase : "results" };
    st.phase = "staff_contact";
    const known = st.email && st.email.address;
    const lead = "Great. Someone from Lions Services can follow up and help with next steps. They'll see your answers and suggestions, so you won't have to start over.";
    const askHow = known
      ? `Should they email you at ${known}, or would you rather they call? If calling, what's the best number?`
      : "What's the best phone number or email for them to reach you? Or say no contact if you'd just like them to see your notes.";
    return reply(session, [lead, askHow, "Since this is a demo, please use made-up details."], { expect: "contact" });
  }

  function handleStaff(session, text) {
    const st = session.state;
    const n = normalize(text);
    const g = detectGlobal(text);
    if (st.phase === "staff_contact") {
      const known = st.email && st.email.address;
      const email = parseEmail(text) || turnAi.email || null;
      const digits = text.replace(/[^0-9]/g, "");
      let contact = null;
      if (email) contact = { method: "email", value: email };
      else if (digits.length >= 10 && digits.length <= 11) contact = { method: "phone", value: digits.slice(-10).replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3") };
      else if (known && (/ email /.test(n) || yesNo(text) === "yes")) contact = { method: "email", value: known };
      else if (/ (call|phone|ring) /.test(n)) return reply(session, ["Sure — what's the best number to call?"], { expect: "contact" });
      else if (/no contact|don't contact|do not contact|just a note|no thanks|^ no $/.test(n) || yesNo(text) === "no" || g.declined) contact = { method: "none" };
      if (!contact) return reply(session, ["Sorry, I didn't get that. What's the best phone number or email? Or say no contact."], { expect: "contact" });
      st.staff.contact = contact;
      st.phase = "staff_confirm";
      const what = contact.method === "none"
        ? "pass your notes to the Lions Services team without any contact details"
        : `ask Lions Services to ${contact.method === "phone" ? "call you at " + contact.value.split("").join(" ") : "email you at " + spellEmail(contact.value)}`;
      return reply(session, [`So I'll ${what}. Is that right?`], { expect: "yes_no" });
    }
    if (st.phase === "staff_confirm") {
      const yn = yesNo(text);
      if (yn === "no") { st.phase = "staff_contact"; return reply(session, ["Okay. What's the best phone number or email? Or say no contact."], { expect: "contact" }); }
      if (yn !== "yes") return reply(session, ["Just say yes or no."], { expect: "yes_no" });
      const c = st.staff.contact;
      const people = { callerName: st.names.caller || null, subjectName: st.names.subject || null };
      session.work.createStaffReview("Requested by the person during the conversation", c.method === "none" ? people : { ...c, ...people }, c.method !== "none");
      session.work.audit("caller", "staff_review_requested", { contactMethod: c.method });
      const resume = st.staff.resumePhase;
      st.staff = { requested: true };
      st.phase = resume;
      const doneText = ["Done — I've passed your answers and suggestions to the Lions Services team.", c.method === "none" ? "" : "Since this is a demo, nobody will actually contact you."];
      if (resume === "results") { st.wrapStep = "anything"; return reply(session, [...doneText, anythingElse()], { expect: "results" }); }
      return resumeAfterAside(session, doneText);
    }
    return resumeAfterAside(session, []);
  }

  // Browser event: assistant speech was interrupted before it finished.
  function speechInterrupted(session, turnId) {
    const st = session.state;
    session.work.audit("caller", "speech_interrupted", { turnId });
    // An authorisation question that wasn't fully heard can't be answered yes.
    if (st.phase === "email_consent" && st.lastAssistant && st.lastAssistant.turnId === turnId) {
      st.email.consentInterrupted = true;
      return true;
    }
    return false;
  }

  function greeting(session) {
    session.state.phase = "name";
    return reply(session, greetingText(), { expect: "name" });
  }

  // What the optional AI helper may be asked about right now.
  function aiContext(session) {
    const st = session.state;
    const answered = new Set(answersOf(session).map((a) => a.questionId));
    const eng = engineState(corpus, answersOf(session), st.skippedBlocks);
    const open = corpus.assessment.questions.filter((x) => !answered.has(x.id) && corpus.engine.shouldAsk(eng, x));
    return {
      phase: st.phase,
      pending: st.pending ? st.pending.type : null,
      currentQuestion: st.phase === "intake" && st.currentQuestion ? q(corpus, st.currentQuestion) : null,
      openQuestions: open,
    };
  }

  return { handle, greeting, snapshot, speechInterrupted, answersOf, recapPayload, aiContext };
}

export function hashPayload(s) {
  return createHash("sha256").update(s).digest("hex");
}

function publicAction(a) {
  return { id: a.id, type: a.type, status: a.status, attempts: a.attempts, provider: a.provider, error: a.error ? String(a.error).slice(0, 200) : null, updatedAt: a.updated_at };
}
