// Builds the Vercel Sandbox snapshot the form runner starts from: Linux with
// Chromium's system libraries, Node and Playwright in /opt/v360-runner.
// Run once (and again after Playwright updates), then set the printed id as
// V360_FORM_RUNNER_SNAPSHOT in Vercel. See docs/outreach.md.
//
//   npm i --no-save @vercel/sandbox
//   VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... node scripts/form-runner-image.mjs
//
// (On a machine linked to the project, `vercel env pull` provides an OIDC
// token instead.)
import { Sandbox } from "@vercel/sandbox";

const DEPS = ["nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core", "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor", "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm", "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo", "gtk3", "dbus-libs"];
const creds = process.env.VERCEL_TOKEN ? { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID } : {};

const sandbox = await Sandbox.create({ ...creds, runtime: "node24", timeout: 600000 });
const run = async (cmd) => {
  const r = await sandbox.runCommand("sh", ["-c", cmd]);
  if (r.exitCode !== 0) { console.error(await r.stderr()); throw new Error("Failed: " + cmd); }
  return r;
};
try {
  console.log("Installing Chromium's system libraries…");
  await run(`sudo dnf clean all && sudo dnf install -y --skip-broken ${DEPS.join(" ")} && sudo ldconfig`);
  console.log("Installing Playwright and Chromium…");
  await run("sudo mkdir -p /opt/v360-runner && sudo chown $(id -u) /opt/v360-runner && cd /opt/v360-runner && npm init -y >/dev/null && npm i playwright@1 && npx playwright install chromium");
  const snap = await sandbox.snapshot();
  console.log("\nDone. In Vercel, set V360_FORM_RUNNER_SNAPSHOT to:\n  " + snap.snapshotId);
} finally {
  await sandbox.stop().catch(() => {});
}
