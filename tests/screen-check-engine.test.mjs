// The screen check's scoring rules (server/lib/screen-check.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../server/lib/screen-check.mjs";

const words = ["apple", "house", "river", "green", "chair", "bread", "music", "phone"];
const ctx = { words, soundsLike: { bread: ["bred"] }, seed: "abc" };

// Plays the magnification test, answering right while the word is at least
// `seePx` big, and wrong (or "can't tell") below that.
function playMag(seePx, { cantTell = false } = {}) {
  const trials = [];
  for (let i = 0; i < 60; i++) {
    const out = C.next("magnification", trials, ctx);
    if (out.done) return { out, trials };
    const p = out.prompt;
    trials.push(C.cleanTrial("magnification", p.px >= seePx ? { answer: p.word } : cantTell ? { cant_tell: true } : { answer: "something else" }, p));
  }
  throw new Error("never finished");
}

test("magnification: two right moves smaller, two wrong ends; recommended is about twice the limit", () => {
  const { out } = playMag(24);
  assert.equal(out.result.measured_limit, "24");
  assert.equal(out.result.comfort_px, 48);
  assert.equal(out.result.recommended_value, "200", "48px needs more than 150% (27px), so 200% (36px)");
  assert.ok(out.result.flags.includes("needs_magnifier_or_zoom"), "48px is bigger than 200% text");
  assert.equal(out.result.apply.textSize, "200");
  const small = playMag(12).out.result;
  assert.equal(small.measured_limit, "12");
  assert.equal(small.recommended_value, "150", "24px fits at 150% (27px)");
  assert.deepEqual(small.flags.filter((f) => f !== "slow_step"), []);
  const mid = playMag(14).out.result;
  assert.equal(mid.recommended_value, "200", "28px needs 200%");
  assert.equal(C.next("magnification", [], ctx).prompt.px, 72, "starts at the largest size");
});

test("magnification: 'I can't tell' counts as wrong; can't read the largest is flagged", () => {
  const { out } = playMag(1000, { cantTell: true });
  assert.equal(out.result.measured_limit, null);
  assert.equal(out.result.tries, 2, "two wrong at the first size ends it");
  assert.ok(out.result.flags.includes("could_not_read_largest"));
  assert.ok(out.result.flags.includes("needs_magnifier_or_zoom"));
  assert.equal(out.result.recommended_value, "200");
});

test("magnification: a wrong answer resets the two-right run; spoken variants and typing count", () => {
  assert.ok(C.wordMatches("I see bred", "bread", { bread: ["bred"] }));
  assert.ok(C.wordMatches("  APPLE. ", "apple"));
  assert.ok(C.wordMatches("it says house", "house"));
  assert.ok(!C.wordMatches("horse", "house"));
  const p1 = C.next("magnification", [], ctx).prompt;
  const t1 = C.cleanTrial("magnification", { answer: p1.word }, p1);
  const p2 = C.next("magnification", [t1], ctx).prompt;
  const t2 = C.cleanTrial("magnification", { answer: "nope" }, p2);
  const p3 = C.next("magnification", [t1, t2], ctx).prompt;
  assert.equal(p3.px, 72, "one right, one wrong: still the same size");
  assert.notEqual(p1.word, p2.word, "a new word each time");
});

test("speech rate: starts slowest, steps with faster/slower, keeps on 'keep'", () => {
  let p = C.next("speech_rate", []).prompt;
  assert.equal(p.rate, "0.7");
  const tr = (a) => ({ answer: a });
  assert.equal(C.next("speech_rate", [tr("faster"), tr("faster")]).prompt.rate, "1");
  assert.equal(C.next("speech_rate", [tr("faster"), tr("faster"), tr("slower")]).prompt.rate, "0.85");
  assert.equal(C.next("speech_rate", [tr("slower")]).prompt.rate, "0.7", "never below the slowest");
  const done = C.next("speech_rate", [tr("faster"), tr("keep")]);
  assert.equal(done.done, true);
  assert.equal(done.result.recommended_value, "0.85");
  assert.equal(done.result.apply.rate, "0.85");
});

test("contrast: left-or-right pairs narrow to one scheme", () => {
  let out = C.next("contrast", []);
  assert.deepEqual([out.prompt.left, out.prompt.right], ["high", "dark"], "starts with yellow on black vs white on black");
  out = C.next("contrast", [{ answer: "right" }]);
  assert.deepEqual([out.prompt.left, out.prompt.right], ["dark", "standard"]);
  out = C.next("contrast", [{ answer: "right" }, { answer: "left" }]);
  assert.equal(out.result.recommended_value, "dark");
  assert.equal(C.next("contrast", [{ answer: "same" }, { answer: "same" }]).result.recommended_value, "high", "'same' keeps the left one");
});

test("cursor: shrinks while found, keeps the last size found, then a color pair; skipped on touch devices", () => {
  const sz = (a) => ({ kind: "size", answer: a });
  const col = (a) => ({ kind: "color", answer: a });
  assert.equal(C.next("cursor", [], ctx).prompt.size, "xl");
  assert.equal(C.next("cursor", [sz("found")], ctx).prompt.size, "large");
  let out = C.next("cursor", [sz("found"), sz("lost")], ctx);
  assert.equal(out.prompt.kind, "pair_cursor");
  assert.equal(out.prompt.size, "xl", "lost at large: keep extra large");
  out = C.next("cursor", [sz("found"), sz("lost"), col("right"), col("right")], ctx);
  assert.equal(out.result.recommended_value, "xl/yellow");
  assert.deepEqual({ ...out.result.apply }, { cursor: "xl", cursorColor: "yellow" });
  out = C.next("cursor", [sz("lost"), col("left"), col("left")], ctx);
  assert.equal(out.result.measured_limit, "xl");
  assert.ok(out.result.flags.includes("could_not_find_largest_pointer"));
  out = C.next("cursor", [sz("found"), sz("found"), sz("found"), col("left"), col("left")], ctx);
  assert.equal(out.result.recommended_value, "default/black");
  const touch = C.next("cursor", [], { ...ctx, device: { touchOnly: true } });
  assert.equal(touch.done, true);
  assert.equal(touch.result.recommended_value, "not_tested");
  assert.deepEqual(C.plan({ touchOnly: true }), ["speech_rate", "magnification", "contrast", "bold"]);
  assert.deepEqual(C.plan({}), ["speech_rate", "magnification", "contrast", "cursor", "bold"]);
});

test("bold, struggle flags, codes and the trial limit", () => {
  assert.equal(C.next("bold", [{ answer: "right" }]).result.apply.bold, "on");
  assert.equal(C.next("bold", [{ answer: "left" }]).result.apply.bold, "off");
  const r = C.next("contrast", [{ answer: "left", repeats: 2 }, { answer: "left", repeats: 2, ms: 200000 }]).result;
  assert.ok(r.flags.includes("asked_to_repeat_often"));
  assert.ok(r.flags.includes("slow_step"));
  const code = C.newCode(() => 0.5);
  assert.match(code, /^[a-z]+ \d{2} [a-z]+$/);
  assert.equal(C.normalizeCode(code.toUpperCase().replace(/ /g, "-")), code);
  assert.equal(C.normalizeCode("Maple 47 River"), "maple 47 river");
  assert.equal(C.normalizeCode("banana 47 river"), null);
  const many = Array.from({ length: 40 }, () => ({ answer: "faster" }));
  assert.equal(C.next("speech_rate", many).done, true, "never runs forever");
  assert.throws(() => C.next("nope", []));
});

test("describe gives plain words for staff and the results page", () => {
  assert.match(C.describe("magnification", { recommended_value: "200", measured_limit: "24" }), /200%.*24px.*48px.*extra zoom/);
  assert.match(C.describe("contrast", { recommended_value: "high" }), /high contrast/);
  assert.match(C.describe("cursor", { recommended_value: "large/white" }), /large, white/);
  assert.match(C.describe("speech_rate", { recommended_value: "1" }), /1x/);
});
