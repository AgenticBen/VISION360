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
import { createHash } from "node:crypto";
import {
  interpretAnswer, extractMany, detectGlobal, yesNo, strictConfirm, findCorrectionTarget,
  looksLikeCorrection, parseEmail, spellEmail, normalize,
} from "./understand.mjs";
import { buildResults, resultsSpeech } from "./results.mjs";
import { buildPlan } from "./plan.mjs";

export const POLICY_VERSION = "dialogue-2026-10-21.1";

const KIND_TEXT = { unknown: "not known", declined: "you preferred not to say", skipped: "skipped" };

const RECAP_LABEL = {
  actor: "Looking for",
  county: "Where the person lives",
  goals: "What matters most",
  age_band: "Age",
  hearing_loss: "Hearing loss",
  eye_doctor: "Has an eye doctor",
  eye_exam_recency: "Last eye exam",
  insurance: "Health cover",
  veteran: "Served in the military",
  va_enrolled: "Signed up for VA health care",
  discharge: "Discharge",
  housing_stable: "Housing steady",
  food_worry: "Food running out",
  utilities: "Utility shut-off threats",
  transport_barrier: "Transport stopping appointments",
  legal_matter: "Legal matters",
  loneliness: "Feeling lonely or cut off",
  broadband: "Internet at home",
  devices: "Devices",
};

// ------------------------------------------------------------------ helpers
export function newDialogueState() {
  return {
    phase: "opening",
    currentQuestion: null,
    pending: null,
    skippedBlocks: [],
    offeredBlocks: [],
    unclearCount: {},
    recapRevision: null,
    confirmedRevision: null,
    email: null,
    staff: null,
    lastAssistant: null,
    turnSeq: 0,
    resume: null,
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

function joinList(items, word = "and") {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + ` ${word} ` + items[items.length - 1];
}

function answerText(corpus, a, screen = false) {
  const question = q(corpus, a.questionId);
  if (a.kind === "answer") return optionLabel(question, a.value, screen);
  if (a.kind === "unknown" && a.value) return optionLabel(question, a.value, screen);
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

function questionPayload(question) {
  if (!question) return null;
  return {
    id: question.id,
    prompt: question.prompt_voice,
    prompt_screen: question.prompt_screen,
    help: question.help,
    type: question.type,
    skippable: question.skippable !== false,
    sensitive: !!question.sensitive,
    options: (question.options || []).map((o) => ({ value: o.value, label: o.label_screen || o.label_voice })),
  };
}

function askText(question) {
  const opts = (question.options || []).map((o) => o.label_voice || o.label_screen);
  let t = question.prompt_voice;
  if (question.type !== "yes_no" && opts.length <= 8) {
    t += ` ${question.type === "multi" ? "For example" : "You can say"}: ${joinList(opts, "or")}.`;
  }
  return t;
}

// ------------------------------------------------------------------ engine
export function createDialogue(ctx) {
  const { corpus, store } = ctx;

  function answersOf(session) {
    const order = corpus.assessment.questions.map((x) => x.id);
    return store.getAnswers(session.id).sort((a, b) => order.indexOf(a.questionId) - order.indexOf(b.questionId));
  }

  function bumpRevision(session) {
    session.revision += 1;
    // Any change after a confirmation invalidates the confirmation, the results
    // built from it, and any action not yet started.
    if (session.state.confirmedRevision !== null || session.state.recapRevision !== null) {
      const staleRecs = store.markRecommendationsStale(session.id);
      const cancelled = store.cancelStaleActions(session.id, session.revision);
      // Anything already handed over can't be unsent: flag it for staff to reconcile.
      const sent = store.actionsForSession(session.id).filter((a) => ["provider_accepted", "mock_written", "running"].includes(a.status) && a.revision < session.revision);
      if (sent.length && !store.staffReviews(session.id).some((r) => r.reason.startsWith("Automatic: answers changed after"))) {
        store.createStaffReview(session.id, "Automatic: answers changed after an email plan was already sent — please reconcile", null, false);
        session.state.sentBeforeChange = true;
      }
      if (staleRecs || cancelled) store.audit("system", session.id, "invalidated", { staleRecommendations: staleRecs, cancelledActions: cancelled, revision: session.revision });
    }
    session.state.confirmedRevision = null;
    session.state.recapRevision = null;
  }

  function setAnswer(session, questionId, kind, value, source) {
    bumpRevision(session);
    store.putAnswer(session.id, { questionId, kind, value: value ?? null, revision: session.revision, source });
    store.answerEvent(session.id, questionId, "proposed", value ?? null, kind, session.revision);
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
          store.deleteAnswer(session.id, a.questionId);
          store.answerEvent(session.id, a.questionId, "removed_not_applicable", null, null, session.revision);
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
    const answers = answersOf(session).map((a) => ({
      questionId: a.questionId,
      label: RECAP_LABEL[a.questionId] || a.questionId,
      kind: a.kind,
      value: a.value,
      display: answerText(corpus, a, true),
      status: a.confirmedRevision !== null && a.confirmedRevision !== undefined && a.confirmedRevision === session.state.confirmedRevision ? "confirmed" : "proposed",
      source: a.source,
    }));
    const rec = store.currentRecommendation(session.id);
    return {
      sessionId: session.id,
      revision: session.revision,
      phase: session.state.phase,
      confirmedRevision: session.state.confirmedRevision,
      currentQuestion: session.state.phase === "intake" && session.state.currentQuestion ? questionPayload(q(corpus, session.state.currentQuestion)) : null,
      pending: session.state.pending ? { type: session.state.pending.type, options: session.state.pending.options || null } : null,
      answers,
      progress: progress(session),
      results: rec && rec.revision === session.revision ? rec.result : null,
      actions: store.actionsForSession(session.id).map(publicAction),
      staffRequested: store.staffReviews(session.id).some((r) => r.reason.startsWith("Requested")),
      email: session.state.email ? { address: session.state.email.address || null, step: session.state.email.step } : null,
      corpusVersion: session.corpus_version,
      policyVersion: POLICY_VERSION,
      lastAssistant: session.state.lastAssistant,
    };
  }

  function recapPayload(session) {
    const items = answersOf(session).map((a) => ({
      questionId: a.questionId,
      label: RECAP_LABEL[a.questionId] || a.questionId,
      display: answerText(corpus, a, true),
      kind: a.kind,
    }));
    return { revision: session.revision, items };
  }

  function recapSpeech(session) {
    const items = answersOf(session).map((a) => `${RECAP_LABEL[a.questionId] || a.questionId}: ${answerText(corpus, a)}.`);
    return items.join(" ");
  }

  // ---------------------------------------------------------------- phases
  function askNext(session, lead = []) {
    const nq = nextQuestion(session);
    if (!nq) return startRecap(session, lead);
    session.state.phase = "intake";
    session.state.currentQuestion = nq.id;
    session.state.pending = null;
    const block = corpus.engine.blockOf(engineState(corpus, answersOf(session), session.state.skippedBlocks), nq.id);
    const parts = [...lead];
    if (block && block.preamble && !session.state.offeredBlocks.includes(block.id)) {
      session.state.offeredBlocks.push(block.id);
      parts.push(block.preamble);
      if (block.skippable_as_block) {
        session.state.pending = { type: "block_offer", blockId: block.id };
        parts.push("Would you like to answer these, or skip this section?");
        return reply(session, parts, { expect: "block_offer", question: null, block: { id: block.id, title: block.title } });
      }
    }
    parts.push(askText(nq));
    return reply(session, parts, { expect: "answer", question: questionPayload(nq) });
  }

  function startRecap(session, lead = []) {
    session.state.phase = "recap";
    session.state.currentQuestion = null;
    session.state.pending = null;
    session.state.recapRevision = session.revision;
    const recap = recapPayload(session);
    const text = [...lead, "Before I suggest anything, here is what I have.", recapSpeech(session), "Is all of that right? Say yes to see suggestions, or tell me what to change."];
    return reply(session, text, { expect: "confirm_recap", recap });
  }

  function confirmRecap(session) {
    session.state.confirmedRevision = session.revision;
    store.confirmAllAnswers(session.id, session.revision);
    store.answerEvent(session.id, null, "recap_confirmed", null, null, session.revision);
    store.audit("caller", session.id, "recap_confirmed", { revision: session.revision });
    let results;
    try {
      results = buildResults(corpus, engineState(corpus, answersOf(session), session.state.skippedBlocks), answersOf(session));
    } catch (e) {
      store.createStaffReview(session.id, "Automatic: matching failed — " + String(e.message).slice(0, 120), null, false);
      session.state.phase = "results";
      return reply(session, ["Thank you. Something went wrong on my side while finding services, so I can't give you suggestions right now, and I won't guess.", "I've flagged this for a Lions Services staff member to review."], { expect: "free" });
    }
    results.revision = session.revision;
    results.corpusVersion = corpus.version;
    results.policyVersion = POLICY_VERSION;
    const recId = store.saveRecommendation(session.id, session.revision, corpus.version, results);
    results.recommendationId = recId;
    if (results.handoffs.length && !store.staffReviews(session.id).some((r) => r.reason.startsWith("Automatic: needs help"))) {
      store.createStaffReview(session.id, "Automatic: needs help this directory does not cover — " + results.handoffs.map((h) => h.id).join(", "), null, false);
    }
    session.state.phase = "results";
    const speech = resultsSpeech(results);
    return reply(session, [speech.text], { expect: "results", results, speech: speech.speech });
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
      return reply(session, [`Which do you want to change: ${joinList(names, "or")}?`], { expect: "free" });
    }
    const question = q(corpus, target.questionId);
    const interp = target.interpretation;
    if (interp.kind === "answer" || interp.kind === "unknown" || interp.kind === "declined") {
      const before = answersOf(session).find((a) => a.questionId === target.questionId);
      setAnswer(session, target.questionId, interp.kind, interp.value ?? null, "correction");
      store.answerEvent(session.id, target.questionId, "corrected", interp.value ?? null, interp.kind, session.revision);
      const now = answersOf(session).find((a) => a.questionId === target.questionId);
      return { applied: true, questionId: target.questionId, ack: `Okay, I've changed ${(RECAP_LABEL[target.questionId] || "that").toLowerCase()} from ${before ? answerText(corpus, before) : "nothing"} to ${now ? answerText(corpus, now) : answerText(corpus, { questionId: target.questionId, kind: interp.kind, value: interp.value })}.` };
    }
    // We know which question, not the new value: ask it again.
    session.state.pending = { type: "reask_for_correction", questionId: target.questionId, resumePhase: session.state.phase };
    return reply(session, [`Sure, let's fix ${(RECAP_LABEL[target.questionId] || "that").toLowerCase()}.`, askText(question)], { expect: "answer", question: questionPayload(question) });
  }

  // ------------------------------------------------------------------ turn
  // input: {text, choice?: {questionId, value}, action?, revision?, mode}
  function handle(session, input) {
    const text = String(input.text || "").slice(0, 1000);
    const st = session.state;
    const g = detectGlobal(text);

    // Explicit structured actions from buttons -------------------------------
    if (input.action === "confirm_recap") {
      if (st.phase !== "recap") return reply(session, ["There's no summary waiting for confirmation right now."], { expect: "free" });
      if (Number(input.revision) !== session.revision || st.recapRevision !== session.revision) {
        store.audit("system", session.id, "stale_confirmation_rejected", { offered: input.revision, current: session.revision });
        return startRecap(session, ["Something changed since that summary, so I can't use that confirmation."]);
      }
      return confirmRecap(session);
    }
    if (input.action === "edit_answer" && input.questionId) {
      const question = q(corpus, input.questionId);
      if (!question || !answersOf(session).some((a) => a.questionId === input.questionId)) return reply(session, ["I can't find that answer to change."], { expect: "free" });
      st.pending = { type: "reask_for_correction", questionId: question.id, resumePhase: st.phase === "intake" ? "intake" : "recap" };
      return reply(session, [`Okay, let's change ${(RECAP_LABEL[question.id] || "that").toLowerCase()}.`, askText(question)], { expect: "answer", question: questionPayload(question) });
    }
    if (input.action === "request_email") return beginEmail(session);
    if (input.action === "request_staff") return beginStaff(session);
    if (input.action === "skip") return handleAnswerText(session, "skip", null);
    if (input.action === "unknown") return handleAnswerText(session, "I don't know", null);
    if (input.action === "decline") return handleAnswerText(session, "I'd rather not say", null);

    if (!text.trim() && !input.choice) return reply(session, ["I didn't hear anything. Take your time — " + (st.lastAssistant ? "I'll wait." : "")], { expect: "same", silent: true });

    // Global intents ---------------------------------------------------------
    if (g.repeat && st.lastAssistant) {
      return { ...st.lastAssistant, repeated: true };
    }
    if (g.end && !g.staff) {
      st.phase = "closed";
      session.status = "ended";
      return reply(session, ["Thanks for using the Vision 360 CONNECT demo. Goodbye."], { expect: "ended" });
    }
    if (g.startOver) {
      st.pending = { type: "confirm_restart", resumePhase: st.phase };
      return reply(session, ["Do you want to clear everything and start over? Say yes to start over, or no to carry on."], { expect: "yes_no" });
    }
    if (g.staff && !["staff_contact", "staff_confirm"].includes(st.phase)) return beginStaff(session);

    // Pending sub-dialogues -----------------------------------------------
    if (st.pending && st.pending.type === "confirm_restart") {
      const yn = yesNo(text);
      const resume = st.pending.resumePhase;
      st.pending = null;
      if (yn === "yes") {
        bumpRevision(session);
        store.deleteAllAnswers(session.id);
        store.answerEvent(session.id, null, "restarted", null, null, session.revision);
        const keep = { turnSeq: st.turnSeq, lastAssistant: st.lastAssistant };
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
        return reply(session, [askText(question)], { expect: "answer", question: questionPayload(question) });
      }
    }
    if (st.pending && st.pending.type === "reask_for_correction") {
      const question = q(corpus, st.pending.questionId);
      const interp = input.choice && input.choice.questionId === question.id ? { kind: "answer", value: input.choice.value } : interpretAnswer(text, question, { geography: corpus.geography });
      if (interp.kind === "ambiguous") return clarify(session, question, interp, st.pending);
      if (interp.kind === "unclear") return reply(session, ["Sorry, I didn't catch that.", askText(question)], { expect: "answer", question: questionPayload(question) });
      const resume = st.pending.resumePhase;
      st.pending = null;
      const before = answersOf(session).find((a) => a.questionId === question.id);
      setAnswer(session, question.id, interp.kind, interp.value ?? null, "correction");
      store.answerEvent(session.id, question.id, "corrected", interp.value ?? null, interp.kind, session.revision);
      const after = answersOf(session).find((a) => a.questionId === question.id);
      const ack = `Okay, I've changed ${(RECAP_LABEL[question.id] || "that").toLowerCase()}${before ? " from " + answerText(corpus, before) : ""} to ${after ? answerText(corpus, after) : "nothing"}.`;
      if (resume === "intake") return askNext(session, [ack]);
      return afterCorrection(session, ack);
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

  function resumeAfterAside(session, lead) {
    const st = session.state;
    if (st.phase === "intake") return askNext(session, lead);
    if (st.phase === "recap") return startRecap(session, lead);
    if (st.phase === "results") return reply(session, [...lead, "Would you like me to email this plan, ask a staff member to follow up, or tell you more about one of the suggestions?"], { expect: "results" });
    return askNext(session, lead);
  }

  function afterCorrection(session, ack) {
    // After confirmation, a change means the old suggestions no longer apply.
    const hadResults = ["results", "email_address", "email_confirm_address", "email_consent", "staff_contact", "staff_confirm"].includes(session.state.phase);
    const lead = [ack];
    if (hadResults) lead.push("That changes things, so I've set aside the earlier suggestions and cancelled anything that hadn't started.");
    if (session.state.sentBeforeChange) { lead.push("The earlier email had already gone out, so I can't take it back — I've flagged it for a staff member to sort out."); session.state.sentBeforeChange = false; }
    // New follow-up questions may now apply (e.g. veteran changed to yes).
    if (nextQuestion(session)) {
      session.state.phase = "intake";
      return askNext(session, [...lead, "That opens up a follow-up question."]);
    }
    return startRecap(session, lead);
  }

  function handleOpening(session, text) {
    const n = normalize(text);
    const justAsk = /just ask|ask me|questions|not sure where to start|don't know where to start/.test(n);
    let lead = [];
    if (!justAsk) {
      const found = extractMany(text, corpus.assessment, { geography: corpus.geography });
      // Optional AI extraction fills questions the rules didn't catch.
      for (const a of (session.__aiExtract || [])) if (!found.some((f) => f.questionId === a.questionId)) found.push({ ...a, phrase: "ai", ai: true });
      // Only keep answers whose question would actually be asked, in order.
      for (const f of found) {
        const st = engineState(corpus, answersOf(session), session.state.skippedBlocks);
        const question = q(corpus, f.questionId);
        if (!corpus.engine.shouldAsk(st, question)) continue;
        setAnswer(session, f.questionId, "answer", f.value, f.ai ? "opening (AI-understood)" : "opening");
      }
      const got = answersOf(session);
      if (got.length) {
        lead.push("Thank you. From that I've noted: " + got.map((a) => `${(RECAP_LABEL[a.questionId] || a.questionId).toLowerCase()} — ${answerText(corpus, a)}`).join("; ") + ".");
        lead.push("I'll check all of it with you before suggesting anything. Now a few questions, one at a time.");
      } else {
        lead.push("Thank you for telling me. I'll ask a few questions, one at a time, to find the right services.");
      }
    } else {
      lead.push("Okay. One question at a time.");
    }
    session.state.phase = "intake";
    return askNext(session, lead);
  }

  function clarify(session, question, interp, keepPending) {
    const names = interp.options.map((v) => optionLabel(question, v));
    const reason = interp.reason ? `Just to check — ${interp.reason}.` : "Just to check.";
    session.state.pending = keepPending && keepPending.type === "reask_for_correction"
      ? { ...keepPending, clarifyOptions: interp.options }
      : { type: "clarify", questionId: question.id, options: interp.options };
    return reply(session, [reason, `Is it ${joinList(names, "or")}?`], {
      expect: "answer",
      question: { ...questionPayload(question), options: questionPayload(question).options.filter((o) => interp.options.includes(o.value)).concat(questionPayload(question).options.filter((o) => ["not_sure", "never_or_unknown"].includes(o.value) && !interp.options.includes(o.value))) },
    });
  }

  function handleIntake(session, text, input) {
    const st = session.state;
    // Section offer ("answer these, or skip this section?")
    if (st.pending && st.pending.type === "block_offer") {
      const n = normalize(text);
      const blockId = st.pending.blockId;
      st.pending = null;
      if (detectGlobal(text).skipSection || detectGlobal(text).skip || / skip /.test(n) || yesNo(text) === "no") {
        bumpRevision(session);
        st.skippedBlocks.push(blockId);
        store.answerEvent(session.id, null, "section_skipped:" + blockId, null, "skipped", session.revision);
        return askNext(session, ["Okay, skipping that section."]);
      }
      const nq = nextQuestion(session);
      st.currentQuestion = nq ? nq.id : null;
      // If they started answering straight away ("we're behind on rent"),
      // treat it as an answer — but a plain "yes, go ahead" only accepts the
      // section and must never be recorded as an answer.
      if (nq) {
        const interp = interpretAnswer(text, nq, { geography: corpus.geography });
        if (input && input.action === "answer_section") return reply(session, [askText(nq)], { expect: "answer", question: questionPayload(nq) });
        if (interp.kind === "answer" && yesNo(text) !== "yes") return handleAnswerText(session, text, input);
        return reply(session, [askText(nq)], { expect: "answer", question: questionPayload(nq) });
      }
      return askNext(session);
    }
    if (detectGlobal(text).skipSection) {
      const block = corpus.engine.blockOf(engineState(corpus, answersOf(session), st.skippedBlocks), st.currentQuestion);
      if (block && block.skippable_as_block) {
        bumpRevision(session);
        st.skippedBlocks.push(block.id);
        // Drop anything already answered in that section.
        for (const id of block.questions) if (answersOf(session).some((a) => a.questionId === id)) store.deleteAnswer(session.id, id);
        store.answerEvent(session.id, null, "section_skipped:" + block.id, null, "skipped", session.revision);
        return askNext(session, ["Okay, skipping the rest of that section."]);
      }
      return reply(session, ["This section can't be skipped as a whole, but you can skip any single question by saying skip."], { expect: "answer", question: questionPayload(q(corpus, st.currentQuestion)) });
    }
    return handleAnswerText(session, text, input);
  }

  function handleAnswerText(session, text, input) {
    const st = session.state;
    const question = q(corpus, st.currentQuestion || (nextQuestion(session) || {}).id);
    if (!question) return startRecap(session);
    st.currentQuestion = question.id;
    const g = detectGlobal(text);

    if (g.help) {
      return reply(session, [question.help || "That helps me find the right services.", askText(question)], { expect: "answer", question: questionPayload(question) });
    }

    // A button press for a question that is no longer current is stale.
    if (input && input.choice) {
      if (input.choice.questionId !== question.id) {
        return reply(session, ["That answer was for an earlier question, so I didn't use it.", askText(question)], { expect: "answer", question: questionPayload(question) });
      }
      const vals = [].concat(input.choice.value);
      const valid = vals.every((v) => (question.options || []).some((o) => o.value === v));
      if (!valid) return reply(session, ["That isn't one of the choices for this question.", askText(question)], { expect: "answer", question: questionPayload(question) });
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
    const ai = session.__aiInterp;
    if (interp.kind === "unclear" && ai && ai.questionId === question.id && ai.kind !== "unclear") {
      const noted = [];
      for (const o of ai.others || []) {
        if (answersOf(session).some((a) => a.questionId === o.questionId)) continue;
        setAnswer(session, o.questionId, "answer", o.value, "volunteered (AI-understood)");
        noted.push(`${(RECAP_LABEL[o.questionId] || o.questionId).toLowerCase()}: ${optionLabel(q(corpus, o.questionId), o.value)}`);
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
          return reply(session, [`Thanks, I've noted ${joinList(extra)} too.`, askText(question)], { expect: "answer", question: questionPayload(question) });
        }
        st.unclearCount[question.id] = (st.unclearCount[question.id] || 0) + 1;
        const tail = st.unclearCount[question.id] >= 2 ? " You can also say skip, or I don't know." : "";
        return reply(session, ["Sorry, I didn't catch that.", askText(question) + tail], { expect: "answer", question: questionPayload(question) });
      }
    }
  }

  function noteOtherAnswers(session, text, currentId) {
    const already = new Set(answersOf(session).map((a) => a.questionId));
    const noted = [];
    for (const f of extractMany(text, corpus.assessment, { geography: corpus.geography })) {
      if (f.questionId === currentId || already.has(f.questionId)) continue;
      const st = engineState(corpus, answersOf(session), session.state.skippedBlocks);
      if (!corpus.engine.shouldAsk(st, q(corpus, f.questionId))) continue;
      setAnswer(session, f.questionId, "answer", f.value, "volunteered");
      noted.push(`${(RECAP_LABEL[f.questionId] || f.questionId).toLowerCase()}: ${optionLabel(q(corpus, f.questionId), f.value)}`);
    }
    return noted;
  }

  function acceptAnswer(session, question, interp, source = "intake", alsoNoted = []) {
    const st = session.state;
    st.pending = null;
    setAnswer(session, question.id, interp.kind, interp.value ?? null, source);
    let ack;
    if (interp.kind === "answer") ack = `Got it. ${RECAP_LABEL[question.id] || "Answer"}: ${optionLabel(question, interp.value)}.`;
    else if (interp.kind === "unknown") ack = "That's fine — I'll note that as not known, not as a no.";
    else if (interp.kind === "declined") ack = "No problem, I'll leave that out.";
    else ack = "Okay, skipping that one.";
    if (alsoNoted.length) ack += ` I've also noted ${joinList(alsoNoted)}.`;
    return askNext(session, [ack]);
  }

  function handleRecap(session, text, input) {
    const st = session.state;
    if (detectGlobal(text).email) return beginEmail(session);
    if (strictConfirm(text)) {
      // A typed/spoken yes must be for the summary currently on screen.
      const offered = input.revision === undefined || input.revision === null ? session.revision : Number(input.revision);
      if (offered !== session.revision || st.recapRevision !== session.revision) {
        store.audit("system", session.id, "stale_confirmation_rejected", { offered, current: session.revision });
        return startRecap(session, ["Something changed since that summary, so I need you to check it again."]);
      }
      return confirmRecap(session);
    }
    const corr = tryCorrection(session, text, { requireCue: false });
    if (corr && corr.applied) return afterCorrection(session, corr.ack);
    if (corr) return corr;
    const yn = yesNo(text);
    if (yn === "no" || yn === "mixed") {
      return reply(session, ["Okay. What would you like to change? For example, say: change the county to Gaston. Or use the Change buttons."], { expect: "free", recap: recapPayload(session) });
    }
    return reply(session, ["I need a clear yes before I suggest anything. Is the summary right? Say yes, or tell me what to change."], { expect: "confirm_recap", recap: recapPayload(session) });
  }

  function currentResults(session) {
    const rec = store.currentRecommendation(session.id);
    return rec && rec.revision === session.revision ? { ...rec.result, recommendationId: rec.id } : null;
  }

  function handleResults(session, text) {
    const g = detectGlobal(text);
    const results = currentResults(session);
    if (looksLikeCorrection(text)) {
      const corr = tryCorrection(session, text, { requireCue: false });
      if (corr && corr.applied) return afterCorrection(session, corr.ack);
      if (corr) return corr;
    }
    if (g.email) return beginEmail(session);
    if (g.noEmail) return reply(session, ["That's fine — you don't need email. Everything is on screen, and I can read any suggestion aloud. Would you like a Lions Services staff member to follow up instead?"], { expect: "results" });
    if (!results) return startRecap(session, ["Your answers changed, so I need to check them again."]);
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
      const step = m.firstStep ? `First step: ${m.firstStep}.` : "";
      const contact = m.contacts.general_phone ? `Phone: ${m.contacts.general_phone}.` : m.contacts.website ? "Their website link is on screen." : "";
      const cost = m.cost ? `Cost: ${m.cost}.` : "";
      return reply(session, [`Number ${pick}: ${m.name}. ${m.oneLine}`, m.reasons[0] ? m.reasons[0] : "", step, contact, cost, m.uncertainty.length ? m.uncertainty[0] : "", "Anything else? I can email the plan or ask staff to follow up."], { expect: "results", focusResult: m.id });
    }
    const yn = yesNo(text);
    if (yn === "no") return reply(session, ["Okay. Everything stays on screen. You can ask about any suggestion by number, ask for the plan by email, or ask for a staff member. Say end session when you're finished."], { expect: "results" });
    return reply(session, ["You can say: email me the plan, talk to a person, or tell me about number one. You can also change any answer."], { expect: "results" });
  }

  // ---------------------------------------------------------------- email
  function beginEmail(session) {
    const results = currentResults(session);
    if (!results) {
      if (session.state.phase === "recap") return reply(session, ["I can email a plan once you've confirmed the summary and seen the suggestions."], { expect: "confirm_recap", recap: recapPayload(session) });
      return reply(session, ["I can email a plan once we've finished the questions and you've confirmed the summary."], { expect: "same" });
    }
    session.state.phase = "email_address";
    session.state.email = { step: "address" };
    return reply(session, ["What email address should I send the plan to? You can spell it out, for example: sam at example dot com. In this demo please use a test address."], { expect: "email" });
  }

  function handleEmail(session, text) {
    const st = session.state;
    const results = currentResults(session);
    if (!results) return startRecap(session, ["Your answers changed, so the plan needs re-checking first."]);
    const yn = yesNo(text);
    if (normalize(text).includes(" cancel ") || detectGlobal(text).noEmail) {
      st.phase = "results"; st.email = null;
      return reply(session, ["Okay, I won't send anything."], { expect: "results" });
    }
    if (st.phase === "email_address") {
      const addr = parseEmail(text);
      if (!addr) return reply(session, ["Sorry, I couldn't make out an email address. Please say or type it again, like sam at example dot com — or say cancel."], { expect: "email" });
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
      if (yn === "no") { st.phase = "email_address"; st.email = { step: "address" }; return reply(session, ["Okay, please say or type the address again."], { expect: "email" }); }
      if (yn !== "yes") return reply(session, [`Is ${st.email.address} right? Please say yes or no.`], { expect: "yes_no" });
      const allowed = ctx.actions.recipientAllowed(st.email.address);
      if (!allowed.ok) {
        st.phase = "results"; st.email = null;
        return reply(session, [allowed.reason, "Everything is still on screen, and I can ask staff to follow up instead."], { expect: "results" });
      }
      const plan = buildPlan(corpus, results);
      st.email.payloadHash = plan.hash;
      st.email.matchCount = results.matches.length;
      st.email.step = "consent";
      st.email.consentRevision = session.revision;
      st.phase = "email_consent";
      const consent = `Here's exactly what I'll do: send one email to ${st.email.address} with the ${results.matches.length} suggested services, their contact details and next steps. It will not include your answers about health, money, housing or anything else personal. Shall I send it? Please say yes to send, or no.`;
      return reply(session, [consent], { expect: "consent", consent: { recipient: st.email.address, matchCount: results.matches.length, payloadHash: plan.hash, revision: session.revision } });
    }
    if (st.phase === "email_consent") {
      if (st.email.consentInterrupted) {
        st.email.consentInterrupted = false;
        const consent = `Before I send anything, let me finish the question, because it was cut off. I'll send one email to ${st.email.address} with ${st.email.matchCount} suggested services and their contact details, and nothing personal about you. Shall I send it?`;
        return reply(session, [consent], { expect: "consent", consent: { recipient: st.email.address, matchCount: st.email.matchCount, payloadHash: st.email.payloadHash, revision: session.revision } });
      }
      if (!strictConfirm(text)) {
        if (yn === "no") { st.phase = "results"; st.email = null; return reply(session, ["Okay, I won't send it."], { expect: "results" }); }
        return reply(session, ["I need a clear yes to send the email. Shall I send it — yes or no?"], { expect: "consent" });
      }
      if (st.email.consentRevision !== session.revision) {
        st.phase = "results"; st.email = null;
        return reply(session, ["Your answers changed after I asked, so I haven't sent anything. Let's re-check the plan first."], { expect: "results" });
      }
      const plan = buildPlan(corpus, results);
      if (plan.hash !== st.email.payloadHash) {
        st.phase = "results"; st.email = null;
        return reply(session, ["The plan changed after I asked, so I haven't sent anything."], { expect: "results" });
      }
      const res = ctx.actions.authorizeAndEnqueueEmail(session, { recipient: st.email.address, plan, recommendationId: results.recommendationId, method: "explicit_yes" });
      st.phase = "results";
      const addr = st.email.address;
      st.email = { step: "queued", address: addr, actionId: res.action.id };
      const mockNote = ctx.actions.transportName() === "outbox" ? " This demo is not connected to a real email service yet, so it will go to a local test outbox instead of an inbox." : "";
      return reply(session, [res.duplicate ? "That email was already queued, so I haven't sent a second copy." : `Okay, the email to ${addr} is queued.${mockNote} I'll tell you when it's accepted — that means handed to the email service, which isn't the same as arriving.`, "Is there anything else? I can ask a staff member to follow up."], { expect: "results", actionId: res.action.id });
    }
    return reply(session, ["Let's carry on."], { expect: "results" });
  }

  // ---------------------------------------------------------------- staff
  function beginStaff(session) {
    const st = session.state;
    st.staff = { resumePhase: ["results", "recap", "intake", "opening"].includes(st.phase) ? st.phase : "results" };
    st.phase = "staff_contact";
    return reply(session, ["I can ask a Lions Services staff member to look at this. They'll see your confirmed answers and suggestions, so you won't have to start over.", "If you'd like them to contact you, tell me a phone number or email address. Or say no contact, and I'll just leave a note. In this demo, please use made-up details — nobody will actually call."], { expect: "free" });
  }

  function handleStaff(session, text) {
    const st = session.state;
    const n = normalize(text);
    if (st.phase === "staff_contact") {
      const email = parseEmail(text);
      const digits = text.replace(/[^0-9]/g, "");
      let contact = null;
      if (email) contact = { method: "email", value: email };
      else if (digits.length >= 10 && digits.length <= 11) contact = { method: "phone", value: digits.slice(-10).replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3") };
      else if (/no contact|don't contact|do not contact|just a note|no thanks|no$/.test(n.trim()) || yesNo(text) === "no") contact = { method: "none" };
      if (!contact) return reply(session, ["Sorry, I didn't get that. Tell me a phone number, an email address, or say no contact."], { expect: "free" });
      st.staff.contact = contact;
      st.phase = "staff_confirm";
      const what = contact.method === "none" ? "leave a note for staff with no contact details" : `ask staff to contact you by ${contact.method} at ${contact.method === "phone" ? contact.value.split("").join(" ") : spellEmail(contact.value)}`;
      return reply(session, [`So I'll ${what}. Is that right?`], { expect: "yes_no" });
    }
    if (st.phase === "staff_confirm") {
      const yn = yesNo(text);
      if (yn === "no") { st.phase = "staff_contact"; return reply(session, ["Okay. Tell me a phone number, an email address, or say no contact."], { expect: "free" }); }
      if (yn !== "yes") return reply(session, ["Please say yes or no."], { expect: "yes_no" });
      const c = st.staff.contact;
      store.createStaffReview(session.id, "Requested by the person during the conversation", c.method === "none" ? null : c, c.method !== "none");
      store.audit("caller", session.id, "staff_review_requested", { contactMethod: c.method });
      const resume = st.staff.resumePhase;
      st.staff = { requested: true };
      st.phase = resume;
      return resumeAfterAside(session, ["Done. I've passed this to the staff queue with your confirmed answers and any suggestions.", c.method === "none" ? "" : "This is a demo, so nobody will actually contact you."]);
    }
    return resumeAfterAside(session, []);
  }

  // Browser event: assistant speech was interrupted before it finished.
  function speechInterrupted(session, turnId) {
    const st = session.state;
    store.audit("caller", session.id, "speech_interrupted", { turnId });
    // An authorisation question that wasn't fully heard can't be answered yes.
    if (st.phase === "email_consent" && st.lastAssistant && st.lastAssistant.turnId === turnId) {
      st.email.consentInterrupted = true;
      return true;
    }
    return false;
  }

  function greeting(session) {
    session.state.phase = "opening";
    return reply(session, [
      "Hello, I'm the Vision 360 CONNECT assistant. I'm an automated helper, not a person.",
      "This is a demonstration, so please use made-up details.",
      "I'll ask a few questions, one at a time, then suggest services from the Lions Services directory. You can say repeat, skip, or I don't know at any time, and you can change any answer.",
      "To start, tell me in a sentence or two what's going on — or say: just ask me questions.",
    ], { expect: "free" });
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
