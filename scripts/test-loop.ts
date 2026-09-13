// Runs `playwright test` N times in a row (default 5) to build up failure history.
// Usage: node scripts/test-loop.ts [count] [...extra playwright args]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const count = Number(process.argv[2] ?? 5);
if (!Number.isInteger(count) || count < 1) {
  console.error(`Invalid run count: ${process.argv[2]}`);
  process.exit(2);
}
const extraArgs = process.argv.slice(3);
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const exitCodes: number[] = [];
for (let i = 1; i <= count; i++) {
  console.log(`\n=== test:loop run ${i}/${count} ===`);
  const env = { ...process.env };
  // Each run needs its own id; with CI_RUN_ID set, suffix it so runs stay distinct.
  delete env.TRIAGE_RUN_ID;
  if (process.env.CI_RUN_ID) env.TRIAGE_RUN_ID = `${process.env.CI_RUN_ID}-${i}`;

  const result = spawnSync(process.execPath, [cli, 'test', ...extraArgs], { stdio: 'inherit', env });
  if (result.error || result.status === null) {
    console.error(`Run ${i} could not complete:`, result.error ?? `killed by ${result.signal}`);
    process.exit(1);
  }
  exitCodes.push(result.status);
}

// Test failures are expected here (they are the data being collected), so the loop
// itself succeeds as long as every run completed.
const failedRuns = exitCodes.filter((c) => c !== 0).length;
console.log(`\n=== test:loop done: ${count} run(s), ${failedRuns} with failing tests (exit codes: ${exitCodes.join(', ')}) ===`);
