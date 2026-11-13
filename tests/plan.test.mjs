// The emailed plan: match words, the person's text size and colors, and the
// contact details each organization card must carry.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { loadCorpus } from "../server/lib/corpus.mjs";
import { recordView } from "../server/lib/results.mjs";
import { buildPlan } from "../server/lib/plan.mjs";
import { EMAIL_THEMES, normalizeDisplay, basePx } from "../server/lib/email-style.mjs";
import { makeApp, startSession, talker } from "./helpers.mjs";

const corpus = await loadCorpus();

function fakeResults(ids, points) {
  const top = points[0];
  return {
    matches: ids.map((id, i) => ({ rank: i + 1, points: points[i], strength: corpus.engine.matchStrength(points[i], top, i + 1), reasons: ["You said you want help with technology.", "Serves Mecklenburg County."], cautions: [], ...recordView(corpus, corpus.byId.get(id)) })),
    handoffs: [],
    unresolved: [],
    directoryUrl: "https://vision360.agenticarc.ai/directory/",
  };
}
const withContacts = corpus.organizations.filter((o) => o.contacts.general_phone && o.contacts.general_email && o.contacts.intake_form_url).slice(0, 3).map((o) => o.id);

test("match words: best for #1, strong at 70% of the top score, good below", () => {
  const E = corpus.engine;
  assert.deepEqual(E.matchStrength(100, 100, 1), { key: "best", words: "Best match" });
  assert.equal(E.matchStrength(70, 100, 2).key, "strong");
  assert.equal(E.matchStrength(69, 100, 3).key, "good");
  assert.equal(E.matchStrength(100, 100, 2).key, "strong", "a tie with the top is strong, not best");
});

test("each card has the match words, phone, email, online form and one-line description", () => {
  const res = fakeResults(withContacts, [90, 70, 40]);
  const plan = buildPlan(corpus, res, { name: "Sam" });
  assert.match(plan.text, /Match: #1 · Best match/);
  assert.match(plan.text, /Match: #2 · Strong match/);
  assert.match(plan.text, /Match: #3 · Good match/);
  for (const m of res.matches) {
    assert.ok(plan.text.includes(m.contacts.general_phone), "phone for " + m.id);
    assert.ok(plan.text.includes(m.contacts.general_email), "email for " + m.id);
    assert.ok(plan.text.includes(m.contacts.intake_form_url), "form for " + m.id);
    assert.ok(plan.text.includes(m.oneLine), "description for " + m.id);
    assert.ok(plan.html.includes("Online form"));
  }
  assert.match(plan.html, /href="tel:\d+/);
  assert.match(plan.html, /href="mailto:/);
  assert.doesNotMatch(plan.text + plan.html, /qualif/i, "never says someone qualifies");
});

test("the HTML follows the text size and colors, and the hash changes with them", () => {
  const res = fakeResults(withContacts, [90, 70, 40]);
  for (const [size, theme] of [["100", "standard"], ["150", "high"], ["200", "dark"], ["400", "blue"]]) {
    const plan = buildPlan(corpus, res, { display: { textSize: size, theme } });
    assert.ok(plan.html.includes(`font-size:${basePx(size)}px`), `${size}% gives ${basePx(size)}px`);
    assert.ok(plan.html.includes(`bgcolor="${EMAIL_THEMES[theme].page}"`), `${theme} page color`);
    assert.ok(plan.html.includes(`color:${EMAIL_THEMES[theme].ink}`), `${theme} ink color`);
  }
  assert.equal(basePx("150"), 27);
  const a = buildPlan(corpus, res, { display: { textSize: "150", theme: "high" } });
  const b = buildPlan(corpus, res, { display: { textSize: "150", theme: "dark" } });
  assert.notEqual(a.hash, b.hash);
  assert.deepEqual(normalizeDisplay({ textSize: "999", theme: "neon" }), { textSize: "100", theme: "standard" });
});

test("the email palettes match the page's theme colors in demo.css", () => {
  const css = readFileSync(new URL("../site/demo/demo.css", import.meta.url), "utf8");
  for (const [theme, c] of Object.entries(EMAIL_THEMES)) {
    const block = css.match(new RegExp(`html\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
    assert.ok(block, "theme block for " + theme);
    for (const [token, key] of [["--page", "page"], ["--surface", "surface"], ["--ink", "ink"], ["--muted", "muted"], ["--accent", "accent"]]) {
      const v = block[1].match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
      assert.ok(v, `${token} in ${theme}`);
      assert.equal(c[key].toLowerCase(), v[1].toLowerCase(), `${theme} ${token}`);
    }
  }
});

test("the screen's look reaches the emailed plan and the consent says so", async () => {
  const dir = (process.env.TMPDIR || "/tmp") + "/v360-outbox-plan-" + process.pid;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const app = await makeApp({ V360_OUTBOX_DIR: dir });
  const s = await startSession(app);
  const say = talker(app, s);
  const display = { textSize: "200", theme: "high" };
  const answers = { actor: "myself", county: "Mecklenburg", goals: "technology", age_band: "I'm 67", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" };
  let r = await say("I have low vision and want help magnifying things on my phone", { display });
  for (let i = 0; i < 40 && r.state.phase === "intake"; i++) {
    if (r.turn.expect === "block_offer") { r = await say("skip this section", { display }); continue; }
    r = await say(answers[r.state.currentQuestion.id], { display });
  }
  r = await say("yes", { display, revision: r.state.revision });
  assert.equal(r.state.phase, "results");
  assert.ok(r.state.results.matches[0].strength, "results carry the match words");
  await say("email me the plan", { display });
  await say("sam at example dot com", { display });
  r = await say("yes", { display });
  assert.match(r.turn.text, /best match first/);
  assert.match(r.turn.text, /same text size and colors you picked on screen \(200% text, high contrast\)/);
  assert.equal(r.turn.consent.look, "200% text, high contrast");
  // Changing the screen after consent doesn't change what was agreed.
  r = await say("yes", { display: { textSize: "100", theme: "standard" } });
  assert.match(r.turn.text, /I'm sending your plan/);
  await app.ctx.actions.drain(10);
  const files = readdirSync(dir).filter((f) => f.endsWith(".eml"));
  assert.equal(files.length, 1);
  const eml = readFileSync(dir + "/" + files[0], "utf8");
  assert.match(eml, /font-size:36px/);
  assert.match(eml, /bgcolor="#000000"/);
  assert.match(eml, /#1 · Best match/);
});
