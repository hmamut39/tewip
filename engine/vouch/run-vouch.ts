// The command around `vouch`: read the paths, print the report, and exit non-zero under --strict so
// it can sit in front of a merge. Kept apart from the report itself so the MCP server can ask the
// same question without anything being printed to the stream it speaks on.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CANNOT_FAIL } from './vouch.ts';
import { renderVouch, vouchAll, type VouchCommand } from './vouch-command.ts';

/** The silent core: every MCP caller and the report itself use this. */
export function vouchReport(root: string, paths: string[]): { report: string; cannotFail: number; read: number } {
  const files = vouchAll(root, paths);
  const all = files.flatMap((f) => f.judgements);
  return {
    report: renderVouch(files),
    cannotFail: all.filter((j) => CANNOT_FAIL.includes(j.verdict)).length,
    read: all.length,
  };
}

export function runVouch(cmd: VouchCommand): void {
  const files = vouchAll(cmd.root, cmd.paths);
  const report = renderVouch(files);
  console.log(report);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), report + String.fromCharCode(10), 'utf8');
  }
  if (cmd.json) {
    mkdirSync(dirname(resolve(cmd.json)), { recursive: true });
    writeFileSync(resolve(cmd.json), JSON.stringify(files, null, 2), 'utf8');
  }

  const cannotFail = files.flatMap((f) => f.judgements).filter((j) => CANNOT_FAIL.includes(j.verdict)).length;
  if (cmd.strict && cannotFail > 0) {
    console.error(String.fromCharCode(10) + `${cannotFail} test(s) here cannot fail. Fix them or take them out; a test that cannot fail is worse than no test, because it reads as coverage.`);
    process.exitCode = 1;
  }
}
