import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../site/voice-commands.js", import.meta.url), "utf8"), ctx);
const C = ctx.V360Commands;
const p = (t) => { const r = C.parse(t); return r ? (r.value ? `${r.cmd}:${r.value}` : r.cmd) : null; };

test("every command in the PRD table is understood", () => {
  const cases = {
    "left": "left", "Right.": "right", "same": "same", "about the same": "same", "top": "left", "bottom": "right",
    "I can't tell": "cant_tell", "I don't know": "cant_tell",
    "bigger": "bigger", "Make the text bigger please": "bigger", "smaller": "smaller",
    "white background": "theme:standard", "blue background": "theme:blue", "black background": "theme:dark", "too bright": "too_bright", "it's too bright": "too_bright",
    "yellow on black": "theme:high",
    "bold on": "bold:on", "bold off": "bold:off",
    "bigger pointer": "pointer:bigger", "make the pointer bigger": "pointer:bigger", "smaller pointer": "pointer:smaller",
    "slower": "voice:slower", "faster": "voice:faster", "louder": "voice:louder", "softer": "voice:softer",
    "repeat": "repeat", "say that again": "repeat", "go back": "back", "skip": "skip", "skip this test": "skip",
    "show menu": "menu:show", "Open the menu": "menu:show", "hide menu": "menu:hide",
    "What can I say?": "help", "stop listening": "stop_listening", "end": "end", "end the assessment": "end",
    "yes": "yes", "ready": "yes", "no": "no", "not yet": "no",
  };
  for (const [said, want] of Object.entries(cases)) assert.equal(p(said), want, `"${said}"`);
});

test("polite words around a command are fine", () => {
  assert.equal(p("um, left please"), "left");
  assert.equal(p("can you make it bigger"), "bigger");
  assert.equal(p("okay the right one"), "right");
  assert.equal(p("could you speak slower please"), "voice:slower");
  assert.equal(p("left side please"), "left");
});

test("a phrase being read aloud never changes a setting", () => {
  for (const said of ["turn left at the light", "find my glasses", "pay the bill", "the right time", "bigger is better", "blue sky today", "call my son", "", "   "]) {
    assert.equal(p(said), null, `"${said}"`);
  }
});

test("'go back' and 'bigger pointer' aren't mistaken for nearby commands", () => {
  assert.equal(p("go back"), "back");
  assert.equal(p("go"), "yes");
  assert.equal(p("bigger pointer"), "pointer:bigger");
  assert.equal(p("bigger"), "bigger");
  assert.equal(p("I can't read it"), "cant_tell");
});

test("global commands are separate from answers", () => {
  assert.ok(C.isGlobal(C.parse("bigger")));
  assert.ok(C.isGlobal(C.parse("end")));
  assert.ok(!C.isGlobal(C.parse("left")));
  assert.ok(!C.isGlobal(C.parse("yes")));
  assert.ok(!C.isGlobal(null));
});

test("no word or phrase people read aloud in the test is also a command", () => {
  const c = JSON.parse(readFileSync(new URL("../site/data/screen-check.json", import.meta.url), "utf8"));
  for (const w of [...c.words, ...c.phrases.map((p) => (typeof p === "string" ? p : p.text)), "house", "apple", "circle", "square"]) assert.equal(C.parse(w), null, `"${w}" would be taken as a command`);
});

test("every spoken reply the commands use is in the wording file", () => {
  const c = JSON.parse(readFileSync(new URL("../site/data/screen-check.json", import.meta.url), "utf8"));
  const js = readFileSync(new URL("../site/screen-check/check.js", import.meta.url), "utf8");
  const used = new Set([...js.matchAll(/C\.say\.([a-zA-Z]+)/g)].map((m) => m[1]));
  for (const line of Object.values({ standard: "themeStandard", blue: "themeBlue", dark: "themeDark", high: "themeHigh" })) used.add(line);
  for (const k of ["sizeUp", "sizeDown", "pointerBigger", "pointerSmaller", "voiceSlower", "voiceFaster", "voiceLouder", "voiceSofter", "voiceLoudest", "voiceSoftest", "voiceSlowest", "voiceFastest", "boldOn", "boldOff"]) used.add(k);
  for (const k of used) assert.ok(typeof c.say[k] === "string" && c.say[k], `say.${k} is missing`);
  assert.ok(Array.isArray(c.commands) && c.commands.length >= 10);
});
