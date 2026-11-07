import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call } from "./helpers.mjs";
import { createApp } from "../server/lib/api.mjs";
import { openStore } from "../server/lib/store.mjs";
import { voicePhrases } from "../server/lib/phrases.mjs";

test("the fixed lines list covers the welcome for both pages at every size and color", () => {
  const { P, allowed } = voicePhrases();
  for (const k of ["demo", "assessment"]) for (const s of P.SIZES) for (const t of P.THEMES) assert.ok(allowed.has(P.welcome(P.ASKS[k], s, t)));
  assert.ok(allowed.has(P.say.sizeTo("200") + P.better(P.ASKS.demo)));
  assert.ok(allowed.has(P.listening));
});

test("/api/tts-phrase voices only listed lines, and only with natural voice on", async () => {
  const { P } = voicePhrases();
  const off = await makeApp();
  let r = await call(off, "POST", "/api/tts-phrase", { text: P.listening });
  assert.equal(r.status, 404);

  let calls = 0;
  const ttsFetch = async () => { calls++; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
  const tmp = process.env.TMPDIR || "/tmp";
  const on = await createApp({ store: openStore(":memory:"), env: { ELEVENLABS_API_KEY: "sk_test", V360_ADMIN_SIGNIN: "off", V360_ADMIN_STORE_DIR: `${tmp}/v360-phrase-${process.pid}-${Date.now()}` }, ttsFetch });
  await call(on, "PUT", "/api/admin/settings", { voice: { elevenlabs: true } });
  r = await call(on, "POST", "/api/tts-phrase", { text: "Say anything I like" });
  assert.equal(r.status, 404);
  assert.equal(calls, 0);
  r = await call(on, "POST", "/api/tts-phrase", { text: P.listening, rate: 1 });
  assert.equal(r.status, 200);
  r = await call(on, "POST", "/api/tts-phrase", { text: P.listening, rate: 1 });
  assert.equal(r.status, 200);
  assert.equal(calls, 1, "a line is voiced once, then served from the cache");
});
