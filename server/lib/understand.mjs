// Turns a typed or transcribed utterance into a PROPOSED structured answer.
//
// Deterministic on purpose: every value it can return is an option that
// already exists in site/data/assessment.json, matched by that option's own
// label or aliases. It never invents a value, and when it is unsure it says so
// (kind "unclear" / "ambiguous") so the dialogue asks a clarifying question
// instead of guessing. A proposal is never a confirmation.

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, last: -1 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function normalize(text) {
  return " " + String(text || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9@.'\s-]/g, " ")
    .replace(/\.+(\s|$)/g, " ")
    .replace(/(^|\s)'|'(\s|$)/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim() + " ";
}

function has(norm, phrase) {
  const p = normalize(phrase);
  if (p.trim() === "") return false;
  return norm.includes(p);
}

function anyOf(norm, phrases) {
  return phrases.some((p) => has(norm, p));
}

// Spoken numbers: "sixty seven" -> 67, "67" -> 67. Returns the first number found.
export function findNumber(norm) {
  const digits = norm.match(/\b(\d{1,4})\b/);
  if (digits) return Number(digits[1]);
  const words = norm.trim().split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (NUMBER_WORDS[w] !== undefined && w !== "one") {
      let n = NUMBER_WORDS[w];
      const next = NUMBER_WORDS[words[i + 1]];
      if (n >= 20 && next !== undefined && next < 10) n += next;
      return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------- intents
const GLOBAL = {
  repeat: ["repeat", "say that again", "say it again", "what was the question", "pardon", "come again", "didn't catch", "did not catch", "one more time", "what did you say"],
  help: ["what do you mean", "why do you ask", "why are you asking", "explain", "what does that mean", "i don't understand", "i do not understand", "help me understand"],
  declined: ["rather not say", "rather not answer", "prefer not to say", "prefer not to answer", "don't want to say", "do not want to say", "don't want to answer", "decline", "none of your business", "that's private", "that is private", "keep that private"],
  skip: ["skip", "pass", "next question", "move on", "skip it", "skip this"],
  skipSection: ["skip this section", "skip the section", "skip that section", "skip all of these", "skip these questions", "skip the whole section", "skip everything"],
  unknown: ["don't know", "do not know", "not sure", "no idea", "no clue", "dunno", "unsure", "can't say", "cannot say", "i'm not certain", "not certain", "don't remember", "do not remember", "can't remember", "cannot remember", "can't recall", "no recollection", "not that i know"],
  staff: ["talk to a person", "speak to a person", "talk to someone real", "real person", "a human", "talk to staff", "speak to staff", "staff member", "someone call me", "call me back", "speak to someone at lions", "talk to a navigator", "need a person"],
  startOver: ["start over", "start again", "begin again", "restart"],
  end: ["end the session", "end session", "goodbye", "good bye", "i'm done", "that's all", "hang up", "end the conversation"],
  email: ["email", "e mail", "send it to me", "send me", "mail me", "send the plan"],
  noEmail: ["no email", "don't have email", "do not have email", "don't have an email", "no e mail", "without email"],
  results: ["show results", "see results", "my suggestions", "what do you suggest", "recommendations", "show me the list"],
};

const END_FILLER = new Set(["no", "nope", "thanks", "thank", "you", "so", "okay", "ok", "bye", "for", "now", "then", "really", "i", "think", "please", "and"]);

// True when the text is made only of these phrases plus filler words.
function onlyPhrases(norm, phrases, filler) {
  let n = norm;
  const sorted = phrases.map((p) => normalize(p)).filter((p) => p.trim()).sort((a, b) => b.length - a.length);
  for (const p of sorted) while (n.includes(p)) n = n.replace(p, " ");
  return n.trim().split(/\s+/).filter((w) => w && !filler.has(w)).length === 0;
}

export function detectGlobal(text) {
  const n = normalize(text);
  const hits = {};
  for (const [k, list] of Object.entries(GLOBAL)) if (anyOf(n, list)) hits[k] = true;
  // "that's all" ends the session only when that is all the person said
  // ("no, that's all, thanks"), never inside "that's all correct".
  if (hits.end && !onlyPhrases(n, GLOBAL.end, END_FILLER)) delete hits.end;
  // "skip this section" is more specific than "skip".
  if (hits.skipSection) delete hits.skip;
  if (hits.noEmail) delete hits.email;
  return hits;
}

// ---------------------------------------------------------------- yes / no
const YES = ["yes", "yeah", "yep", "yup", "yes please", "correct", "that's right", "that is right", "right", "sure", "affirmative", "i do", "i have", "they do", "she does", "he does", "they have", "he did", "she did", "they did", "uh huh", "of course", "definitely", "absolutely", "ok", "okay", "please do", "go ahead", "do it", "sounds good", "looks good", "that's correct", "that is correct", "confirm", "confirmed", "all correct", "all good", "spot on", "exactly"];
const NO = ["no", "nope", "nah", "not really", "never", "i don't", "i do not", "they don't", "he doesn't", "she doesn't", "not at all", "negative", "don't", "do not", "wrong", "that's wrong", "not right", "incorrect", "cancel", "no thanks", "no thank you"];

export function yesNo(text) {
  // "not sure" contains "sure" and "no idea" contains "no", but neither is a
  // yes or a no: take every "don't know" phrase out before looking.
  let stripped = normalize(text);
  for (const p of GLOBAL.unknown.map((x) => normalize(x))) while (stripped.includes(p)) stripped = stripped.replace(p, " ");
  const y = anyOf(stripped, YES);
  const no = anyOf(stripped, NO);
  if (y && !no) return "yes";
  if (no && !y) return "no";
  if (y && no) return "mixed";
  return null;
}

// Strict confirmation used for the final recap and action authorisation:
// a short, clear yes with no correction attached. "Yes but change the county"
// is not a confirmation.
//
// It must be a BARE yes: only yes-words and filler ("yes, that's right",
// "yep, sounds good"). Anything else ("yes I'm 70", "yes but it's dot org",
// "I do have an eye doctor", "yes, wait") is new information or a hesitation,
// so it is never taken as confirmation.
const CONFIRM_FILLER = new Set(["that's", "thats", "that", "is", "it's", "its", "it", "all", "good", "sounds", "looks", "please", "thanks", "thank", "you", "ma'am", "maam", "sir", "so", "well", "oh", "um", "uh", "ah", "just", "everything", "great", "perfect", "totally", "really", "very", "much", "the", "summary", "fine", "and", "send"]);

export function strictConfirm(text) {
  const n = normalize(text);
  if (yesNo(text) !== "yes") return false;
  if (n.trim().split(" ").filter(Boolean).length > 12) return false;
  return onlyPhrases(n, YES, CONFIRM_FILLER);
}

// ---------------------------------------------------------------- options
// Everyday words for each option live in the workflow data (option.aliases).
function optionPhrases(opt, q) {
  const list = [];
  if (opt.label_voice) list.push(opt.label_voice);
  if (opt.label_screen) list.push(opt.label_screen);
  list.push(opt.value.replace(/_/g, " "));
  for (const a of opt.aliases || []) list.push(a);
  return [...new Set(list.map((p) => p.toLowerCase()))];
}

// Score how well an utterance matches each option: longest matching phrase wins.
function matchOptions(n, q, { distinctiveOnly = false } = {}) {
  const out = [];
  for (const opt of q.options || []) {
    let best = 0, phrase = null;
    for (const p of optionPhrases(opt, q)) {
      if (distinctiveOnly && !isDistinctive(p)) continue;
      if (has(n, p) && p.length > best) { best = p.length; phrase = p; }
    }
    if (best) out.push({ value: opt.value, score: best, phrase });
  }
  return out.sort((a, b) => b.score - a.score);
}

const GENERIC = new Set(["yes", "no", "not sure", "never", "often", "sometimes", "none", "nothing", "maybe", "dunno", "don't know", "fine", "both", "neither", "other", "adult", "reading", "walking", "mobile", "vet", "general", "denied", "refused", "they said no", "sc", "oth", "dd", "i think so", "i see one", "me", "i am", "myself", "for me", "a lot", "recently", "long time", "student", "older", "senior", "phone", "tech", "apps", "community", "social", "friends", "camp", "private", "nothing", "no cover"]);
function isDistinctive(p) {
  return p.length >= 4 && !GENERIC.has(p);
}

function ordinalChoice(n, q) {
  const opts = q.options || [];
  const m = n.match(/ (?:option|number|choice) (\d|one|two|three|four|five|six|seven|eight) /);
  let idx = null;
  if (m) idx = /\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  else {
    for (const [w, v] of Object.entries(ORDINALS)) if (has(n, `the ${w} one`) || n.trim() === w) idx = v;
  }
  if (idx === null || idx === undefined) return null;
  if (idx === -1) idx = opts.length;
  return opts[idx - 1] ? opts[idx - 1].value : null;
}

// Special handling for questions where people answer with a number or a date.
// All numbers in the text, digits or words ("13 or 14", "between 50 and 60").
function allNumbers(norm) {
  const out = (norm.match(/\b\d{1,3}\b/g) || []).map(Number);
  const words = norm.trim().split(" ");
  for (let i = 0; i < words.length; i++) {
    const v = NUMBER_WORDS[words[i]];
    if (v === undefined || words[i] === "one") continue;
    const next = NUMBER_WORDS[words[i + 1]];
    if (v >= 20 && next !== undefined && next < 10) { out.push(v + next); i++; } else out.push(v);
  }
  return out;
}

const BAND_EDGES = [[0, 2, "under_3"], [3, 13, "3_to_13"], [14, 21, "14_to_21"], [22, 54, "22_to_54"], [55, 120, "55_plus"]];
const bandOf = (age) => (BAND_EDGES.find(([lo, hi]) => age >= lo && age <= hi) || [])[2] || null;

// "under 55", "over 50", "13 or 14", "my mom is 80 but I'm 50". Returns
//   { bands: [...] } when the words allow more than one age band (ask), or
//   { band } when an open range still lands in exactly one band ("over 60").
// null means the plain number can be used as said.
export function ageAmbiguity(n) {
  if (/\b(month|months|week|weeks)\b/.test(n)) return null;
  const nums = allNumbers(n);
  if (!nums.length) return null;
  const spread = (ages) => [...new Set(ages.filter((a) => a >= 0 && a <= 120).map(bandOf).filter(Boolean))];
  let bands = null;
  if (nums.length > 1) bands = spread(nums);
  else if (/ (under|below|younger than|less than|almost|nearly|not quite) /.test(n)) bands = spread([nums[0] - 1, nums[0] - 5, nums[0] - 15]);
  else if (/ (over|above|older than|more than|at least) /.test(n)) bands = spread([nums[0] + 1, nums[0] + 5, nums[0] + 15]);
  if (!bands) return null;
  return bands.length > 1 ? { bands } : { band: bands[0] };
}

function ageBand(n) {
  const age = findNumber(n);
  if (age === null) return null;
  if (/\b(month|months|week|weeks)\b/.test(n) && age < 36) return "under_3";
  if (age > 120) return null;
  if (age < 3) return "under_3";
  if (age <= 13) return "3_to_13";
  if (age <= 21) return "14_to_21";
  if (age <= 54) return "22_to_54";
  return "55_plus";
}

// "When was the last eye exam?" A bare month, or "about a year ago", is
// ambiguous: ask rather than guess. Today's date comes from the caller so tests
// can pin it.
function examRecency(n, today) {
  const year = today.getFullYear();
  // "not this year", "not recently", "hasn't been in the last year": a
  // negation flips the meaning, so ask rather than guess either way.
  if (/ (not|never|hasn't|haven't|wasn't|didn't|isn't|no) /.test(n) && / (year|recent|recently|month|months|lately) /.test(n)) {
    return { ambiguous: true, reason: "I want to be sure which side of a year that was" };
  }
  if (/ less than (two|2|a couple of|three|3|\d+) years /.test(n)) return { ambiguous: true, reason: "that could be more or less than a year ago" };
  // Clear relative phrases first: "within the last year" contains "last year".
  if (/ (within|in) the (last|past) (year|twelve months|12 months) | less than a year | (earlier )?this year | under a year /.test(n)) return { value: "within_year" };
  if (/ (more than|over) a year | (more than|over) (one|1) year | (several|a few|two|three|\d+) years (ago|back) /.test(n)) return { value: "more_than_year" };
  const yearMatch = n.match(/\b(19|20)(\d\d)\b/);
  if (yearMatch) {
    const y = Number(yearMatch[0]);
    if (y >= year) return { value: "within_year" };
    if (y <= year - 2) return { value: "more_than_year" };
    return { ambiguous: true, reason: `you said ${y}, which could be more or less than a year ago` };
  }
  const num = findNumber(n);
  if (num !== null && / (month|months) (ago|back) /.test(n)) {
    if (num < 12) return { value: "within_year" };
    if (num > 12) return { value: "more_than_year" };
    return { ambiguous: true, reason: "about a year ago could be either side of a year" };
  }
  if (num !== null && / (year|years) (ago|back) /.test(n) && num >= 2) return { value: "more_than_year" };
  if (has(n, "a year ago") || has(n, "about a year") || has(n, "last year") || has(n, "year or so")) {
    return { ambiguous: true, reason: "about a year ago could be either side of a year" };
  }
  if (MONTHS.some((m) => has(n, m)) || has(n, "last spring") || has(n, "last summer") || has(n, "last fall") || has(n, "last winter") || has(n, "in the spring") || has(n, "in the summer")) {
    return { ambiguous: true, reason: "I'm not sure which year that was" };
  }
  return null;
}

// Map a place name to the county option using the geography config, so county
// names stay data-driven (geography.json), not hardcoded here.
function countyFromGeography(n, geography) {
  const tiers = geography.tiers || [];
  for (const t of tiers) {
    for (const c of t.counties || []) {
      if (has(n, c) || has(n, c + " county")) {
        if (t.id === "home") return "mecklenburg";
        if (t.id === "adjacent") return "neighbouring";
        return { regional: c };
      }
    }
  }
  return null;
}

// Main entry: interpret an utterance as an answer to question q.
// Returns one of:
//   {kind:"answer", value, phrase}        value is an option value, or array for multi
//   {kind:"unknown", value|null}          caller does not know (value = not_sure option if one exists)
//   {kind:"declined"} | {kind:"skipped"}
//   {kind:"ambiguous", options:[...], reason}
//   {kind:"unclear"}
export function interpretAnswer(text, q, ctx = {}) {
  if (TYPED.has(q.type)) return interpretTyped(text, q, ctx);
  const n = normalize(text);
  const g = detectGlobal(text);
  const today = ctx.today || new Date();
  const values = (q.options || []).map((o) => o.value);
  const notSure = values.find((v) => v === "not_sure" || v === "never_or_unknown");

  if (g.declined && (q.sensitive || q.skippable)) return { kind: "declined" };

  // "no idea", "not sure", "I don't remember": the person doesn't know. Check
  // this before yes/no, so "no idea" is never a no and "not sure" never a yes.
  if (g.unknown && !matchOptions(n, q, { distinctiveOnly: true }).some((m) => m.value !== "not_sure" && m.value !== "never_or_unknown")) {
    return { kind: "unknown", value: notSure || null };
  }

  // Question-specific parsers first.
  if (q.id === "age_band") {
    const amb = ageAmbiguity(n);
    if (amb && amb.bands) return { kind: "ambiguous", options: amb.bands, reason: "I heard more than one possible age" };
    if (amb && amb.band) return { kind: "answer", value: amb.band, phrase: "age", detail: null };
    const band = ageBand(n);
    const num = findNumber(n);
    if (band) return { kind: "answer", value: band, phrase: "age", detail: num !== null && !/\b(month|months|week|weeks)\b/.test(n) ? String(num) : null };
  }
  if (q.id === "eye_exam_recency") {
    const r = examRecency(n, today);
    if (r && r.ambiguous) return { kind: "ambiguous", options: ["within_year", "more_than_year"], reason: r.reason };
    if (r && r.value) return { kind: "answer", value: r.value, phrase: "date" };
  }
  if (q.id === "county") {
    const c = countyFromGeography(n, ctx.geography || { tiers: [] });
    if (typeof c === "string") return { kind: "answer", value: c, phrase: "county", detail: countyDetail(n, ctx.geography) };
    if (c && c.regional) {
      // In the wider region but not next door: the options do not cover this
      // exactly, so ask rather than force it into a bucket.
      return { kind: "ambiguous", options: ["neighbouring", "elsewhere_nc"], reason: `${titleCase(c.regional)} County is near Charlotte but does not border Mecklenburg` };
    }
  }

  const ord = ordinalChoice(n, q);
  if (ord) return { kind: "answer", value: q.type === "multi" ? [ord] : ord, phrase: "ordinal" };

  let matches = matchOptions(n, q);

  // Yes/no questions also accept plain yes/no words.
  if (q.type === "yes_no" || values.includes("yes")) {
    const yn = yesNo(text);
    if (yn === "yes" && values.includes("yes") && !matches.some((m) => m.value === "yes")) matches.push({ value: "yes", score: 3, phrase: "yes" });
    if (yn === "no" && values.includes("no") && !matches.some((m) => m.value === "no")) matches.push({ value: "no", score: 2, phrase: "no" });
    matches.sort((a, b) => b.score - a.score);
  }

  if (q.type === "multi") {
    let chosen = matches.map((m) => m.value);
    if (has(n, "all of them") || has(n, "everything") || has(n, "all of those")) chosen = values.filter((v) => !["none", "neither", "not_sure"].includes(v));
    // "none"/"neither" only stands alone.
    if (chosen.length > 1) chosen = chosen.filter((v) => !["none", "neither", "not_sure"].includes(v));
    if (q.id === "devices" && has(n, "both")) chosen = ["smartphone", "computer_tablet"];
    if (chosen.length) return { kind: "answer", value: [...new Set(chosen)], phrase: matches.map((m) => m.phrase).join(", ") };
  } else if (matches.length) {
    const top = matches[0];
    const rivals = matches.filter((m) => m.value !== top.value && m.score === top.score);
    // A yes and a no for the same question, or two equally strong options: ask.
    if (rivals.length) return { kind: "ambiguous", options: [top.value, ...rivals.map((r) => r.value)], reason: "I heard more than one answer" };
    if (top.value === "not_sure" || top.value === "never_or_unknown") return { kind: "unknown", value: top.value, phrase: top.phrase };
    return { kind: "answer", value: top.value, phrase: top.phrase, detail: q.id === "county" ? placeDetail(top.phrase) : null };
  }

  if (g.unknown) return { kind: "unknown", value: notSure || null };
  if (g.skip && q.skippable) return { kind: "skipped" };
  return { kind: "unclear" };
}

// Free-form opening ("tell me what's going on"): pull out every answer that a
// distinctive alias clearly signals, across all questions. Generic words such as
// "yes", "no" or "never" are ignored here because they only mean something in
// reply to a specific question.
export function extractMany(text, assessment, ctx = {}) {
  const n = normalize(text);
  const found = [];
  for (const q of assessment.questions) {
    if (q.id === "age_band") {
      if (/\b(years? old|yrs old|aged|age is|turning)\b/.test(n) || /\b(i'm|i am|she's|he's|they're|she is|he is|they are) (\d{1,3}|[a-z]+ty)\b/.test(n) || /\b\d{1,2} year/.test(n)) {
        const b = ageBand(n);
        const num = findNumber(n);
        if (b) { found.push({ questionId: q.id, value: b, phrase: "age", detail: num !== null ? String(num) : null }); continue; }
      }
    }
    if (q.id === "county") {
      const c = countyFromGeography(n, ctx.geography || { tiers: [] });
      if (typeof c === "string") { found.push({ questionId: q.id, value: c, phrase: "county", detail: countyDetail(n, ctx.geography) }); continue; }
    }
    const matches = matchOptions(n, q, { distinctiveOnly: true });
    if (!matches.length) continue;
    if (q.type === "multi") {
      found.push({ questionId: q.id, value: [...new Set(matches.map((m) => m.value))], phrase: matches.map((m) => m.phrase).join(", ") });
    } else {
      const top = matches[0];
      if (matches.some((m) => m.value !== top.value && m.score === top.score)) continue; // ambiguous: ask later
      if (top.value === "not_sure" || top.value === "never_or_unknown") continue;
      found.push({ questionId: q.id, value: top.value, phrase: top.phrase, detail: q.id === "county" ? placeDetail(top.phrase) : null });
    }
  }
  return found;
}

// Which already-answered question is a correction about? Uses each
// question's topic_words (workflow data) and option matches.
const topicsOf = (assessment, qid) => ((assessment && assessment.questions.find((x) => x.id === qid)) || {}).topic_words || [];

// Which of these answers does the text talk about? "I do have an eye doctor"
// mentions eye_doctor, so it is a statement about an answer, not a bare yes.
export function mentionedTopics(text, askableIds, assessment) {
  const n = normalize(text);
  return askableIds.filter((qid) => topicsOf(assessment, qid).some((t) => has(n, t)));
}

export function findCorrectionTarget(text, assessment, askableIds, ctx = {}) {
  const n = normalize(text);
  const candidates = [];
  for (const qid of askableIds) {
    const q = assessment.questions.find((x) => x.id === qid);
    if (!q) continue;
    const topicHit = (q.topic_words || []).some((t) => has(n, t));
    let interp = interpretAnswer(text, q, ctx);
    const distinct = matchOptions(n, q, { distinctiveOnly: true }).length > 0;
    if (topicHit && (interp.kind === "answer" || interp.kind === "unknown" || interp.kind === "ambiguous")) candidates.push({ questionId: qid, interpretation: interp, strength: 3 });
    else if (distinct && interp.kind === "answer") candidates.push({ questionId: qid, interpretation: interp, strength: 2 });
    else if (topicHit) candidates.push({ questionId: qid, interpretation: { kind: "unclear" }, strength: 1 });
  }
  candidates.sort((a, b) => b.strength - a.strength);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].strength === candidates[1].strength && candidates[0].strength < 3) return { ambiguousTargets: candidates.map((c) => c.questionId) };
  return candidates[0];
}

export function looksLikeCorrection(text) {
  const n = normalize(text);
  return anyOf(n, ["change", "correct that", "correction", "actually", "i meant", "i mean", "go back", "that's wrong", "that is wrong", "not right", "update", "instead", "mistake", "misheard", "you got", "should be", "it's not", "it is not", "no wait", "wait"]);
}

// Spoken or typed email -> address. Keeps ONLY the address: "yeah my email
// is ben at agentic arc dot ai" -> "ben@agenticarc.ai". Spoken pieces ("at",
// "dot", "underscore", "dash") glue their neighbours together; spelled-out
// letters before the "at" are joined; a domain said as two words is joined up
// to its ".com"/".org" ending. The result is always read back for a yes.
export function parseEmail(text) {
  let t = " " + String(text || "").toLowerCase().replace(/[,;!?"]/g, " ").replace(/\.(\s|$)/g, " $1") + " ";
  t = t.replace(/ at sign /g, " @ ").replace(/ at /g, " @ ").replace(/ (dot|period|point) /g, " . ")
    .replace(/ underscore /g, " _ ").replace(/ (dash|hyphen) /g, " - ").replace(/@/g, " @ ").replace(/(\S)\.(\S)/g, "$1 . $2");
  const raw = t.split(/\s+/).filter(Boolean);
  const glue = new Set(["@", ".", "_", "-"]);
  const toks = [];
  let join = false;
  for (const w of raw) {
    if (glue.has(w)) { if (toks.length) toks[toks.length - 1] += w; else toks.push(w); join = true; continue; }
    if (join && toks.length) toks[toks.length - 1] += w; else toks.push(w);
    join = false;
  }
  let i = toks.findIndex((x) => x.includes("@"));
  if (i === -1) return null;
  let tok = toks[i];
  // spelled letters before the @: "b e n @ ..." -> "ben@..."
  let j = i - 1;
  while (j >= 0 && /^[a-z0-9]$/.test(toks[j])) { tok = toks[j] + tok; j--; }
  // domain said in pieces: join following tokens until it has a dot ending
  let k = i + 1;
  while (!/@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(tok) && k < toks.length && k <= i + 3 && /^[a-z0-9.-]+$/.test(toks[k])) { tok += toks[k]; k++; }
  tok = tok.replace(/^[^a-z0-9]+/, "").replace(/[.]+$/, "");
  const m = tok.match(/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/);
  return m ? m[0] : null;
}

// First name from "Ben", "my name's Ben", "it's ben dudley", "call me Benny".
const NAME_STOP = new Set(["yes", "yeah", "yep", "no", "nope", "okay", "ok", "sure", "hi", "hello", "hey", "um", "uh", "er", "well", "so", "oh", "just", "ask", "me", "questions", "its", "it's", "i'm", "im", "my", "name", "names", "is", "this", "call", "the", "a", "for", "i", "am", "you", "can", "skip", "not", "prefer", "rather", "say", "there", "thanks", "thank", "first", "and", "hiya", "sorry", "i'd", "id", "don't", "dont", "want", "to", "share", "pass", "no", "thanks"]);
export function parseName(text) {
  const t = String(text || "").replace(/[.!,?;:"()]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  let cand = null;
  const m = t.match(/(?:my name is|my name's|name is|name's|i'm|i am|it's|it is|this is|call me|you can call me)\s+([A-Za-z][A-Za-z'-]*)/i);
  if (m) cand = m[1];
  else {
    const words = t.split(" ").filter((w) => !NAME_STOP.has(w.toLowerCase()));
    if (words.length >= 1 && words.length <= 3) cand = words[0];
  }
  if (!cand || NAME_STOP.has(cand.toLowerCase()) || !/^[A-Za-z][A-Za-z'-]{0,30}$/.test(cand)) return null;
  return cand.charAt(0).toUpperCase() + cand.slice(1).toLowerCase();
}

// Spell an address for read-back so it can be checked by ear.
export function spellEmail(email) {
  const [user, domain] = email.split("@");
  const spell = (s) => s.split("").map((c) => (c === "." ? "dot" : c === "-" ? "dash" : c === "_" ? "underscore" : c)).join(" ");
  return `${spell(user)}, at, ${domain.split(".").join(" dot ")}`;
}

const NOT_PLACE = /county next|next door|nearby|elsewhere|another|other state|part of the state|not sure|dunno|don't know|unsure|eastern nc|^sc$|^meck$/;
function placeDetail(phrase) {
  if (!phrase || NOT_PLACE.test(phrase)) return null;
  if (phrase === "mecklenburg") return "Mecklenburg County";
  return titleCase(phrase.replace(/ county$/, " County"));
}
function countyDetail(n, geography) {
  for (const t of (geography && geography.tiers) || []) for (const c of t.counties || []) if (has(n, c)) return `${c} County`;
  return null;
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- typed answers
// Free-text answer types used by form-style workflows (for example the V360
// TECH interest form). The answer is what the person said, checked and tidied:
// "invalid" means it doesn't look like the right kind of answer, so the
// assistant says why and asks again. Skip, decline and "don't know" only count
// when that is ALL the person said, so "I'm not sure, maybe learn JAWS" is kept
// as an answer.
export const TYPED = new Set(["text", "long_text", "email", "phone", "address", "date", "consent"]);
const TYPED_FILLER = new Set(["i", "i'd", "id", "would", "we'd", "to", "answer", "rather", "i'll", "just", "please", "um", "uh", "well", "oh", "so", "okay", "ok", "that", "this", "one", "it", "can", "we", "let's", "lets", "thanks", "thank", "you", "really", "honestly", "yeah", "no", "the", "question", "for", "now", "on"]);
const DIGIT_WORDS = { zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

export function isTyped(q) {
  return !!q && TYPED.has(q.type);
}

function invalid(reason) {
  return { kind: "invalid", reason };
}

export function interpretTyped(text, q, ctx = {}) {
  const raw = String(text || "").trim();
  const n = normalize(raw);
  if (!raw) return invalid("I didn't hear anything.");
  const only = (list) => anyOf(n, list) && onlyPhrases(n, list, TYPED_FILLER);
  if (only(GLOBAL.skip)) return { kind: "skipped" };
  if (only(GLOBAL.declined)) return { kind: "declined" };
  if (only(GLOBAL.unknown)) return { kind: "unknown", value: null };
  switch (q.type) {
    case "consent": {
      const yn = yesNo(raw);
      if (yn === "yes") return { kind: "answer", value: "yes", detail: "Yes" };
      if (yn === "no") return { kind: "answer", value: "no", detail: "No" };
      return invalid("I need a yes or a no for this one.");
    }
    case "email": {
      const e = parseEmail(raw) || ctx.aiEmail || null;
      return e ? { kind: "answer", value: e, detail: e } : invalid("I didn't catch a full email address. You could say it like “sam at example dot com”, or type it.");
    }
    case "phone": {
      const p = parsePhone(raw);
      return p ? { kind: "answer", value: p, detail: p } : invalid("I need a 10-digit phone number, with the area code.");
    }
    case "date": {
      const d = parseDate(raw, ctx.today);
      return d ? { kind: "answer", value: d.iso, detail: d.display } : invalid("I didn't catch a full date. You could say something like “March 4th, 1950”, or type 3/4/1950.");
    }
    case "address": {
      const t = tidy(raw).replace(/^(?:it's|it is|my address is|the address is|address is|i live at|they live at|she lives at|he lives at)\s+/i, "");
      const words = t.split(/\s+/).filter(Boolean).length;
      const ok = (words >= 3 && /\d/.test(t)) || ((ctx.attempts || 0) >= 1 && words >= 2);
      if (t.length > 300) return invalid("That's longer than an address. Just the street, city and ZIP code, please.");
      return ok ? { kind: "answer", value: t, detail: t } : invalid("I need the street address with the house number, and the city and ZIP code if you can.");
    }
    case "long_text": {
      const t = tidy(raw);
      return t.length <= 1000 ? { kind: "answer", value: t, detail: t } : invalid("That's a bit long. Could you say it more briefly?");
    }
    default: {
      // text: names and short answers.
      const t = tidy(raw).replace(/^(?:my name is|my name's|her name is|his name is|their name is|the name is|name is|it's|it is|this is)\s+/i, "");
      if (!t) return invalid("I didn't catch that.");
      return t.length <= 200 ? { kind: "answer", value: t, detail: t } : invalid("That's a bit long for this one. Just the short answer, please.");
    }
  }
}

function tidy(s) {
  return String(s).replace(/\s+/g, " ").replace(/^[\s,.;:]+|[\s,;:]+$/g, "").trim();
}

// "704 555 1212", "(704) 555-1212", "seven oh four, five five five, one two one two",
// "double five" -> 704-555-1212. US numbers only.
export function parsePhone(text) {
  const words = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  let digits = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d+$/.test(w)) { digits += w; continue; }
    if ((w === "double" || w === "triple") && i + 1 < words.length) {
      const nx = words[i + 1];
      const d = /^\d$/.test(nx) ? nx : DIGIT_WORDS[nx];
      if (d) { digits += d.repeat(w === "double" ? 2 : 3); i++; continue; }
    }
    if (DIGIT_WORDS[w] && !(["to", "too", "for", "o"].includes(w) && !digits)) digits += DIGIT_WORDS[w];
  }
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return digits.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
}

export function spellPhone(p) {
  return String(p).split("-").map((g) => g.split("").join(" ")).join(", ");
}

const ORDINAL_DAYS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const MONTH_SHORT = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

// Spoken years: "nineteen fifty two" -> 1952, "two thousand five" -> 2005.
function spokenYear(words) {
  const t = words.join(" ");
  for (const m of t.matchAll(/\b(nineteen|twenty) (oh )?([a-z]+)(?: ([a-z]+))?/g)) {
    const hi = m[1] === "nineteen" ? 1900 : 2000;
    let lo = NUMBER_WORDS[m[3]];
    if (lo === undefined || lo === 100) continue;
    if (m[4] && NUMBER_WORDS[m[4]] !== undefined && lo >= 20 && NUMBER_WORDS[m[4]] < 10) lo += NUMBER_WORDS[m[4]];
    if (m[1] === "twenty" && lo >= 30) continue;
    return hi + lo;
  }
  const m = t.match(/\btwo thousand(?: and)?(?: ([a-z]+))?(?: ([a-z]+))?\b/);
  if (m) {
    let lo = m[1] ? NUMBER_WORDS[m[1]] || 0 : 0;
    if (m[2] && NUMBER_WORDS[m[2]] !== undefined && lo >= 20) lo += NUMBER_WORDS[m[2]];
    return 2000 + lo;
  }
  return null;
}

function spokenDay(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const d = w.match(/^(\d{1,2})(st|nd|rd|th)?$/);
    if (d && Number(d[1]) >= 1 && Number(d[1]) <= 31 && !(words[i + 1] && /^\d{4}$/.test(words[i]))) return Number(d[1]);
    if (ORDINAL_DAYS[w]) {
      if ((w === "twentieth" || w === "thirtieth")) return ORDINAL_DAYS[w];
      return ORDINAL_DAYS[w];
    }
    if ((w === "twenty" || w === "thirty") && ORDINAL_DAYS[words[i + 1]] && ORDINAL_DAYS[words[i + 1]] < 10) return (w === "twenty" ? 20 : 30) + ORDINAL_DAYS[words[i + 1]];
  }
  return null;
}

export function parseDate(text, today = new Date()) {
  const s = String(text || "").toLowerCase().trim();
  let y = null, mo = null, d = null;
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
  if (y === null && (m = s.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})\b/))) {
    mo = +m[1] - 1; d = +m[2]; y = +m[3];
    if (m[3].length === 2) y += y > today.getFullYear() % 100 ? 1900 : 2000;
  }
  if (y === null) {
    const words = s.replace(/[^a-z0-9]+/g, " ").trim().split(" ");
    for (const w of words) {
      const full = MONTHS.indexOf(w);
      if (full !== -1) { mo = full; break; }
      if (MONTH_SHORT[w] !== undefined && w !== "may") { mo = MONTH_SHORT[w]; break; }
      if (w === "may") { mo = 4; break; }
    }
    if (mo === null) return null;
    const four = words.find((w) => /^\d{4}$/.test(w));
    y = four ? +four : spokenYear(words);
    d = spokenDay(words.filter((w) => !/^\d{4}$/.test(w)));
  }
  if (y === null || mo === null || d === null) return null;
  const dt = new Date(Date.UTC(y, mo, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > today.getTime() + 5 * 365.25 * 864e5) return null;
  const iso = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const display = `${MONTHS[mo][0].toUpperCase()}${MONTHS[mo].slice(1)} ${d}, ${y}`;
  return { iso, display };
}

// Display text for a typed answer (detail is stored with the answer).
export function formatTyped(q, value, detail) {
  if (detail) return detail;
  if (q && q.type === "date") { const d = parseDate(String(value)); return d ? d.display : String(value); }
  if (q && q.type === "consent") return value === "yes" ? "Yes" : value === "no" ? "No" : String(value);
  return value == null ? "" : String(value);
}
