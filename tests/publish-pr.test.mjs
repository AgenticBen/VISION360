// Publishing through a pull request: proposed -> live / failed in the change log.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalStore, createGithubStore } from "../server/lib/gh-store.mjs";
import { createRequests } from "../server/lib/requests.mjs";
import { createFlowRepo } from "../server/lib/flow-repo.mjs";
import { loadCorpus } from "../server/lib/corpus.mjs";

let n = 0;
function prStore() {
  const tmp = process.env.TMPDIR || "/tmp";
  const gh = createLocalStore(`${tmp}/v360-pr-${process.pid}-${++n}`);
  const prs = new Map();
  gh.proposals = [];
  gh.proposeToMain = async (files, message, o) => { const pr = prs.size + 1; prs.set(pr, { state: "open", merged: false }); gh.proposals.push({ files, message, ...o, pr }); return { sha: "abc1234", branch: o.branch, pr, url: "https://github.com/x/y/pull/" + pr }; };
  gh.pullState = async (pr) => ({ ...prs.get(pr), mergeSha: "def5678" });
  gh.includes = async (sha, running) => running === "running-commit";
  gh.prs = prs;
  return gh;
}

test("publish opens a PR with the flow, lock and golden files; change log says proposed, then live", async () => {
  const corpus = await loadCorpus();
  const gh = prStore();
  const requests = createRequests(gh);
  const flows = createFlowRepo({ gh, corpus, requests });
  const cur = await flows.get("referral");
  const flow = cur.published;
  flow.questions[0].prompt = flow.questions[0].prompt + " (edited)";
  await flows.saveDraft("referral", { flow, draftRevision: 0, author: "T" });
  const out = await flows.publish("referral", { name: "T", note: "Reword" });
  assert.equal(out.state, "proposed");
  assert.equal(out.pr, 1);
  const p = gh.proposals[0];
  assert.match(p.branch, /^publish\/referral-v\d+-/);
  assert.deepEqual(p.files.map((f) => f.path).sort(), ["data/corpus.lock.json", "site/data/assessment.json", "tests/fixtures/golden-personas.json"]);
  assert.match(p.body, /Routing impact/);
  let log = await requests.changelog();
  assert.equal(log[0].state, "proposed");
  assert.equal(log[0].pr, 1);
  // Not merged yet: stays proposed.
  assert.equal(await flows.reconcile("running-commit"), 0);
  gh.prs.set(1, { state: "closed", merged: true });
  assert.equal(await flows.reconcile("older-commit"), 0, "merged but not deployed here yet");
  assert.equal(await flows.reconcile("running-commit"), 1);
  log = await requests.changelog();
  assert.equal(log[0].state, "live");
  assert.equal(log[0].ref, "def5678");
});

test("a PR closed without merging marks the change failed", async () => {
  const corpus = await loadCorpus();
  const gh = prStore();
  const requests = createRequests(gh);
  const flows = createFlowRepo({ gh, corpus, requests });
  const flow = (await flows.get("v360-interest")).published;
  flow.questions[0].prompt = flow.questions[0].prompt + "!";
  await flows.saveDraft("v360-interest", { flow, draftRevision: 0 });
  await flows.publish("v360-interest", { name: "T", note: "x" });
  gh.prs.set(1, { state: "closed", merged: false });
  await flows.reconcile("running-commit");
  const log = await requests.changelog();
  assert.equal(log[0].state, "failed");
  assert.match(log[0].state_note, /checks/);
});

test("GitHub adapter: branch, commit and pull request calls", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init.method + " " + url.replace("https://api.github.com/repos/AgenticBen/VISION360", ""));
    const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (url.endsWith("/git/ref/heads/main")) return j({ object: { sha: "p1" } });
    if (url.includes("/git/commits/p1")) return j({ tree: { sha: "t0" } });
    if (url.endsWith("/git/trees")) return j({ sha: "t1" }, 201);
    if (url.endsWith("/git/commits")) return j({ sha: "c1" }, 201);
    if (url.endsWith("/git/refs")) return j({}, 201);
    if (url.endsWith("/pulls")) return j({ number: 7, html_url: "https://github.com/AgenticBen/VISION360/pull/7" }, 201);
    return j({}, 404);
  };
  const gh = createGithubStore({ V360_GITHUB_TOKEN: "t" }, fetch);
  const r = await gh.proposeToMain([{ path: "a.json", text: "{}" }], "msg", { branch: "publish/x", title: "T", body: "B" });
  assert.deepEqual(r, { sha: "c1", branch: "publish/x", pr: 7, url: "https://github.com/AgenticBen/VISION360/pull/7" });
  assert.deepEqual(calls, ["GET /git/ref/heads/main", "GET /git/commits/p1", "POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls"]);
});
