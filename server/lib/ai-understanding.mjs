// Optional AI help for understanding free-form answers.
//
// OFF unless V360_AI_UNDERSTANDING=on and a Vercel AI Gateway credential is
// available (AI_GATEWAY_API_KEY, or the VERCEL_OIDC_TOKEN that Vercel provides).
//
// What the model is allowed to do: pick answer CODES that already exist in
// site/data/assessment.json for the question(s) we pass in, or say it is
// unsure. Every code it returns is checked against the allowed list and
// anything else is discarded. It never writes what the person sees about
// services, and its answers are only PROPOSED: the person still hears them
// read back and must confirm the recap before any matching happens.
// If the call fails or is slow, the rule-based parser's result stands.

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
// Gemini 2.5 Flash works on the free AI Gateway tier; Anthropic models need paid credits.
export const DEFAULT_MODEL = "google/gemini-2.5-flash";

export function aiEnabled(env) {
  return env.V360_AI_UNDERSTANDING === "on" && !!(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN);
}

function questionSpec(q) {
  return {
    id: q.id,
    question: q.prompt_voice || q.prompt_screen,
    type: q.type,
    options: (q.options || []).map((o) => ({ code: o.value, means: o.label_screen || o.label_voice })),
  };
}

const SYSTEM = [
  "You help an accessible referral assistant understand what a person said.",
  "You ONLY map their words to the answer codes provided. Never invent a code, never give advice, never add facts.",
  "If they clearly do not know, return kind \"unknown\" (use a not_sure / never_or_unknown code only if one is offered).",
  "If they decline to answer, return \"declined\". If they ask to skip, return \"skipped\".",
  "If two codes are both plausible, or a date can't be placed relative to today, return \"ambiguous\" with the candidate codes.",
  "If you can't tell, return \"unclear\". Prefer unclear over guessing.",
  "Reply with JSON only, no prose.",
].join(" ");

export async function callModel(env, fetchImpl, messages) {
  const token = env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN;
  const res = await fetchImpl(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // Generous limit: some models spend part of it reasoning before they answer.
    body: JSON.stringify({ model: env.V360_AI_MODEL || DEFAULT_MODEL, messages, temperature: 0, max_tokens: Number(env.V360_AI_MAX_TOKENS || 2000) }),
    signal: AbortSignal.timeout(Number(env.V360_AI_TIMEOUT_MS || 6000)),
  });
  if (!res.ok) throw new Error("AI gateway " + res.status);
  const j = await res.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return parseJson(text);
}

function parseJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Keep only codes that exist for that question.
export function validateValue(q, value) {
  const allowed = new Set((q.options || []).map((o) => o.value));
  if (q.type === "multi") {
    const arr = [].concat(value || []).map(String).filter((v) => allowed.has(v));
    return arr.length ? [...new Set(arr)] : null;
  }
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && allowed.has(v) ? v : null;
}

function validateOthers(others, questions) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out = [];
  for (const o of [].concat(others || [])) {
    const q = o && byId.get(o.questionId);
    if (!q) continue;
    const v = validateValue(q, o.value);
    if (v !== null && v !== "not_sure" && v !== "never_or_unknown") out.push({ questionId: q.id, value: v });
  }
  return out;
}

// Interpret an answer to ONE current question. `others` lists later questions
// the person may have answered at the same time.
export async function interpretWithAI(env, fetchImpl, { question, utterance, otherQuestions = [], today = new Date() }) {
  const user = {
    today: today.toISOString().slice(0, 10),
    current_question: questionSpec(question),
    other_questions_not_yet_answered: otherQuestions.map(questionSpec),
    person_said: String(utterance).slice(0, 600),
    reply_format: { kind: "answer|unknown|declined|skipped|ambiguous|unclear", value: "code, or array of codes for multi, or null", candidates: "codes when ambiguous", others: [{ questionId: "id", value: "code or codes" }] },
  };
  const r = await callModel(env, fetchImpl, [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(user) }]);
  if (!r || typeof r !== "object") return null;
  const kinds = ["answer", "unknown", "declined", "skipped", "ambiguous", "unclear"];
  const kind = kinds.includes(r.kind) ? r.kind : "unclear";
  const out = { kind, value: null, others: validateOthers(r.others, otherQuestions), source: "ai" };
  if (kind === "answer") {
    out.value = validateValue(question, r.value);
    if (out.value === null) out.kind = "unclear";
    else if (out.value === "not_sure" || out.value === "never_or_unknown") out.kind = "unknown";
  } else if (kind === "unknown") {
    const v = validateValue(question, r.value);
    out.value = v === "not_sure" || v === "never_or_unknown" ? v : null;
  } else if (kind === "ambiguous") {
    const c = [].concat(r.candidates || r.value || []).map(String).filter((v) => validateValue(question, v) !== null);
    if (c.length >= 2) out.options = [...new Set(c)];
    else out.kind = "unclear";
  }
  return out;
}

// Opening sentence: pull out any answers it clearly gives, across questions.
export async function extractWithAI(env, fetchImpl, { questions, utterance, today = new Date() }) {
  const user = {
    today: today.toISOString().slice(0, 10),
    questions: questions.map(questionSpec),
    person_said: String(utterance).slice(0, 800),
    instruction: "List only answers the person clearly gave. Leave out anything uncertain.",
    reply_format: { answers: [{ questionId: "id", value: "code or codes" }] },
  };
  const r = await callModel(env, fetchImpl, [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(user) }]);
  if (!r) return [];
  return validateOthers(r.answers, questions);
}

// Pull an email address out of a messy spoken reply. The result must look
// like an address; it is always read back to the person for a yes.
export async function extractEmailWithAI(env, fetchImpl, { utterance }) {
  const user = {
    person_said: String(utterance).slice(0, 300),
    instruction: "The person was asked for their email address, possibly by voice (\"at\" = @, \"dot\" = .). Return only the address they gave, or null if there isn't a complete one. Do not guess missing parts.",
    reply_format: { email: "address or null" },
  };
  const r = await callModel(env, fetchImpl, [{ role: "system", content: "You extract an email address from speech-to-text. Reply with JSON only." }, { role: "user", content: JSON.stringify(user) }]);
  const e = r && typeof r.email === "string" ? r.email.trim().toLowerCase() : null;
  return e && /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : null;
}
