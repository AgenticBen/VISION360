// Screen Settings Check: the scoring rules. Pure functions, no storage or
// network, so every rule is unit-tested (tests/screen-check-engine.test.mjs).
//
// Each test is replayed from its list of trials, so the server never keeps a
// hidden state: given the same trials it always reaches the same result.
//
//   next(setting, trials, ctx)   -> { done, prompt, result? }
//       prompt: what to show next (a word at a size, a pair of colors, ...)
//       result: { measured_limit, recommended_value, unit, tries, flags, apply }
//
// The tests:
//   speech_rate    starts at the slowest speed; "faster" / "slower" / "keep"
//   magnification  a staircase: two right in a row at a size moves to the
//                  next smaller size; two wrong at a size ends the test;
//                  "I can't tell" counts as wrong. Recommended text size is
//                  about twice the smallest size read correctly. The person
//                  reads a short phrase aloud ("find my glasses") when the
//                  wording file has phrases, otherwise a single word.
//   pictures       the same staircase with four simple pictures (house,
//                  apple, circle, square), the symbol set eye clinics use
//                  for people who can't read letters. Changes nothing on the
//                  page; tells staff how big icons and pictures need to be.
//   contrast       left-or-right pairs that narrow to one color scheme
//   cursor         computers only: the pointer starts very large and shrinks
//                  while it's found; the last size found is kept; then a
//                  color pair
//   bold           one left-or-right pair: regular or bold text
export const SETTINGS = ["speech_rate", "magnification", "pictures", "contrast", "cursor", "bold"];

export const RATES = ["0.7", "0.85", "1", "1.2", "1.4"];
// Phrase sizes shown, in CSS pixels, smallest first: the test starts small
// and grows (about 1.25x a step) until the person reads two in a row.
export const LADDER_UP = [12, 15, 18, 22, 28, 34, 42, 52, 64, 80, 100, 128, 160, 200];
// Picture sizes shown, smallest first.
export const PICTURE_LADDER_UP = [14, 18, 22, 28, 36, 44, 56, 72, 96, 120, 160, 200];
// The first version shrank from large to small. Checks started before the
// change (their first trial was at the old largest size) keep that order.
export const LADDER = [72, 60, 48, 40, 34, 28, 24, 20, 18, 16, 14, 12];
export const PICTURE_LADDER = [120, 96, 72, 56, 44, 36, 28, 22, 18, 14];
export const PICTURES = ["house", "apple", "circle", "square"];
// Other words people use for each picture.
export const PICTURE_WORDS = {
  house: ["house", "home", "houses", "building", "barn", "hut"],
  apple: ["apple", "apples", "fruit", "cherry", "tomato", "peach"],
  circle: ["circle", "ball", "round", "ring", "dot", "o", "oval", "zero", "sun"],
  square: ["square", "box", "block", "rectangle", "squares", "cube"],
};
// The page's text at 100% is 18px; the display settings offer these sizes.
export const BASE_PX = 18;
export const TEXT_SIZES = [100, 125, 150, 200, 300, 400];
export const THEMES = ["high", "dark", "standard"];
// Pointer sizes, smallest first: the system pointer, then 64, 96 and 128px
// (128px is the largest custom pointer browsers allow).
export const CURSOR_SIZES = ["default", "large", "xl", "xxl"];
export const CURSOR_COLORS = ["black", "white", "yellow", "pink"];
const CURSOR_PX = { default: null, large: 64, xl: 96, xxl: 128 };
export const MAX_TRIALS = 40;

function norm(t) {
  return String(t || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

// A spoken or typed answer to "what word do you see?".
export function wordMatches(answer, target, soundsLike = {}) {
  const a = norm(answer);
  const t = norm(target);
  if (!a || !t) return false;
  const words = a.split(" ");
  const ok = new Set([t, ...(soundsLike[t] || []).map(norm)]);
  return words.some((w) => ok.has(w)) || ok.has(a);
}

// Small words that don't count when checking a phrase that was read aloud.
const STOP = new Set(["a", "an", "the", "my", "to", "of", "on", "in", "at", "for", "and", "is", "it", "you", "me", "some", "your", "our", "with"]);
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Two words that are close enough for speech recognition: the same, a plural,
// or (for words of 4+ letters) one letter off ("bill" heard as "bell").
function close(heard, want) {
  if (heard === want) return true;
  if (heard.replace(/(es|s)$/, "") === want.replace(/(es|s)$/, "")) return true;
  return heard.length >= 4 && want.length >= 4 && editDistance(heard, want) <= 1;
}
// Numbers can be said as words: "three thirty" is 3:30, "twenty five" is 25,
// "two fourteen" is 214. These turn every number in a phrase into its digits,
// so "meet at 3:30" and "meet at three thirty" have the same digits ("330").
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Words around numbers that don't need saying: "$12" is "twelve dollars", "3:30" may be "three thirty p m".
const NUMBER_FILLER = new Set(["dollar", "dollars", "cent", "cents", "oclock", "o", "clock", "am", "pm", "a", "p", "m", "and", "number"]);
export function numberDigits(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur != null) { out.push(String(cur)); cur = null; } };
  for (const w of norm(text).replace(/'/g, "").split(" ")) {
    if (/^\d+$/.test(w)) { flush(); out.push(w); continue; }
    if (w in TENS) { flush(); cur = TENS[w]; continue; }
    if (w in UNITS) {
      if (cur != null && cur % 10 === 0 && cur >= 20 && UNITS[w] < 10) { cur += UNITS[w]; flush(); continue; }
      flush(); cur = UNITS[w]; continue;
    }
    if (w === "hundred" && (cur != null || out.length)) { const base = cur != null ? cur : Number(out.pop()); cur = base * 100; continue; }
    if (cur != null && cur >= 100 && cur % 100 === 0 && (w in UNITS || w in TENS)) continue;
    flush();
  }
  flush();
  // "two hundred fourteen": join a hundreds value with what follows it.
  const joined = [];
  for (const d of out) {
    const prev = joined[joined.length - 1];
    if (prev && /00$/.test(prev) && Number(prev) >= 100 && Number(d) < 100) joined[joined.length - 1] = String(Number(prev) + Number(d));
    else joined.push(d);
  }
  return joined.join("");
}
// Short forms people read either way.
const ALIASES = { dr: "doctor", st: "street", rd: "road", ave: "avenue", mr: "mister", mrs: "missus" };
const alias = (w) => ALIASES[w] || w;
const isNumberWord = (w) => /^\d+$/.test(w) || w in UNITS || w in TENS || w === "hundred";

// A spoken or typed answer to "read this out loud". A single word is checked
// with wordMatches; a phrase needs its main words (not "the", "my", ...):
// all of them for two, all but one for three or more, in any order. Any
// numbers in the phrase must all be there, said as digits or as words.
export function phraseMatches(answer, target, soundsLike = {}) {
  const t = norm(target).replace(/'/g, "").split(" ").filter(Boolean).map(alias);
  const wantDigits = numberDigits(target);
  if (wantDigits && numberDigits(answer) !== wantDigits) return false;
  if (t.length <= 1 && !wantDigits) return wordMatches(answer, target, soundsLike);
  const heard = norm(answer).replace(/'/g, "").split(" ").filter(Boolean).map(alias).filter((w) => !NUMBER_FILLER.has(w) || !wantDigits);
  if (!heard.length) return false;
  const words = t.filter((w) => !isNumberWord(w) && !(wantDigits && NUMBER_FILLER.has(w)));
  if (!words.length) return true; // only numbers, and they matched
  const content = words.filter((w) => !STOP.has(w));
  const need = content.length ? content : words;
  const hit = need.filter((w) => heard.some((h) => close(h, w) || (soundsLike[w] || []).map(norm).includes(h))).length;
  return hit >= need.length - (need.length >= 3 ? 1 : 0);
}
// A spoken or typed answer to "what picture do you see?".
export function pictureMatches(answer, target) {
  const ok = PICTURE_WORDS[target] || [target];
  const words = norm(answer).split(" ");
  // Saying two different pictures ("a house or a circle") is a guess, not an answer.
  const named = PICTURES.filter((p) => words.some((w) => (PICTURE_WORDS[p] || []).includes(w)));
  return named.length === 1 && named[0] === target && words.some((w) => ok.includes(w));
}

// Which word to show for the nth trial: a fixed shuffle seeded by the check
// id, so a person doesn't see the same word twice in a row and nobody can
// predict the next one from the page.
export function wordFor(seed, n, words) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const order = words.map((w, i) => ({ w, k: Math.imul((h ^ (i + 1) * 2654435761) >>> 0, 2246822519) >>> 0 })).sort((a, b) => a.k - b.k).map((x) => x.w);
  return order[n % order.length];
}

// The phrases to read, taking turns between kinds (everyday, numbers,
// labels, places) so each person sees a mix. Each kind is shuffled by the
// check id. Phrases may be plain strings (older wording files) or
// { text, kind }.
export function phraseList(ctx) {
  const raw = ctx.phrases && ctx.phrases.length ? ctx.phrases : ctx.words;
  const items = raw.map((p) => (typeof p === "string" ? { text: p, kind: "any" } : { text: String(p.text || ""), kind: String(p.kind || "any") })).filter((p) => p.text);
  const kinds = [...new Set(items.map((p) => p.kind))];
  const groups = kinds.map((k) => { const list = items.filter((p) => p.kind === k).map((p) => p.text); return list.map((_, i) => wordFor(ctx.seed + "/" + k, i, list)); });
  const order = kinds.map((_, i) => i).map((i) => groups[wordFor(ctx.seed + "/kinds", i, kinds.map((_, j) => j))]);
  const out = [];
  for (let i = 0; out.length < items.length; i++) for (const g of order) if (i < g.length) out.push(g[i]);
  return out;
}

// Shared struggle signals: lots of repeats or "can't tell", or a slow step.
function struggleFlags(trials) {
  const flags = [];
  const repeats = trials.reduce((n, t) => n + (Number(t.repeats) || 0), 0);
  const cant = trials.filter((t) => t.cant_tell).length;
  const ms = trials.reduce((n, t) => n + (Number(t.ms) || 0), 0);
  if (repeats >= 3) flags.push("asked_to_repeat_often");
  if (cant >= 3) flags.push("many_cant_tell");
  if (ms > 3 * 60 * 1000) flags.push("slow_step");
  return flags;
}
const totalMs = (trials) => trials.reduce((n, t) => n + (Number(t.ms) || 0), 0);

// ---------------------------------------------------------------- speech rate
function speechRate(trials) {
  let i = 0;
  for (const t of trials) {
    if (t.answer === "keep") {
      return { done: true, result: { measured_limit: RATES[i], recommended_value: RATES[i], unit: "rate", tries: trials.length, flags: struggleFlags(trials), apply: { rate: RATES[i] } } };
    }
    if (t.answer === "faster") i = Math.min(RATES.length - 1, i + 1);
    if (t.answer === "slower") i = Math.max(0, i - 1);
  }
  if (trials.length >= MAX_TRIALS) return speechRate([...trials.slice(0, MAX_TRIALS - 1), { answer: "keep" }]);
  return { done: false, prompt: { kind: "rate", rate: RATES[i], atFastest: i === RATES.length - 1, atSlowest: i === 0 } };
}

// -------------------------------------------------------------- magnification
// The text size setting closest to (at or above) a size in pixels.
export function textSizeFor(px) {
  for (const s of TEXT_SIZES) if ((BASE_PX * s) / 100 >= px - 0.5) return { textSize: String(s), extraZoom: 1 };
  const biggest = (BASE_PX * TEXT_SIZES[TEXT_SIZES.length - 1]) / 100;
  return { textSize: String(TEXT_SIZES[TEXT_SIZES.length - 1]), extraZoom: Math.round((px / biggest) * 10) / 10 };
}

// A growing size test: start at the smallest size; a miss (or "I can't
// tell") moves up one size; two right in a row at a size is the smallest size
// the person can read, and the test ends. Missing the largest ends it too.
function growing(trials, ladder, isRight) {
  let level = 0, rightRun = 0;
  for (const t of trials) {
    if (isRight(t)) {
      rightRun++;
      if (rightRun >= 2) return { done: true, smallestOk: ladder[level] };
    } else {
      rightRun = 0;
      if (level === ladder.length - 1) return { done: true, smallestOk: null };
      level++;
    }
  }
  return { done: false, level };
}
// The first version: start large, shrink after two right, stop after two wrong.
function shrinking(trials, ladder, isRight) {
  let level = 0, rightRun = 0, wrongHere = 0, smallestOk = null;
  for (const t of trials) {
    if (isRight(t)) {
      rightRun++;
      if (rightRun >= 2) {
        smallestOk = ladder[level];
        if (level === ladder.length - 1) return { done: true, smallestOk };
        level++; rightRun = 0; wrongHere = 0;
      }
    } else {
      rightRun = 0; wrongHere++;
      if (wrongHere >= 2) return { done: true, smallestOk };
    }
  }
  return { done: false, level };
}
const startedShrinking = (trials, oldTop) => trials.length > 0 && Number(trials[0].px) === oldTop;

function magnification(trials, ctx) {
  const old = startedShrinking(trials, LADDER[0]);
  const ladder = old ? LADDER : LADDER_UP;
  const biggest = old ? LADDER[0] : LADDER_UP[LADDER_UP.length - 1];
  const isRight = (t) => !t.cant_tell && phraseMatches(t.answer, t.word, ctx.soundsLike);
  const r = (old ? shrinking : growing)(trials, ladder, isRight);
  const end = (smallestOk, reason) => {
    const flags = struggleFlags(trials);
    if (smallestOk == null) flags.push("could_not_read_largest");
    const comfortPx = smallestOk == null ? biggest * 2 : smallestOk * 2;
    const ts = textSizeFor(comfortPx);
    if (ts.extraZoom > 1) flags.push("needs_magnifier_or_zoom");
    if (reason === "max") flags.push("stopped_at_trial_limit");
    return {
      done: true,
      result: {
        measured_limit: smallestOk == null ? null : String(smallestOk),
        recommended_value: ts.textSize,
        unit: "percent",
        tries: trials.length,
        flags,
        comfort_px: comfortPx,
        extra_zoom: ts.extraZoom,
        largest_px: biggest,
        apply: { textSize: ts.textSize },
      },
    };
  };
  if (r.done) return end(r.smallestOk);
  if (trials.length >= MAX_TRIALS) return end(null, "max");
  const list = phraseList(ctx);
  return { done: false, prompt: { kind: "word", px: ladder[r.level], word: list[trials.length % list.length], n: trials.length + 1 } };
}

// ------------------------------------------------------------------- pictures
function pictures(trials, ctx) {
  const old = startedShrinking(trials, PICTURE_LADDER[0]);
  const ladder = old ? PICTURE_LADDER : PICTURE_LADDER_UP;
  const biggest = old ? PICTURE_LADDER[0] : PICTURE_LADDER_UP[PICTURE_LADDER_UP.length - 1];
  const r = (old ? shrinking : growing)(trials, ladder, (t) => !t.cant_tell && pictureMatches(t.answer, t.picture));
  const end = (smallestOk, reason) => {
    const flags = struggleFlags(trials);
    if (smallestOk == null) flags.push("could_not_see_largest_picture");
    if (reason === "max") flags.push("stopped_at_trial_limit");
    const comfortPx = smallestOk == null ? biggest * 2 : smallestOk * 2;
    return { done: true, result: { measured_limit: smallestOk == null ? null : String(smallestOk), recommended_value: String(comfortPx), unit: "px", tries: trials.length, flags, comfort_px: comfortPx, largest_px: biggest, apply: {} } };
  };
  if (r.done) return end(r.smallestOk);
  if (trials.length >= MAX_TRIALS) return end(null, "max");
  return { done: false, prompt: { kind: "picture", px: ladder[r.level], picture: wordFor(ctx.seed + "/pictures", trials.length, PICTURES), choices: PICTURES, n: trials.length + 1 } };
}

// ---------------------------------------------------------- left-or-right pairs
// A small tournament: the first two compete, the winner meets the next one.
// "same" keeps the one already shown on the left.
function tournament(options, trials, key) {
  let champ = options[0];
  let next = 1;
  for (const t of trials) {
    if (next >= options.length) break;
    const right = options[next];
    if (t.answer === "right") champ = right;
    next++;
  }
  if (next >= options.length) return { done: true, winner: champ };
  return { done: false, prompt: { kind: key, left: champ, right: options[next], round: next } };
}

function contrast(trials) {
  const r = tournament(THEMES, trials, "pair_theme");
  if (!r.done) return r;
  return { done: true, result: { measured_limit: null, recommended_value: r.winner, unit: "theme", tries: trials.length, flags: struggleFlags(trials), apply: { theme: r.winner } } };
}

function bold(trials) {
  const r = tournament(["regular", "bold"], trials, "pair_bold");
  if (!r.done) return r;
  return { done: true, result: { measured_limit: null, recommended_value: r.winner, unit: "weight", tries: trials.length, flags: struggleFlags(trials), apply: { bold: r.winner === "bold" ? "on" : "off" } } };
}

// ---------------------------------------------------------------- cursor
// Four pointers on screen at once. Round 1: four sizes (moving the mouse over
// a tile changes the real pointer to that size); round 2: the chosen size in
// four colors. "none" in round 1 means they couldn't see any of them.
function cursor(trials, ctx) {
  if (ctx.device && (ctx.device.touchOnly || ctx.device.skipPointer)) {
    return { done: true, result: { measured_limit: null, recommended_value: "not_tested", unit: "pointer", tries: 0, flags: ["no_pointer_on_this_device"], apply: {} } };
  }
  // Checks started before this version: find the pointer, then left or right.
  if (trials.some((t) => t.answer === "found" || t.answer === "lost" || (t.kind === "color" && ["left", "right", "same"].includes(t.answer)))) return cursorFirstVersion(trials);
  const size = trials.find((t) => t.kind === "size");
  const color = trials.find((t) => t.kind === "color");
  const flags = struggleFlags(trials);
  const done = (value, limit, apply) => ({ done: true, result: { measured_limit: limit, recommended_value: value, unit: "pointer", tries: trials.length, flags, apply } });
  if (!size) return { done: false, prompt: { kind: "pick_cursor_size", choices: CURSOR_SIZES } };
  if (size.answer === "none") { flags.push("could_not_find_largest_pointer"); return done("not_found", null, {}); }
  // The system pointer can't be recolored, so choosing it ends the test.
  if (size.answer === "default") return done("default", "default", { cursor: "default" });
  if (!color) return { done: false, prompt: { kind: "pick_cursor_color", size: size.answer, choices: CURSOR_COLORS } };
  return done(size.answer + "/" + color.answer, size.answer, { cursor: size.answer, cursorColor: color.answer });
}
// The first version (kept so checks already under way still add up): its
// largest pointer "xl" was 128px, which is now "xxl".
function cursorFirstVersion(trials) {
  const OLD_SIZES = ["xl", "large", "default"];
  const OLD_COLORS = ["black", "white", "yellow"];
  const sizeTrials = trials.filter((t) => t.kind !== "color");
  const colorTrials = trials.filter((t) => t.kind === "color");
  let i = 0, kept = null, sizeDone = false;
  for (const t of sizeTrials) {
    if (t.answer === "found") { kept = OLD_SIZES[i]; if (i === OLD_SIZES.length - 1) { sizeDone = true; break; } i++; }
    else { sizeDone = true; break; }
  }
  if (!sizeDone && sizeTrials.length >= MAX_TRIALS) sizeDone = true;
  if (!sizeDone) return { done: false, prompt: { kind: "find_pointer", size: OLD_SIZES[i] } };
  const flags = struggleFlags(trials);
  if (kept == null) {
    flags.push("could_not_find_largest_pointer");
    return { done: true, result: { measured_limit: null, recommended_value: "not_found", unit: "pointer", tries: trials.length, flags, apply: {} } };
  }
  const now = kept === "xl" ? "xxl" : kept;
  const c = tournament(OLD_COLORS, colorTrials, "pair_cursor");
  if (!c.done) return { done: false, prompt: { ...c.prompt, size: kept } };
  return { done: true, result: { measured_limit: now, recommended_value: now + "/" + c.winner, unit: "pointer", tries: trials.length, flags, apply: { cursor: now, cursorColor: c.winner } } };
}

// One step of a test: what to show next, or the result.
export function next(setting, trials = [], ctx = {}) {
  const t = Array.isArray(trials) ? trials : [];
  const c = { words: ctx.words || ["apple"], phrases: ctx.phrases || null, soundsLike: ctx.soundsLike || {}, seed: ctx.seed || "", device: ctx.device || {} };
  let out;
  if (setting === "speech_rate") out = speechRate(t);
  else if (setting === "magnification") out = magnification(t, c);
  else if (setting === "pictures") out = pictures(t, c);
  else if (setting === "contrast") out = contrast(t);
  else if (setting === "cursor") out = cursor(t, c);
  else if (setting === "bold") out = bold(t);
  else throw new Error("Unknown setting: " + setting);
  if (out.done) out.result.duration_ms = totalMs(t);
  return out;
}

// What a trial may contain once it reaches the server (anything else is dropped).
export function cleanTrial(setting, raw, prompt) {
  const r = raw || {};
  const ms = Math.round(Math.max(0, Math.min(10 * 60 * 1000, Number(r.ms) || 0)));
  const repeats = Math.round(Math.max(0, Math.min(50, Number(r.repeats) || 0)));
  const base = { ms, repeats, at: new Date().toISOString() };
  if (setting === "speech_rate") return { ...base, answer: ["faster", "slower", "keep"].includes(r.answer) ? r.answer : "keep", rate: prompt.rate };
  if (setting === "magnification") return { ...base, word: prompt.word, px: prompt.px, answer: String(r.answer || "").slice(0, 120), cant_tell: !!r.cant_tell };
  if (setting === "pictures") return { ...base, picture: prompt.picture, px: prompt.px, answer: String(r.answer || "").slice(0, 60), cant_tell: !!r.cant_tell };
  if (setting === "contrast" || setting === "bold") return { ...base, left: prompt.left, right: prompt.right, answer: ["left", "right", "same"].includes(r.answer) ? r.answer : "same" };
  if (setting === "cursor") {
    if (prompt.kind === "pick_cursor_size") return { ...base, kind: "size", answer: [...CURSOR_SIZES, "none"].includes(r.answer) ? r.answer : "none" };
    if (prompt.kind === "pick_cursor_color") return { ...base, kind: "color", size: prompt.size, answer: CURSOR_COLORS.includes(r.answer) ? r.answer : "black" };
    if (prompt.kind === "pair_cursor") return { ...base, kind: "color", left: prompt.left, right: prompt.right, answer: ["left", "right", "same"].includes(r.answer) ? r.answer : "same" };
    return { ...base, kind: "size", size: prompt.size, answer: r.answer === "found" ? "found" : "lost" };
  }
  throw new Error("Unknown setting: " + setting);
}

// Plain words for a setting's result (staff view, case note, results page).
export function describe(setting, result) {
  if (!result) return "Not tested";
  const v = result.recommended_value;
  if (v === "skipped") return `${PRETTY[setting] || setting}: skipped`;
  if (v == null) return `${PRETTY[setting] || setting}: started, not finished`;
  if (setting === "speech_rate") return `Speech rate ${v}x (started at the slowest, ${RATES[0]}x)`;
  if (setting === "magnification") {
    const comfort = result.comfort_px || (result.measured_limit ? Number(result.measured_limit) * 2 : LADDER_UP[LADDER_UP.length - 1] * 2);
    const extra = result.extra_zoom || textSizeFor(comfort).extraZoom;
    const lim = result.measured_limit ? `smallest text read correctly: ${result.measured_limit}px` : `could not read the largest text (${result.largest_px || LADDER_UP[LADDER_UP.length - 1]}px)`;
    return `Text size ${v}% (${lim}; comfortable size about ${comfort}px${extra > 1 ? `, needs about ${extra}x extra zoom or a magnifier` : ""})`;
  }
  if (setting === "pictures") return result.measured_limit ? `Pictures: smallest picture recognized ${result.measured_limit}px; icons and pictures about ${v}px should be comfortable` : `Pictures: could not recognize the largest picture (${result.largest_px || PICTURE_LADDER_UP[PICTURE_LADDER_UP.length - 1]}px)`;
  if (setting === "contrast") return `Colors: ${{ high: "high contrast (yellow and white on black)", dark: "light text on dark", standard: "dark text on white" }[v] || v}`;
  if (setting === "cursor" && v === "not_found") return "Pointer: couldn't see any of the pointers, up to 128px; no change made";
  if (setting === "cursor") {
    if (v === "not_tested") return "Pointer: not tested (no pointer on this device, or uses the keyboard)";
    const [size, color] = String(v).split("/");
    const SIZE_WORDS = { default: "normal size", large: "large (64px)", xl: "extra large (96px)", xxl: "huge (128px)" };
    return `Pointer: ${SIZE_WORDS[size] || size}${color ? ", " + color : ""}`;
  }
  if (setting === "bold") return `Text weight: ${v}`;
  return String(v);
}

// A short, speakable code a person can use to retake the check: a word, a
// number and a word ("maple 472 river"), about 800,000 of them; the server
// also makes sure a new code isn't already in use. Not secret: it only links
// a retake, and staff history follows the retake chain, not the code.
const CODE_WORDS = ["maple", "river", "cedar", "harbor", "meadow", "willow", "summit", "canyon", "garden", "prairie", "orchard", "lantern", "compass", "anchor", "falcon", "otter", "pebble", "sparrow", "thistle", "violet", "amber", "copper", "silver", "breeze", "harvest", "island", "juniper", "kettle", "ladder", "marble"];
export function newCode(rand = Math.random) {
  const w = () => CODE_WORDS[Math.floor(rand() * CODE_WORDS.length)];
  return `${w()} ${100 + Math.floor(rand() * 900)} ${w()}`;
}
export function normalizeCode(text) {
  const t = norm(text).replace(/\b([a-z]+)\s*(\d{2,3})\s*([a-z]+)\b/, "$1 $2 $3");
  const m = t.match(/\b([a-z]+) (\d{2,3}) ([a-z]+)\b/);
  return m && CODE_WORDS.includes(m[1]) && CODE_WORDS.includes(m[3]) ? `${m[1]} ${m[2]} ${m[3]}` : null;
}

// Which tests a device gets, in order.
export function plan(device = {}) {
  const steps = ["speech_rate", "magnification", "pictures", "contrast"];
  if (!device.touchOnly && !device.skipPointer) steps.push("cursor");
  steps.push("bold");
  return steps;
}

// ---------------------------------------------------------------- how it ended
// "left" (left without ending) is worked out when read: still started, and
// nothing has happened for two hours.
export const LEFT_AFTER_MS = 2 * 60 * 60 * 1000;
export function checkState(c, now = Date.now()) {
  if (c.status === "finished") return "finished";
  if (c.status === "ended") return "ended";
  if (c.status === "abandoned") return "left";
  const last = new Date(c.updated_at || c.created_at).getTime();
  return Number.isFinite(last) && now - last > LEFT_AFTER_MS ? "left" : "in_progress";
}
export const STATE_WORDS = { finished: "Finished", ended: "Ended early", left: "Left without ending", in_progress: "In progress" };

// What the person may change outside a test, from the menu or by voice.
export const LIVE_SETTINGS = {
  textSize: ["100", "125", "150", "200", "300", "400"],
  theme: ["standard", "blue", "dark", "high"],
  bold: ["off", "on"],
  cursor: CURSOR_SIZES,
  cursorColor: CURSOR_COLORS,
  rate: RATES.map(String),
};
const LIVE_WORDS = { textSize: "text size", theme: "colors", bold: "bold", cursor: "pointer size", cursorColor: "pointer color", rate: "speaking speed" };
const VALUE_WORDS = { standard: "dark on white", blue: "white on dark blue", dark: "light on dark", high: "yellow and white on black", xl: "extra large" };
export function settingChangeWords(ch) {
  const v = ch.setting === "textSize" ? `${ch.value}%` : ch.setting === "rate" ? `${ch.value}x` : VALUE_WORDS[ch.value] || ch.value;
  return `${LIVE_WORDS[ch.setting] || ch.setting} → ${v} (${ch.via === "voice" ? "by voice" : "from the menu"}${ch.step ? `, during ${(PRETTY[ch.step] || ch.step).toLowerCase()}` : ""})`;
}

// ---------------------------------------------------------------- staff side
export const DECISIONS = ["accept", "edit", "reject"];
const PRETTY = { speech_rate: "Speaking speed", magnification: "Text size", pictures: "Pictures", contrast: "Colors", cursor: "Pointer", bold: "Text weight" };
const FLAG_WORDS = {
  needs_magnifier_or_zoom: "needs a magnifier or screen zoom beyond 200% text",
  could_not_read_largest: "could not read the largest text",
  could_not_see_largest_picture: "could not recognize the largest picture",
  could_not_find_largest_pointer: "could not find the largest pointer",
  asked_to_repeat_often: "asked to repeat often",
  many_cant_tell: "often said \"I can't tell\"",
  slow_step: "took a long time on a step",
  stopped_at_trial_limit: "stopped at the trial limit",
  no_pointer_on_this_device: "no pointer on this device",
};
export function flagWords(flags) { return (flags || []).map((f) => FLAG_WORDS[f] || f.replace(/_/g, " ")); }

// A result staff should look at soon: very large text, can't read or find
// the largest, or the person struggled.
export function needsAttention(steps) {
  const all = (steps || []).flatMap((s) => s.flags || []);
  return all.some((f) => ["needs_magnifier_or_zoom", "could_not_read_largest", "could_not_see_largest_picture", "could_not_find_largest_pointer", "many_cant_tell"].includes(f));
}

const DEVICE_WORDS = { ios: { phone: "iPhone", tablet: "iPad" }, android: { phone: "Android phone", tablet: "Android tablet" }, mac: { computer: "Mac" }, windows: { computer: "Windows computer" }, chromeos: { computer: "Chromebook" } };
export function deviceWords(d = {}) {
  const name = (DEVICE_WORDS[d.os] && DEVICE_WORDS[d.os][d.type]) || d.type || "device";
  return name + (d.screenW && d.screenH ? `, screen ${d.screenW}×${d.screenH}` : "");
}

// Plain-text case note to paste into Unitus or another case system.
export function caseNote(c, steps, review) {
  const date = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");
  const L = [];
  L.push(`Vision 360 screen settings check, ${date(c.finished_at || c.created_at)} (code: ${c.code})${c.previous_check_id ? " — retake" : ""}`);
  L.push(`Device: ${deviceWords(c.device)}`);
  if (c.goal) L.push(`Goal: ${c.goal}`);
  const state = checkState(c);
  const stopped = c.stopped_at ? ` (stopped at ${(PRETTY[c.stopped_at] || c.stopped_at).toLowerCase()})` : "";
  L.push(`Status: ${STATE_WORDS[state].toLowerCase()}${state === "ended" || state === "left" ? stopped : ""}`);
  const notReached = state === "finished" ? [] : plan(c.device).filter((s) => !(steps || []).some((x) => x.setting === s && x.recommended_value != null));
  if (notReached.length) L.push(`Not reached: ${notReached.map((s) => PRETTY[s].toLowerCase()).join(", ")}`);
  L.push("");
  L.push(review ? `Settings (reviewed by ${review.reviewer}, ${date(review.created_at)}):` : "Settings (not reviewed yet):");
  for (const setting of SETTINGS) {
    const s = (steps || []).find((x) => x.setting === setting);
    if (!s) continue;
    const d = review && review.decisions && review.decisions[setting];
    let line = `- ${describe(setting, s)}`;
    if (d && d.decision === "accept") line += " — accepted";
    if (d && d.decision === "edit") line += ` — changed to: ${d.value}`;
    if (d && d.decision === "reject") line += " — not recommended";
    L.push(line);
  }
  const flags = [...new Set((steps || []).flatMap((s) => s.flags || []))].filter((f) => f !== "no_pointer_on_this_device");
  if (flags.length) L.push(`Noticed: ${flagWords(flags).join("; ")}`);
  if (review && review.next_steps) { L.push(""); L.push(`Next steps: ${review.next_steps}`); }
  if (review && review.notes) L.push(`Notes: ${review.notes}`);
  const changes = Array.isArray(c.setting_changes) ? c.setting_changes : [];
  if (changes.length) { L.push(""); L.push("Changed by the person outside the tests:"); for (const ch of changes.slice(0, 30)) L.push(`- ${settingChangeWords(ch)}`); }
  if (c.wants_call) L.push("The person asked for a call.");
  if (c.consent_contact && c.contact) {
    const ct = c.contact;
    L.push(`Contact (given with permission): ${[ct.first_name, ct.phone, ct.email].filter(Boolean).join(", ")}`);
  }
  return L.join("\n");
}
export function prettySetting(s) { return PRETTY[s] || s; }
