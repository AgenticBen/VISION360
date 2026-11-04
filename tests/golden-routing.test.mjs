// Golden routing: the services recommended for fixed sample people must stay
// the same unless someone changes the rules on purpose. A failure prints which
// services moved, so the change can be reviewed before updating the fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { readFixture, route, describeDiff } from "./golden.mjs";
import { makeApp, startSession, talker } from "./helpers.mjs";

const { personas } = readFixture();

for (const p of personas) {
  test(`golden routing: ${p.id}`, async () => {
    assert.ok(p.expected, `${p.id} has no expected results yet; run node scripts/golden-update.mjs`);
    const actual = await route(p);
    const same = JSON.stringify(actual.matches) === JSON.stringify(p.expected.matches)
      && JSON.stringify(actual.handoffs) === JSON.stringify(p.expected.handoffs);
    assert.ok(same, describeDiff(p.id, p.expected, actual));
  });
}

// The chat must reach the same recommendations as the engine for the same
// person, in both typed and voice mode.
for (const p of personas.filter((x) => x.conversation)) {
  for (const mode of ["text", "voice"]) {
    test(`golden routing via conversation (${mode}): ${p.id}`, async () => {
      const app = await makeApp();
      const s = await startSession(app, mode);
      const say = talker(app, s);
      const c = p.conversation;
      let r = await say(c.opening, { mode });
      for (let i = 0; i < 40 && r.state.phase === "intake"; i++) {
        if (r.turn.expect === "block_offer") { r = await say(c.section, { mode }); continue; }
        const qid = r.state.currentQuestion && r.state.currentQuestion.id;
        assert.ok(c.answers[qid], `${p.id}: no scripted answer for ${qid}`);
        r = await say(c.answers[qid], { mode });
      }
      assert.equal(r.state.phase, "recap", r.turn.text);
      const done = await say("yes", { mode, revision: r.state.revision });
      const got = { matches: done.state.results.matches.map((m) => m.id), handoffs: done.state.results.handoffs.map((h) => h.id), detail: [] };
      const same = JSON.stringify(got.matches) === JSON.stringify(p.expected.matches)
        && JSON.stringify(got.handoffs) === JSON.stringify(p.expected.handoffs);
      assert.ok(same, describeDiff(`${p.id} (${mode} conversation)`, p.expected, got));
    });
  }
}
