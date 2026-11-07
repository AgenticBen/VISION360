// The assistant's fixed lines (site/voice-phrases.js, shared with the page).
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
  cached = { P, allowed: new Set(P.all()) };
  return cached;
}
