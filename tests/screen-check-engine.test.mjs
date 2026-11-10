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

test("magnification: starts small and grows until two are read in a row; recommended is about twice that", () => {
  assert.equal(C.next("magnification", [], ctx).prompt.px, 12, "starts at the smallest size");
  const { out, trials } = playMag(34);
  assert.equal(out.result.measured_limit, "34");
  assert.equal(out.result.comfort_px, 68);
  assert.equal(out.result.recommended_value, "400", "68px needs 400% (72px)");
  assert.ok(!out.result.flags.includes("needs_magnifier_or_zoom"), "400% is enough");
  assert.deepEqual(trials.map((t) => t.px), [12, 15, 18, 22, 28, 34, 34], "one miss at each size below, then two right");
  const tiny = playMag(12).out.result;
  assert.equal(tiny.measured_limit, "12");
  assert.equal(tiny.recommended_value, "150", "24px fits at 150% (27px)");
  assert.deepEqual(tiny.flags.filter((f) => f !== "slow_step"), []);
  const big = playMag(100).out.result;
  assert.equal(big.recommended_value, "400");
  assert.ok(big.flags.includes("needs_magnifier_or_zoom"), "200px is more than 400% text");
});

test("magnification: 'I can't tell' moves up a size; can't read the largest is flagged", () => {
  const { out } = playMag(1000, { cantTell: true });
  assert.equal(out.result.measured_limit, null);
  assert.equal(out.result.tries, C.LADDER_UP.length, "one try at each size");
  assert.ok(out.result.flags.includes("could_not_read_largest"));
  assert.ok(out.result.flags.includes("needs_magnifier_or_zoom"));
  assert.equal(out.result.recommended_value, "400");
  assert.match(C.describe("magnification", out.result), /could not read the largest text \(200px\)/);
});

test("magnification: a miss after one right moves up; spoken variants and typing count", () => {
  assert.ok(C.wordMatches("I see bred", "bread", { bread: ["bred"] }));
  assert.ok(C.wordMatches("  APPLE. ", "apple"));
  assert.ok(C.wordMatches("it says house", "house"));
  assert.ok(!C.wordMatches("horse", "house"));
  const p1 = C.next("magnification", [], ctx).prompt;
  const t1 = C.cleanTrial("magnification", { answer: p1.word }, p1);
  const p2 = C.next("magnification", [t1], ctx).prompt;
  assert.equal(p2.px, 12, "one right: the same size again");
  const t2 = C.cleanTrial("magnification", { answer: "nope" }, p2);
  const p3 = C.next("magnification", [t1, t2], ctx).prompt;
  assert.equal(p3.px, 15, "then a miss: one size bigger");
  assert.notEqual(p1.word, p2.word, "a new word each time");
});

test("magnification: a check started with the first, shrinking version still adds up", () => {
  const old = [{ px: 72, word: "apple", answer: "apple" }, { px: 72, word: "house", answer: "house" }, { px: 60, word: "river", answer: "x" }, { px: 60, word: "green", answer: "y" }];
  const out = C.next("magnification", old, ctx);
  assert.equal(out.done, true);
  assert.equal(out.result.measured_limit, "72");
  const going = C.next("magnification", old.slice(0, 2), ctx);
  assert.equal(going.prompt.px, 60, "keeps shrinking");
});

test("pictures: start small and grow too", () => {
  const first = C.next("pictures", [], ctx).prompt;
  assert.equal(first.px, 14);
  const t = [C.cleanTrial("pictures", { cant_tell: true }, first)];
  assert.equal(C.next("pictures", t, ctx).prompt.px, 18);
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

test("cursor: four sizes, then four colors; can't see any changes nothing; skipped on touch devices", () => {
  const sz = (a) => ({ kind: "size", answer: a });
  const col = (a) => ({ kind: "color", answer: a });
  let out = C.next("cursor", [], ctx);
  assert.equal(out.prompt.kind, "pick_cursor_size");
  assert.deepEqual([...out.prompt.choices], ["default", "large", "xl", "xxl"]);
  out = C.next("cursor", [sz("xl")], ctx);
  assert.equal(out.prompt.kind, "pick_cursor_color");
  assert.equal(out.prompt.size, "xl");
  assert.deepEqual([...out.prompt.choices], ["black", "white", "yellow", "pink"]);
  out = C.next("cursor", [sz("xxl"), col("pink")], ctx);
  assert.equal(out.result.recommended_value, "xxl/pink");
  assert.deepEqual({ ...out.result.apply }, { cursor: "xxl", cursorColor: "pink" });
  out = C.next("cursor", [sz("default")], ctx);
  assert.equal(out.done, true, "the normal pointer can't be recolored: no color round");
  assert.deepEqual({ ...out.result.apply }, { cursor: "default" });
  out = C.next("cursor", [sz("none")], ctx);
  assert.equal(out.result.recommended_value, "not_found");
  assert.deepEqual({ ...out.result.apply }, {}, "nothing changes on the page");
  assert.ok(out.result.flags.includes("could_not_find_largest_pointer"));
  assert.equal(C.cleanTrial("cursor", { answer: "giant" }, { kind: "pick_cursor_size" }).answer, "none");
  assert.equal(C.cleanTrial("cursor", { answer: "pink" }, { kind: "pick_cursor_color", size: "xl" }).answer, "pink");
  // A check started with the first version (find the pointer, then left or right) still adds up.
  out = C.next("cursor", [sz("found"), sz("lost"), col("right"), col("right")], ctx);
  assert.equal(out.result.recommended_value, "xxl/yellow", "the old largest (128px) is now called huge");
  assert.equal(C.next("cursor", [], { ...ctx, device: { skipPointer: true } }).result.recommended_value, "not_tested");
  assert.deepEqual(C.plan({ skipPointer: true }), ["speech_rate", "magnification", "pictures", "contrast", "bold"], "screen-reader users skip the mouse and highlight tests");
  const touch = C.next("cursor", [], { ...ctx, device: { touchOnly: true } });
  assert.equal(touch.done, true);
  assert.equal(touch.result.recommended_value, "not_tested");
  assert.deepEqual(C.plan({ touchOnly: true }), ["speech_rate", "magnification", "pictures", "contrast", "bold", "highlight"]);
  assert.deepEqual(C.plan({}), ["speech_rate", "magnification", "pictures", "contrast", "cursor", "bold", "highlight"]);
});

test("phrases: numbers said as words or digits, kinds take turns", () => {
  for (const [said, shown] of [["meet at three thirty", "meet at 3:30"], ["meet at 3:30", "meet at 3:30"], ["room two fourteen", "room 214"], ["room two hundred fourteen", "room 214"], ["pay twelve dollars today", "pay $12 today"], ["doctor Lee at two", "Dr. Lee at 2"], ["bus at ten fifteen", "bus at 10:15"], ["best by May four", "best by May 4"], ["twelve Oak Street", "12 Oak Street"], ["save five dollars now", "save $5 now"]]) {
    assert.ok(C.phraseMatches(said, shown), `"${said}" reads "${shown}"`);
  }
  assert.ok(!C.phraseMatches("take three pills", "take 2 pills"), "a wrong number is wrong");
  assert.ok(!C.phraseMatches("meet at four", "meet at 3:30"));
  const phrases = [{ text: "pay the bill", kind: "everyday" }, { text: "feed the dog", kind: "everyday" }, { text: "room 214", kind: "numbers" }, { text: "take 2 pills", kind: "numbers" }, { text: "exit only", kind: "labels" }, { text: "12 Oak Street", kind: "places" }];
  const list = C.phraseList({ phrases, seed: "abc" });
  assert.equal(list.length, phrases.length);
  const kindOf = (t) => phrases.find((p) => p.text === t).kind;
  assert.equal(new Set(list.slice(0, 4).map(kindOf)).size, 4, "the first four are one of each kind");
  assert.deepEqual(C.phraseList({ phrases: ["a b", "c d"], seed: "x" }).sort(), ["a b", "c d"], "plain strings still work");
});

test("bold, struggle flags, codes and the trial limit", () => {
  assert.equal(C.next("bold", [{ answer: "right" }]).result.apply.bold, "on");
  assert.equal(C.next("bold", [{ answer: "left" }]).result.apply.bold, "off");
  const r = C.next("contrast", [{ answer: "left", repeats: 2 }, { answer: "left", repeats: 2, ms: 200000 }]).result;
  assert.ok(r.flags.includes("asked_to_repeat_often"));
  assert.ok(r.flags.includes("slow_step"));
  const code = C.newCode(() => 0.5);
  assert.match(code, /^[a-z]+ \d{3} [a-z]+$/);
  assert.equal(C.normalizeCode(code.toUpperCase().replace(/ /g, "-")), code);
  assert.equal(C.normalizeCode("Maple 472 River"), "maple 472 river");
  assert.equal(C.normalizeCode("maple472river"), "maple 472 river");
  assert.equal(C.normalizeCode("banana 47 river"), null);
  const many = Array.from({ length: 40 }, () => ({ answer: "faster" }));
  assert.equal(C.next("speech_rate", many).done, true, "never runs forever");
  assert.equal(C.cleanTrial("contrast", { answer: "left", ms: 12.7 }, { left: "high", right: "dark" }).ms, 13, "whole milliseconds");
  assert.throws(() => C.next("nope", []));
});

test("describe gives plain words for staff and the results page", () => {
  assert.match(C.describe("magnification", { recommended_value: "400", measured_limit: "40" }), /400%.*40px.*80px.*extra zoom/);
  assert.match(C.describe("contrast", { recommended_value: "high" }), /high contrast/);
  assert.match(C.describe("cursor", { recommended_value: "large/white" }), /large \(64px\), white/);
  assert.match(C.describe("cursor", { recommended_value: "xxl/pink" }), /huge \(128px\), pink/);
  assert.match(C.describe("speech_rate", { recommended_value: "1" }), /1x/);
});

// ------------------------------------------------- Vision Assessment additions
test("phrases: read aloud, main words count, small slips allowed", () => {
  assert.ok(C.phraseMatches("find my glasses", "find my glasses"));
  assert.ok(C.phraseMatches("Find glasses.", "find my glasses"), "small words don't count");
  assert.ok(C.phraseMatches("pay the bell", "pay the bill"), "one letter off in a longer word is fine");
  assert.ok(!C.phraseMatches("pay the rent", "pay the bill"));
  assert.ok(C.phraseMatches("the water plants", "water the plants"), "order doesn't matter");
  assert.ok(C.phraseMatches("turn the light", "turn on the light"));
  assert.ok(!C.phraseMatches("", "pay the bill"));
  assert.ok(C.phraseMatches("apple", "apple"), "a single word still works");
});

test("magnification shows phrases when the wording has them", () => {
  const phrases = ["call my sister", "pay the bill", "open the mail", "feed the dog"];
  const c2 = { ...ctx, phrases };
  const trials = [];
  for (let i = 0; i < 60; i++) {
    const r = C.next("magnification", trials, c2);
    if (r.done) { assert.equal(r.result.measured_limit, "28", "24px is not on the growing ladder: the first size at or above it"); assert.equal(r.result.recommended_value, "400"); return; }
    assert.ok(phrases.includes(r.prompt.word), "a phrase is shown");
    trials.push(C.cleanTrial("magnification", r.prompt.px >= 24 ? { answer: r.prompt.word } : { cant_tell: true }, r.prompt));
  }
  assert.fail("the test never ended");
});

test("pictures: a staircase over house, apple, circle and square", () => {
  assert.ok(C.pictureMatches("it's a house", "house"));
  assert.ok(C.pictureMatches("ball", "circle"));
  assert.ok(C.pictureMatches("box", "square"));
  assert.ok(!C.pictureMatches("a house or a circle", "house"), "naming two pictures is a guess");
  assert.ok(!C.pictureMatches("apple", "house"));
  const play = (seePx) => {
    const trials = [];
    for (let i = 0; i < 60; i++) {
      const r = C.next("pictures", trials, ctx);
      if (r.done) return r.result;
      assert.ok(C.PICTURES.includes(r.prompt.picture));
      trials.push(C.cleanTrial("pictures", r.prompt.px >= seePx ? { answer: r.prompt.picture } : { cant_tell: true }, r.prompt));
    }
    assert.fail("the test never ended");
  };
  const a = play(36);
  assert.equal(a.measured_limit, "36");
  assert.equal(a.recommended_value, "72");
  assert.deepEqual(a.apply, {}, "pictures change nothing on the page");
  const b = play(1000);
  assert.equal(b.measured_limit, null);
  assert.ok(b.flags.includes("could_not_see_largest_picture"));
  assert.ok(C.needsAttention([{ flags: b.flags }]));
  assert.match(C.describe("pictures", a), /36px.*72px/);
  assert.match(C.describe("pictures", b), /could not recognize/);
});

test("word highlighting: plain or lit up, skipped for screen readers", () => {
  let out = C.next("highlight", [], ctx);
  assert.equal(out.prompt.kind, "pair_highlight");
  assert.deepEqual([out.prompt.left, out.prompt.right], ["off", "on"]);
  out = C.next("highlight", [C.cleanTrial("highlight", { answer: "right" }, out.prompt)], ctx);
  assert.deepEqual({ ...out.result.apply }, { highlight: "on" });
  assert.match(C.describe("highlight", out.result), /on, each word lights up/);
  assert.equal(C.next("highlight", [{ answer: "same" }], ctx).result.recommended_value, "off", "'same' keeps plain text");
  assert.equal(C.next("highlight", [], { ...ctx, device: { skipPointer: true } }).result.recommended_value, "not_tested");
});
