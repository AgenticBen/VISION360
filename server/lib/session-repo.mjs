// Session repository and per-turn unit of work.
//
// A turn works like this:
//   load(id)   read the session and everything the conversation needs, once
//   ...        the dialogue reads and changes an in-memory copy (session.work)
//   save(s)    write every change in ONE transaction, and only if nobody else
//              saved this session since it was loaded (save-counter check)
//
// The dialogue never talks to the database. That keeps it pure, makes it the
// same for chat, voice and (later) phone, and means a hosted database can
// replace SQLite by implementing load/save, without touching conversation code.
import { randomUUID } from "node:crypto";
import { emailIdempotencyKey, EMAIL_PURPOSE } from "./actions.mjs";
import { nowIso } from "./store.mjs";

const CANCELLABLE = ["prepared", "awaiting_authorization", "queued", "retrying"];

export class SessionConflict extends Error {
  constructor() {
    super("This conversation was updated somewhere else at the same moment. Please try that again.");
    this.status = 409;
    this.code = "conflict";
  }
}

// In-memory copy of one session's records plus the list of changes to write.
// Method names mirror the store so the dialogue reads naturally.
export function createSessionWork({ sessionId, answers, recommendations, actions, reviews }) {
  const st = {
    answers: answers.map((a) => ({ ...a })),
    recommendations: recommendations.map((r) => ({ ...r })),
    actions: actions.map((a) => ({ ...a })),
    reviews: reviews.map((r) => ({ ...r })),
  };
  const ops = [];
  const op = (name, ...args) => ops.push({ name, args });

  return {
    ops,

    getAnswers() {
      return st.answers.map((a) => ({ ...a }));
    },
    putAnswer(a) {
      const row = { questionId: a.questionId, value: a.value ?? null, kind: a.kind, revision: a.revision, confirmedRevision: a.confirmedRevision ?? null, source: a.source, detail: a.detail || null, updatedAt: nowIso() };
      st.answers = st.answers.filter((x) => x.questionId !== a.questionId).concat(row);
      op("putAnswer", { ...a });
    },
    deleteAnswer(questionId) {
      st.answers = st.answers.filter((x) => x.questionId !== questionId);
      op("deleteAnswer", questionId);
    },
    deleteAllAnswers() {
      st.answers = [];
      op("deleteAllAnswers");
    },
    confirmAllAnswers(revision) {
      st.answers.forEach((a) => { a.confirmedRevision = revision; });
      op("confirmAllAnswers", revision);
    },
    answerEvent(questionId, event, value, kind, revision) {
      op("answerEvent", questionId, event, value, kind, revision);
    },

    currentRecommendation() {
      const live = st.recommendations.filter((r) => !r.stale);
      return live.length ? { ...live[live.length - 1] } : null;
    },
    saveRecommendation(revision, corpusVersion, result) {
      const id = randomUUID();
      const saved = JSON.parse(JSON.stringify(result)); // a snapshot, not a live reference
      st.recommendations.forEach((r) => { r.stale = 1; });
      st.recommendations.push({ id, revision, corpus_version: corpusVersion, stale: 0, created_at: nowIso(), result: saved });
      op("saveRecommendation", revision, corpusVersion, saved, id);
      return id;
    },
    markRecommendationsStale() {
      const live = st.recommendations.filter((r) => !r.stale);
      live.forEach((r) => { r.stale = 1; });
      op("markRecommendationsStale");
      return live.length;
    },

    actionsForSession() {
      return st.actions.map((a) => ({ ...a }));
    },
    cancelStaleActions(revision) {
      let n = 0;
      for (const a of st.actions) {
        if (a.revision < revision && CANCELLABLE.includes(a.status)) {
          a.status = "cancelled";
          a.error = "Answers changed after this was authorised";
          n++;
        }
      }
      op("cancelStaleActions", revision);
      return n;
    },
    // Records the person's explicit consent and queues the email, once.
    enqueueEmail(session, { recipient, plan, recommendationId, method }) {
      const idempotencyKey = emailIdempotencyKey(session.id, recipient, plan.hash, session.revision);
      const existing = st.actions.find((a) => a.idempotency_key === idempotencyKey);
      if (existing) {
        op("audit", "caller", "action_duplicate_ignored", { actionId: existing.id, type: "email_plan" });
        return { action: { ...existing }, duplicate: true };
      }
      const authorizationId = randomUUID();
      const t = nowIso();
      const action = { id: randomUUID(), type: "email_plan", status: "queued", attempts: 0, provider: null, provider_receipt: null, error: null, revision: session.revision, idempotency_key: idempotencyKey, created_at: t, updated_at: t };
      st.actions.push(action);
      op("saveAuthorization", { id: authorizationId, sessionId: session.id, actionType: "email_plan", destination: recipient, payloadHash: plan.hash, purpose: EMAIL_PURPOSE, revision: session.revision, recommendationId, method });
      op("enqueueAction", { id: action.id, sessionId: session.id, type: "email_plan", idempotencyKey, authorizationId, revision: session.revision, payload: { to: recipient, subject: plan.subject, text: plan.text, html: plan.html, hash: plan.hash, recommendationId } });
      op("audit", "caller", "action_authorized", { actionId: action.id, type: "email_plan" });
      return { action: { ...action }, duplicate: false };
    },

    staffReviews() {
      return st.reviews.map((r) => ({ ...r }));
    },
    createStaffReview(reason, contact, callbackOk) {
      const id = randomUUID();
      const t = nowIso();
      st.reviews.push({ id, session_id: sessionId, reason, contact: contact || null, callback_ok: callbackOk ? 1 : 0, status: "pending", owner: null, created_at: t, updated_at: t });
      op("createStaffReview", reason, contact, callbackOk, id);
      return id;
    },

    audit(actor, event, detail) {
      op("audit", actor, event, detail);
    },
  };
}

function applyOp(store, sessionId, { name, args }) {
  switch (name) {
    case "putAnswer": return store.putAnswer(sessionId, args[0]);
    case "deleteAnswer": return store.deleteAnswer(sessionId, args[0]);
    case "deleteAllAnswers": return store.deleteAllAnswers(sessionId);
    case "confirmAllAnswers": return store.confirmAllAnswers(sessionId, args[0]);
    case "answerEvent": return store.answerEvent(sessionId, ...args);
    case "saveRecommendation": return store.saveRecommendation(sessionId, ...args);
    case "markRecommendationsStale": return store.markRecommendationsStale(sessionId);
    case "cancelStaleActions": return store.cancelStaleActions(sessionId, args[0]);
    case "saveAuthorization": return store.saveAuthorization(args[0]);
    case "enqueueAction": return store.enqueueAction(args[0]);
    case "createStaffReview": return store.createStaffReview(sessionId, ...args);
    case "audit": return store.audit(args[0], sessionId, args[1], args[2]);
    default: throw new Error("Unknown session change: " + name);
  }
}

// SQLite implementation. A hosted database implements the same two methods.
export function createSqliteSessionRepo(store) {
  return {
    async load(sessionId) {
      const s = store.getSession(sessionId);
      if (!s) return null;
      s.work = createSessionWork({
        sessionId,
        answers: store.getAnswers(sessionId),
        recommendations: store.recommendations(sessionId),
        actions: store.actionRowsForSession(sessionId),
        reviews: store.staffReviews(sessionId),
      });
      s.work.expectedVersion = s.version;
      return s;
    },

    async save(s) {
      const work = s.work;
      store.tx(() => {
        if (!store.saveSessionGuarded(s, work.expectedVersion)) throw new SessionConflict();
        for (const change of work.ops) applyOp(store, s.id, change);
      });
      work.ops.length = 0;
      work.expectedVersion += 1;
      s.version = work.expectedVersion;
    },
  };
}
