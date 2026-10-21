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
  unknown: ["don't know", "do not know", "not sure", "no idea", "dunno", "unsure", "can't say", "cannot say", "i'm not certain"],
  staff: ["talk to a person", "speak to a person", "talk to someone real", "real person", "a human", "talk to staff", "speak to staff", "staff member", "someone call me", "call me back", "speak to someone at lions", "talk to a navigator", "need a person"],
  startOver: ["start over", "start again", "begin again", "restart"],
  end: ["end the session", "end session", "goodbye", "good bye", "i'm done", "that's all", "hang up", "end the conversation"],
  email: ["email", "e mail", "send it to me", "send me", "mail me", "send the plan"],
  noEmail: ["no email", "don't have email", "do not have email", "don't have an email", "no e mail", "without email"],
  results: ["show results", "see results", "my suggestions", "what do you suggest", "recommendations", "show me the list"],
};

export function detectGlobal(text) {
  const n = normalize(text);
  const hits = {};
  for (const [k, list] of Object.entries(GLOBAL)) if (anyOf(n, list)) hits[k] = true;
  // "skip this section" is more specific than "skip".
  if (hits.skipSection) delete hits.skip;
  if (hits.noEmail) delete hits.email;
  return hits;
}

// ---------------------------------------------------------------- yes / no
const YES = ["yes", "yeah", "yep", "yup", "yes please", "correct", "that's right", "that is right", "right", "sure", "affirmative", "i do", "i have", "they do", "she does", "he does", "they have", "he did", "she did", "they did", "uh huh", "of course", "definitely", "absolutely", "ok", "okay", "please do", "go ahead", "do it", "sounds good", "looks good", "that's correct", "that is correct", "confirm", "confirmed", "all correct", "all good", "spot on", "exactly"];
const NO = ["no", "nope", "nah", "not really", "never", "i don't", "i do not", "they don't", "he doesn't", "she doesn't", "not at all", "negative", "don't", "do not", "wrong", "that's wrong", "not right", "incorrect", "cancel", "no thanks", "no thank you"];

export function yesNo(text) {
  const n = normalize(text);
  const y = anyOf(n, YES);
  // "not sure" contains "not" but is not a no.
  const stripped = n.replace(/ not sure /g, " ").replace(/ don't know /g, " ").replace(/ do not know /g, " ");
  const no = anyOf(stripped, NO);
  if (y && !no) return "yes";
  if (no && !y) return "no";
  if (y && no) return "mixed";
  return null;
}

// Strict confirmation used for the final recap and action authorisation:
// a short, clear yes with no correction attached. "Yes but change the county"
// is not a confirmation.
export function strictConfirm(text) {
  const n = normalize(text);
  const words = n.trim().split(" ").filter(Boolean);
  const yn = yesNo(text);
  if (yn !== "yes") return false;
  const correctionWords = ["but", "except", "change", "actually", "wrong", "not", "instead", "although", "however", "wait"];
  if (words.some((w) => correctionWords.includes(w))) return false;
  return words.length <= 12;
}

// ---------------------------------------------------------------- options
// Extra everyday words for EXISTING options. These only widen how an answer is
// recognised; they add no options, weights or rules (those live in
// assessment.json and are unchanged). Every result is still read back and
// confirmed by the person.
const EXTRA_ALIASES = {
  actor: {
    family_friend: ["my dad", "my mom", "my mum", "my grandmother", "my grandfather", "my grandma", "my grandpa", "my brother", "my sister", "my aunt", "my uncle", "my partner", "my spouse", "my child", "my kid", "my friend", "for him", "for her", "family member"],
    professional: ["my client", "a client", "my patient", "a patient", "i'm a case manager", "i'm a social worker", "referring someone"],
    self: ["for myself", "it's for me", "i am blind", "i'm blind", "my eyes", "my vision", "my sight", "i have low vision", "i'm losing my sight"],
  },
  goals: {
    travel: ["get around", "getting around", "white cane", "guide dog", "bus on my own"],
    reading: ["listen to books", "read again", "reading mail", "read my mail"],
    technology: ["magnifying", "magnification", "on my phone", "use my phone", "use a computer", "iphone", "smart phone", "voiceover", "zoomtext", "jaws"],
    work: ["my job", "keep working", "find work", "get a job"],
    home: ["cook", "cooking safely", "around the home", "live on my own", "live independently"],
    meeting_people: ["meet people", "others like me", "support groups"],
  },
};

function optionPhrases(opt, q) {
  const list = [];
  for (const a of ((EXTRA_ALIASES[q.id] || {})[opt.value] || [])) list.push(a);
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
  const n = normalize(text);
  const g = detectGlobal(text);
  const today = ctx.today || new Date();
  const values = (q.options || []).map((o) => o.value);
  const notSure = values.find((v) => v === "not_sure" || v === "never_or_unknown");

  if (g.declined && (q.sensitive || q.skippable)) return { kind: "declined" };

  // Question-specific parsers first.
  if (q.id === "age_band") {
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

// Which already-answered question is a correction about? Uses topic words and
// option matches. Returns {questionId, interpretation} or null.
const TOPICS = {
  actor: ["for myself", "for someone else", "who it's for", "who this is for"],
  county: ["county", "live in", "lives in", "living in", "where i live", "where they live", "location", "area"],
  goals: ["goal", "goals", "difference", "want help with", "what matters"],
  age_band: ["age", "years old", "how old", "old"],
  hearing_loss: ["hearing", "deaf"],
  eye_doctor: ["eye doctor", "ophthalmologist", "optometrist"],
  eye_exam_recency: ["eye exam", "last exam", "exam was", "exam date"],
  insurance: ["insurance", "medicaid", "medicare", "health cover", "coverage"],
  veteran: ["veteran", "military", "served", "army", "navy", "marines", "air force"],
  va_enrolled: ["va health", "enrolled", "signed up for va"],
  discharge: ["discharge"],
  housing_stable: ["housing", "home is", "rent"],
  food_worry: ["food"],
  utilities: ["utility", "utilities", "power bill", "electric"],
  transport_barrier: ["transport", "transportation", "rides", "drive", "driving"],
  legal_matter: ["legal", "lawyer"],
  loneliness: ["lonely", "loneliness", "isolated"],
  broadband: ["internet", "wifi", "broadband"],
  devices: ["smartphone", "computer", "tablet", "devices", "iphone", "android"],
};

export function findCorrectionTarget(text, assessment, askableIds, ctx = {}) {
  const n = normalize(text);
  const candidates = [];
  for (const qid of askableIds) {
    const q = assessment.questions.find((x) => x.id === qid);
    if (!q) continue;
    const topicHit = (TOPICS[qid] || []).some((t) => has(n, t));
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
