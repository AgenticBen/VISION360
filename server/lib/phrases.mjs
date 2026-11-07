// The assistant's fixed lines (site/voice-phrases.js, shared with the page,
// and the screen check's lines in site/data/screen-check.json).
// Only these exact lines may be voiced by /api/tts-phrase, so it can't be used
// to turn arbitrary text into speech.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT_DIR } from "./corpus.mjs";

let cached = null;
export function voicePhrases() {
  if (cached) return cached;
  const code = readFileSync(path.join(ROOT_DIR, "site", "voice-phrases.js"), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx, { timeout: 1000 });
  const P = ctx.V360_PHRASES;
  const allowed = new Set(P.all());
  // The screen check's fixed lines (site/data/screen-check.json).
  const sc = JSON.parse(readFileSync(path.join(ROOT_DIR, "site", "data", "screen-check.json"), "utf8"));
  for (const [k, line] of Object.entries(sc.say || {})) {
    if (k === "deviceAsk") for (const name of Object.values(sc.deviceNames || {})) allowed.add(line.replace("{device}", name));
    else allowed.add(line);
  }
  if (sc.say && sc.say.magIntro) allowed.add(sc.say.magIntro + " " + sc.say.magWord);
  cached = { P, allowed };
  return cached;
}
