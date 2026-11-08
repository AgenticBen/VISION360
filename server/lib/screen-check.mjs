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
// Word sizes shown, in CSS pixels, largest first.
export const LADDER = [72, 60, 48, 40, 34, 28, 24, 20, 18, 16, 14, 12];
// Picture sizes shown, in CSS pixels, largest first.
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
export const TEXT_SIZES = [100, 125, 150, 200];
export const THEMES = ["high", "dark", "standard"];
export const CURSOR_SIZES = ["xl", "large", "default"];
export const CURSOR_COLORS = ["black", "white", "yellow"];
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
// A spoken or typed answer to "read this out loud". A single word is checked
// with wordMatches; a phrase needs its main words (not "the", "my", ...):
// all of them for two, all but one for three or more, in any order.
export function phraseMatches(answer, target, soundsLike = {}) {
  const t = norm(target).split(" ").filter(Boolean);
  if (t.length <= 1) return wordMatches(answer, target, soundsLike);
  const heard = norm(answer).split(" ").filter(Boolean);
  if (!heard.length) return false;
  const content = t.filter((w) => !STOP.has(w));
  const need = content.length ? content : t;
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

function magnification(trials, ctx) {
  let level = 0, rightRun = 0, wrongHere = 0, smallestOk = null;
  const end = (reason) => {
    const flags = struggleFlags(trials);
    if (smallestOk == null) flags.push("could_not_read_largest");
    const comfortPx = smallestOk == null ? LADDER[0] * 2 : smallestOk * 2;
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
        apply: { textSize: ts.textSize },
      },
    };
  };
  for (const t of trials) {
    const ok = !t.cant_tell && phraseMatches(t.answer, t.word, ctx.soundsLike);
    if (ok) {
      rightRun++;
      if (rightRun >= 2) {
        smallestOk = LADDER[level];
        if (level === LADDER.length - 1) return end("bottom");
        level++; rightRun = 0; wrongHere = 0;
      }
    } else {
      rightRun = 0; wrongHere++;
      if (wrongHere >= 2) return end("limit");
    }
  }
  if (trials.length >= MAX_TRIALS) return end("max");
  const list = ctx.phrases && ctx.phrases.length ? ctx.phrases : ctx.words;
  return { done: false, prompt: { kind: "word", px: LADDER[level], word: wordFor(ctx.seed, trials.length, list), n: trials.length + 1 } };
}

// ------------------------------------------------------------------- pictures
function pictures(trials, ctx) {
  let level = 0, rightRun = 0, wrongHere = 0, smallestOk = null;
  const end = (reason) => {
    const flags = struggleFlags(trials);
    if (smallestOk == null) flags.push("could_not_see_largest_picture");
    if (reason === "max") flags.push("stopped_at_trial_limit");
    const comfortPx = smallestOk == null ? PICTURE_LADDER[0] * 2 : smallestOk * 2;
    return { done: true, result: { measured_limit: smallestOk == null ? null : String(smallestOk), recommended_value: String(comfortPx), unit: "px", tries: trials.length, flags, comfort_px: comfortPx, apply: {} } };
  };
  for (const t of trials) {
    const ok = !t.cant_tell && pictureMatches(t.answer, t.picture);
    if (ok) {
      rightRun++;
      if (rightRun >= 2) {
        smallestOk = PICTURE_LADDER[level];
        if (level === PICTURE_LADDER.length - 1) return end("bottom");
        level++; rightRun = 0; wrongHere = 0;
      }
    } else {
      rightRun = 0; wrongHere++;
      if (wrongHere >= 2) return end("limit");
    }
  }
  if (trials.length >= MAX_TRIALS) return end("max");
  return { done: false, prompt: { kind: "picture", px: PICTURE_LADDER[level], picture: wordFor(ctx.seed + "/pictures", trials.length, PICTURES), choices: PICTURES, n: trials.length + 1 } };
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
function cursor(trials, ctx) {
  if (ctx.device && (ctx.device.touchOnly || ctx.device.skipPointer)) {
    return { done: true, result: { measured_limit: null, recommended_value: "not_tested", unit: "pointer", tries: 0, flags: ["no_pointer_on_this_device"], apply: {} } };
  }
  const sizeTrials = trials.filter((t) => t.kind !== "color");
  const colorTrials = trials.filter((t) => t.kind === "color");
  let i = 0, kept = null, sizeDone = false;
  for (const t of sizeTrials) {
    if (t.answer === "found") { kept = CURSOR_SIZES[i]; if (i === CURSOR_SIZES.length - 1) { sizeDone = true; break; } i++; }
    else { sizeDone = true; break; }
  }
  if (!sizeDone && sizeTrials.length >= MAX_TRIALS) sizeDone = true;
  if (!sizeDone) return { done: false, prompt: { kind: "find_pointer", size: CURSOR_SIZES[i] } };
  const flags = struggleFlags(trials);
  // Couldn't find even the largest pointer (or uses the keyboard): change
  // nothing on the page, and tell staff.
  if (kept == null) {
    flags.push("could_not_find_largest_pointer");
    return { done: true, result: { measured_limit: null, recommended_value: "not_found", unit: "pointer", tries: trials.length, flags, apply: {} } };
  }
  const c = tournament(CURSOR_COLORS, colorTrials, "pair_cursor");
  if (!c.done) return { done: false, prompt: { ...c.prompt, size: kept } };
  return { done: true, result: { measured_limit: kept, recommended_value: kept + "/" + c.winner, unit: "pointer", tries: trials.length, flags, apply: { cursor: kept, cursorColor: c.winner } } };
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
    if (prompt.kind === "pair_cursor") return { ...base, kind: "color", left: prompt.left, right: prompt.right, answer: ["left", "right", "same"].includes(r.answer) ? r.answer : "same" };
    return { ...base, kind: "size", size: prompt.size, answer: r.answer === "found" ? "found" : "lost" };
  }
  throw new Error("Unknown setting: " + setting);
}

// Plain words for a setting's result (staff view, case note, results page).
export function describe(setting, result) {
  if (!result) return "Not tested";
  const v = result.recommended_value;
  if (setting === "speech_rate") return `Speech rate ${v}x (started at the slowest, ${RATES[0]}x)`;
  if (setting === "magnification") {
    const comfort = result.comfort_px || (result.measured_limit ? Number(result.measured_limit) * 2 : LADDER[0] * 2);
    const extra = result.extra_zoom || textSizeFor(comfort).extraZoom;
    const lim = result.measured_limit ? `smallest text read correctly: ${result.measured_limit}px` : `could not read the largest text (${LADDER[0]}px)`;
    return `Text size ${v}% (${lim}; comfortable size about ${comfort}px${extra > 1 ? `, needs about ${extra}x extra zoom or a magnifier` : ""})`;
  }
  if (setting === "pictures") return result.measured_limit ? `Pictures: smallest picture recognized ${result.measured_limit}px; icons and pictures about ${v}px should be comfortable` : `Pictures: could not recognize the largest picture (${PICTURE_LADDER[0]}px)`;
  if (setting === "contrast") return `Colors: ${{ high: "high contrast (yellow and white on black)", dark: "light text on dark", standard: "dark text on white" }[v] || v}`;
  if (setting === "cursor" && v === "not_found") return "Pointer: couldn't find the largest pointer (128px); no change made";
  if (setting === "cursor") return v === "not_tested" ? "Pointer: not tested (no pointer on this device, or uses the keyboard)" : `Pointer: ${String(v).split("/")[0] === "xl" ? "extra large" : String(v).split("/")[0] === "large" ? "large" : "normal size"}, ${String(v).split("/")[1]}`;
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
  L.push(`Status: ${c.status === "finished" ? "finished" : "not finished"}`);
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
  if (c.wants_call) L.push("The person asked for a call.");
  if (c.consent_contact && c.contact) {
    const ct = c.contact;
    L.push(`Contact (given with permission): ${[ct.first_name, ct.phone, ct.email].filter(Boolean).join(", ")}`);
  }
  return L.join("\n");
}
export function prettySetting(s) { return PRETTY[s] || s; }
