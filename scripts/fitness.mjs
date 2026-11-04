#!/usr/bin/env node
// Architecture fitness checks: rules about how the code is put together that
// tests don't cover (for example "only one place defines geography ranking").
// Each check returns a list of problems; an empty list is a pass.
//
//   npm run fitness
//
// Checks are added as the pilot plan lands. IDs (FC1, FC5, ...) match the
// target design in the private audits folder.

const CHECKS = [
  // { id: "FC5", title: "One definition of geography ranking", run: () => [] },
];

let failed = 0;
for (const check of CHECKS) {
  let problems;
  try {
    problems = check.run();
  } catch (e) {
    problems = [`check crashed: ${e.message}`];
  }
  if (problems.length) {
    failed++;
    console.error(`  FAIL  ${check.id}  ${check.title}`);
    for (const p of problems) console.error(`        - ${p}`);
  } else {
    console.log(`  PASS  ${check.id}  ${check.title}`);
  }
}

if (!CHECKS.length) console.log("  No fitness checks defined yet.");
if (failed) {
  console.error(`\n${failed} fitness check(s) failed.\n`);
  process.exit(1);
}
console.log("\nFitness checks passed.\n");
