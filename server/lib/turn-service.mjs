// Channel-neutral conversation service. The web API calls it today; a phone
// adapter can call the same functions later. It owns the order of one turn:
//
//   load session -> optional AI readings -> dialogue (pure) -> save -> email worker
//
// Nothing here knows about HTTP. Errors carry a `status` the caller can map.
import { aiEnabled, interpretWithAI, extractWithAI, extractEmailWithAI } from "./ai-understanding.mjs";
import { interpretAnswer, detectGlobal, looksLikeCorrection, parseEmail } from "./understand.mjs";
import { newDialogueState } from "./dialogue.mjs";

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function createTurnService({ corpus, store, repo, dialogue, actions, env, aiFetch = globalThis.fetch }) {
  // Optional AI help, only where the rules can't tell. Returns explicit
  // readings for the dialogue; failures fall back to the rules silently.
  async function interpret(session, input) {
    const out = {};
    if (!aiEnabled(env) || !input.text || input.choice || input.action) return out;
    const c = dialogue.aiContext(session);
    const g = detectGlobal(input.text);
    if (g.repeat || g.help || g.staff || g.end || g.startOver || g.skipSection) return out;
    try {
      if ((c.phase === "email_address" || c.phase === "staff_contact") && /@| at /i.test(input.text) && !parseEmail(input.text)) {
        out.email = await extractEmailWithAI(env, aiFetch, { utterance: input.text });
        session.work.audit("system", "ai_email", { found: !!out.email });
      } else if (c.phase === "opening") {
        out.extract = await extractWithAI(env, aiFetch, { questions: c.openQuestions, utterance: input.text });
        session.work.audit("system", "ai_extract", { n: out.extract.length });
      } else if (c.phase === "intake" && c.currentQuestion && !c.pending && !looksLikeCorrection(input.text)) {
        const det = interpretAnswer(input.text, c.currentQuestion, { geography: corpus.geography });
        if (det.kind !== "unclear") return out;
        const r = await interpretWithAI(env, aiFetch, { question: c.currentQuestion, utterance: input.text, otherQuestions: c.openQuestions.filter((x) => x.id !== c.currentQuestion.id) });
        if (r) { out.interp = { ...r, questionId: c.currentQuestion.id }; session.work.audit("system", "ai_interpret", { kind: r.kind }); }
      }
    } catch (e) {
      session.work.audit("system", "ai_unavailable", { error: String(e.message).slice(0, 80) });
    }
    return out;
  }

  // Serverless has no background loop, so finish the email job before
  // replying there; locally the dev server's worker loop also picks it up.
  async function runWorker(awaitIt) {
    if (env.V360_INLINE_WORKER === "off") return;
    const job = actions.drain(5).catch((e) => console.error("worker error", e.message));
    if (awaitIt) await job;
  }

  async function start({ mode, tokenHash }) {
    const id = store.createSession({ tokenHash, corpusVersion: corpus.version, state: newDialogueState() });
    const s = await repo.load(id);
    s.notice_ack_at = new Date().toISOString();
    s.channels = [{ mode: mode === "voice" ? "voice" : "text", at: s.notice_ack_at }];
    const turn = dialogue.greeting(s);
    s.work.audit("caller", "session_started", { mode });
    await repo.save(s);
    return { session: s, turn };
  }

  async function turn(s, body) {
    if (s.status === "ended") throw fail(409, "This session has ended.");
    const mode = body.mode === "voice" ? "voice" : "text";
    const last = s.channels[s.channels.length - 1];
    if (!last || last.mode !== mode) s.channels.push({ mode, at: new Date().toISOString() });
    const input = {
      text: typeof body.text === "string" ? body.text : "",
      choice: body.choice && typeof body.choice === "object" ? { questionId: String(body.choice.questionId || ""), value: body.choice.value } : null,
      action: typeof body.action === "string" ? body.action : null,
      questionId: typeof body.questionId === "string" ? body.questionId : null,
      revision: body.revision === undefined ? null : Number(body.revision),
      mode,
    };
    input.interpretations = await interpret(s, input);
    const reply = dialogue.handle(s, input);
    await repo.save(s);
    if (!reply.actionId) return { reply, session: s };
    if (env.V360_SERVERLESS) {
      // The email was handled before replying, so show its real status.
      await runWorker(true);
      return { reply, session: await repo.load(s.id) };
    }
    runWorker(false);
    return { reply, session: s };
  }

  async function event(s, body) {
    if (body.type === "speech_interrupted") {
      const changed = dialogue.speechInterrupted(s, String(body.turnId || ""));
      await repo.save(s);
      return { ok: true, consentMustBeRepeated: changed };
    }
    if (body.type === "mode_switch") {
      const mode = body.mode === "voice" ? "voice" : "text";
      s.channels.push({ mode, at: new Date().toISOString() });
      s.work.audit("caller", "mode_switch", { mode });
      await repo.save(s);
      return { ok: true, state: dialogue.snapshot(s) };
    }
    throw fail(400, "Unknown event");
  }

  async function end(s) {
    s.status = "ended";
    s.state.phase = "closed";
    s.work.audit("caller", "session_ended", null);
    await repo.save(s);
    return { ok: true };
  }

  return { start, turn, event, end, interpret };
}
