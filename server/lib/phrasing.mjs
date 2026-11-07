// How the assistant talks: personal, plain, one open question at a time.
//
// This changes WORDING only. The questions, their order, the answer options
// and every routing rule still come from site/data/assessment.json. Options
// are not read out up front; they are offered only when an answer isn't clear.
//
// "who" describes the person being helped:
//   { self: true,  name: "Ben" }            -> "you", "your"
//   { self: false, name: "Maria" }          -> "Maria", "Maria's", "does"
//   { self: false, name: null }             -> "they", "their", "do"

export function who(answers, names) {
  const actor = (answers.find((a) => a.questionId === "actor") || {}).value;
  const self = !actor || actor === "self";
  return { self, actor: actor || null, name: self ? (names && names.caller) || null : (names && names.subject) || null, caller: (names && names.caller) || null };
}

function forms(w) {
  if (w.self) return { S: "you", Sc: "You", pos: "your", obj: "you", Do: "Do", do: "do", Be: "Are", be: "are", Have: "Have", have: "have", s: "", nt_be: "aren't", nt_have: "haven't", re: "you're" };
  if (w.name) return { S: w.name, Sc: w.name, pos: `${w.name}'s`, obj: w.name, Do: "Does", do: "does", Be: "Is", be: "is", Have: "Has", have: "has", s: "s", nt_be: "isn't", nt_have: "hasn't", re: `${w.name} is` };
  return { S: "they", Sc: "They", pos: "their", obj: "them", Do: "Do", do: "do", Be: "Are", be: "are", Have: "Have", have: "have", s: "", nt_be: "aren't", nt_have: "haven't", re: "they're" };
}

function fill(t, w) {
  const f = forms(w);
  return t.replace(/\{(\w+)\}/g, (m, k) => (f[k] !== undefined ? f[k] : m));
}

// ------------------------------------------------------------- questions
const ASK = {
  actor: () => "Is this for you, or are you looking into this for someone else?",
  county: "Where {do} {S} live? The town or county is fine.",
  goals: (w) => (w.self ? "What would you most like help with right now?" : "What would {S} most like help with right now?"),
  age_band: "And how old {be} {S}?",
  hearing_loss: "{Do} {S} have any trouble with hearing as well?",
  eye_doctor: "{Do} {S} have an eye doctor right now?",
  eye_exam_recency: "When was {pos} last eye exam, roughly?",
  insurance: "What kind of health insurance {do} {S} have, if any?",
  veteran: "{Have} {S} ever served in the military?",
  va_enrolled: "{Be} {S} signed up for VA health care?",
  discharge: "What type of discharge did {S} receive?",
  housing_stable: "Is {pos} housing steady right now?",
  food_worry: "In the past year, has food ever run out before there was money to buy more?",
  utilities: "In the past year, has a utility company threatened to shut off the power, water or gas?",
  transport_barrier: "In the past year, has getting a ride or transportation kept {obj} from appointments or things {S} need{s}?",
  legal_matter: "Is there any legal issue getting in the way right now?",
  loneliness: "How often {do} {S} feel lonely or cut off from people?",
  broadband: "{Do} {S} have internet at home?",
  devices: "{Do} {S} have a smartphone, a computer or tablet, or neither?",
};

// The workflow's own spoken wording wins (editable in the admin workflow
// editor); ASK is the fallback for flows that don't carry voice_template.
// Placeholders: {S} the person, {pos} their, {obj} them, {do}/{Do}, {be}/{Be},
// {have}/{Have}, {s} verb ending — each turns into "you"/"they"/a name forms.
export function askOpen(question, w) {
  if (question.voice_template) return fill(question.voice_template, w);
  const t = ASK[question.id];
  if (!t) return question.prompt_voice;
  return fill(typeof t === "function" ? t(w) : t, w);
}

// Short, speakable option names (option.short_label in the workflow data)
// are used only when we need to offer choices.
function optLabel(question, v) {
  const o = (question.options || []).find((x) => x.value === v);
  return o ? o.short_label || o.label_voice || o.label_screen : v;
}

export function joinList(items, word = "and") {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + ` ${word} ` + items[items.length - 1];
}

// Offered after an unclear answer.
export function askWithChoices(question, w) {
  if (TYPED_TYPES.has(question.type) && question.type !== "consent") return askOpen(question, w) + (question.help ? " " + question.help : "");
  const vals = (question.options || []).map((o) => o.value).filter((v) => !["not_sure", "never_or_unknown"].includes(v));
  if (question.id === "actor") return "Is this for you, for a family member or friend, or are you a professional making a referral?";
  if (question.type === "yes_no") return `Was that a yes or a no? ${askOpen(question, w)}`;
  if (question.type === "multi") return `For example: ${joinList(vals.map((v) => optLabel(question, v)), "or")}. What would help most?`;
  const qx = askOpen(question, w).replace(/\?.*$/, "");
  return `${qx} — would you say ${joinList(vals.map((v) => optLabel(question, v)), "or")}?`;
}

// ------------------------------------------------------------- sections
// Spoken section introductions come from the workflow data (block.intro_voice).
export function sectionIntro(block, w) {
  if (!block || typeof block.intro_voice !== "string") return null;
  return block.intro_voice ? fill(block.intro_voice, w) : "";
}

// ------------------------------------------------------------- acknowledgements
const FILLERS = ["Got it.", "Okay.", "Thanks.", "Okay, got it.", "Great."];

const TYPED_TYPES = new Set(["text", "long_text", "email", "phone", "address", "date", "consent"]);

export function ack(question, kind, value, detail, w, n = 0) {
  const filler = FILLERS[n % FILLERS.length];
  if (kind === "unknown") return "That's okay — I'll mark that as not sure.";
  if (kind === "declined") return "No problem, we'll leave that one out.";
  if (kind === "skipped") return "Sure, let's skip that one.";
  if (question && question.type === "date" && detail) return `${detail} — got it.`;
  if (question && TYPED_TYPES.has(question.type)) return filler;
  const v = Array.isArray(value) ? value : [value];
  switch (question.id) {
    case "actor":
      if (value === "self") return "Okay, so this is for you.";
      if (value === "family_friend") return "Okay, so you're asking for a family member or friend.";
      return "Okay, so you're making a referral as a professional.";
    case "county":
      return `${detail || optLabel(question, value)} — got it.`.replace(/^a /, "A ");
    case "age_band":
      return detail ? `${detail}, got it.` : filler;
    case "goals":
      return `Okay — help with ${joinList(v.map((x) => optLabel(question, x)))}.`;
    case "hearing_loss":
      return value === "yes" ? "Okay, some hearing loss as well." : "Okay, no trouble with hearing.";
    case "eye_doctor":
      return value === "has" ? fill("Good, so {S} {have} an eye doctor.", w) : "Okay, no eye doctor right now.";
    case "veteran":
      if (value === "yes") return w.self ? "Thank you for your service." : "Okay, noted that they served.";
      return filler;
    case "insurance":
      return `${optLabel(question, value).replace(/^V A/, "VA")}, got it.`.replace(/^./, (c) => c.toUpperCase());
    default:
      return filler;
  }
}

// ------------------------------------------------------------- recap lines
const KIND_TEXT = { unknown: "not sure", declined: "you'd rather not say", skipped: "skipped" };

export function recapLine(question, a, w, label) {
  if (question && TYPED_TYPES.has(question.type) && a.kind === "answer") {
    const shown = a.detail || (question.type === "consent" ? (a.value === "yes" ? "yes" : "no") : String(a.value));
    return `${label.toLowerCase()}: ${shown}`;
  }
  if (a.kind !== "answer" && !(a.kind === "unknown" && a.value && question.id !== "eye_exam_recency")) {
    return `${label.toLowerCase()}: ${KIND_TEXT[a.kind] || a.kind}`;
  }
  const v = a.value;
  const L = (x) => optLabel(question, x);
  const t = (s) => fill(s, w);
  switch (question.id) {
    case "actor":
      if (v === "self") return "this is for you";
      if (v === "family_friend") return w.name ? `this is for ${w.name}, a family member or friend` : "this is for a family member or friend";
      return w.name ? `you're referring ${w.name} as a professional` : "you're making a referral as a professional";
    case "county": return t(`{S} live{s} in ${a.detail || L(v)}`);
    case "goals": return w.self ? `you'd like help with ${joinList([].concat(v).map(L))}` : t(`{S} would like help with ${joinList([].concat(v).map(L))}`);
    case "age_band": return t(`{re} ${a.detail || L(v)}`);
    case "hearing_loss": return v === "yes" ? t("{S} {have} some hearing loss") : v === "no" ? "no trouble with hearing" : "not sure about hearing";
    case "eye_doctor": return v === "has" ? t("{S} {have} an eye doctor") : v === "none" ? "no eye doctor right now" : "not sure about an eye doctor";
    case "eye_exam_recency": return v === "never_or_unknown" ? t("{pos} last eye exam: never, or not remembered") : t(`{pos} last eye exam was ${L(v)}`);
    case "insurance": return v === "uninsured" ? "no health insurance" : v === "not_sure" ? "not sure about insurance" : t(`{S} {have} ${L(v).replace(/^V A/, "VA")}`);
    case "veteran": return v === "yes" ? t("{S} served in the military") : t("{S} {nt_have} served in the military");
    case "va_enrolled": return v === "yes" ? t("{S} {be} signed up for VA health care") : v === "no" ? t("{S} {nt_be} signed up for VA health care") : "not sure about VA health care";
    case "housing_stable": return v === "yes" ? t("{pos} housing is steady") : v === "no" ? t("{pos} housing isn't steady right now") : t("{S} {be} worried {pos} housing may not last");
    case "food_worry": return `food has ${v === "often" ? "often" : "sometimes"} run out before there was money for more`;
    case "utilities": return `a utility company has ${v === "often" ? "often" : "sometimes"} threatened a shut-off`;
    case "transport_barrier": return `transportation is ${v === "often" ? "often" : "sometimes"} a problem`;
    case "legal_matter": return `a legal matter: ${joinList([].concat(v).map(L))}`;
    case "loneliness": return t(`{S} feel{s} lonely or cut off ${v === "often" ? "often" : "sometimes"}`);
    case "broadband": return v === "yes" ? t("{S} {have} internet at home") : v === "no" ? "no internet at home" : "not sure about internet at home";
    case "devices": return [].concat(v).includes("neither") ? "no smartphone or computer" : t(`{S} {have} ${joinList([].concat(v).map(L))}`);
    default: return `${label.toLowerCase()}: ${[].concat(v).map(L).join(", ")}`;
  }
}

// Everyday answers that mean "no concern": folded into one short phrase in
// the spoken summary instead of being read out one by one.
// Uses question.no_concern_topic and the options marked no_concern.
export function noConcernTopic(a, question) {
  if (!question || !question.no_concern_topic || a.kind !== "answer") return null;
  const vals = [].concat(a.value);
  const fine = (question.options || []).filter((o) => o.no_concern).map((o) => o.value);
  return vals.length === 1 && fine.includes(vals[0]) ? question.no_concern_topic : null;
}

// Screen labels for the recap card, personalised (question.screen_label and
// screen_label_self in the workflow data; the recap label otherwise).
export function screenLabel(question, w, fallback) {
  if (!question) return fallback;
  return (w.self && question.screen_label_self) || question.screen_label || fallback;
}

export function greetingText() {
  return [
    "Hi there! I'm the Vision 360 assistant from Lions Services. I'm an automated helper, and I'm here to help find services for people with vision loss.",
    "This is a demo, so feel free to use made-up details.",
    "First, what's your first name?",
  ];
}
