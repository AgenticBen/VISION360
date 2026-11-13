// Fills an organization's online form for a person, in a Vercel Sandbox VM
// (headless Chromium), from an approved form recipe. Used by the form job
// (actions.mjs, type org_form_submit) and by staff in Admin › Outreach to
// inspect a form or do a dry run.
//
// The browser never runs on the site's own servers. Each run starts a fresh
// VM from a prepared snapshot (V360_FORM_RUNNER_SNAPSHOT, built once by
// scripts/form-runner-image.mjs), copies in runner/*.mjs, runs one job and
// stops the VM. The VM may only reach the form's own web addresses.
//
// The Sandbox SDK (@vercel/sandbox) is loaded only here and only when a
// snapshot is configured, so the rest of the site keeps no dependencies.
// Without it, every form job falls back to email or a staff task.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./corpus.mjs";

const RUNNER_FILES = ["fill-form.mjs", "detect.mjs"];
const DIR = "/tmp/v360-runner";

export function formRunnerConfigured(env) {
  return !!env.V360_FORM_RUNNER_SNAPSHOT;
}

// The real sandbox client. Kept tiny so tests can swap in a fake.
export function sandboxClient(env) {
  return {
    async run(job, { allowDomains = [], timeoutMs = 90000 } = {}) {
      let Sandbox;
      // Loaded by name at run time so deploys without the package still build.
      // To switch the runner on: add @vercel/sandbox to package.json and to
      // includeFiles for api/outreach.mjs in vercel.json (see docs/outreach.md).
      const SDK = env.V360_SANDBOX_SDK || "@vercel/sandbox";
      try { ({ Sandbox } = await import(SDK)); }
      catch { return { outcome: "not_set_up", detail: "The browser runner isn't installed (@vercel/sandbox)." }; }
      const creds = env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID ? { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID } : {};
      const sandbox = await Sandbox.create({
        ...creds,
        source: { type: "snapshot", snapshotId: env.V360_FORM_RUNNER_SNAPSHOT },
        timeout: timeoutMs,
        // Only the form's own addresses: the person's details can't go anywhere else.
        networkPolicy: { allow: allowDomains },
      });
      try {
        // Copy the runner in through base64 (no shell quoting of page data).
        for (const f of RUNNER_FILES) {
          const b64 = readFileSync(path.join(ROOT_DIR, "runner", f)).toString("base64");
          await sandbox.runCommand("sh", ["-c", `mkdir -p ${DIR} && echo ${b64} | base64 -d > ${DIR}/${f}`]);
        }
        const arg = Buffer.from(JSON.stringify(job)).toString("base64");
        const r = await sandbox.runCommand("sh", ["-c", `cd /opt/v360-runner && cp ${DIR}/*.mjs . && node fill-form.mjs ${arg}`]);
        const text = String(await r.stdout()).trim().split("\n").pop() || "";
        try { return JSON.parse(text); } catch { return { outcome: "error", detail: "The runner gave no result. " + String(await r.stderr()).slice(0, 200) }; }
      } finally {
        await sandbox.stop().catch(() => {});
      }
    },
  };
}

export function createFormRunner({ env, recipes, client = null }) {
  const sb = client || (formRunnerConfigured(env) ? sandboxClient(env) : null);

  // A person's form job. Returns { outcome, detail }.
  async function fill(payload) {
    if (!sb) return { outcome: "not_set_up", detail: "Automatic form filling isn't set up yet." };
    const recipe = await recipes.get(payload.recipeId);
    if (!recipe || !["test_approved", "live_approved"].includes(recipe.status)) return { outcome: "recipe_changed", detail: "The form recipe is no longer approved." };
    if (payload.recipeVersion !== recipe.version) return { outcome: "recipe_changed", detail: "The form recipe changed after the person agreed." };
    try {
      return await sb.run({ mode: "fill", url: recipe.url, recipe, values: payload.values }, { allowDomains: recipe.allowDomains });
    } catch (e) {
      return { outcome: /timeout/i.test(String(e && e.message)) ? "timeout" : "error", detail: String(e && e.message || e).slice(0, 200) };
    }
  }

  // Staff tools: look at a form (nothing typed), or fill it without submitting.
  async function inspect(url, allowDomains) {
    if (!sb) return { outcome: "not_set_up", detail: "Automatic form filling isn't set up yet (V360_FORM_RUNNER_SNAPSHOT)." };
    return sb.run({ mode: "inspect", url }, { allowDomains });
  }
  async function dryRun(recipe, values) {
    if (!sb) return { outcome: "not_set_up", detail: "Automatic form filling isn't set up yet (V360_FORM_RUNNER_SNAPSHOT)." };
    return sb.run({ mode: "dry", url: recipe.url, recipe, values }, { allowDomains: recipe.allowDomains });
  }

  return { configured: !!sb, fill, inspect, dryRun };
}
