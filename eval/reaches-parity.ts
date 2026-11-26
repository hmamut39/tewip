// Why does the import-graph walk give a different answer on Linux than on Windows?
//
// `tewip done` reported 73 test files reaching immich's change on Windows and 15 on Linux, from the
// same pinned commit. The counts either side of the walk agree - 3,140 source files, 293 test
// files, the same `start` numbers, and `tewip review` matches on both - so the disagreement is
// inside the walk, and reasoning about it from one platform has already produced two wrong answers.
//
// This prints the walk's own intermediate state: what is in the scanned set, what each layer
// matched, and on which token. Run it on both platforms and diff the output.
//
// Run: node eval/reaches-parity.ts <path to a checkout>
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { importNames, importsIt } from '../engine/review/imports.ts';
import { testFilesFound } from '../engine/review/coverage.ts';
import { sourceFiles } from '../engine/walk.ts';

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

export interface Step {
  step: number;
  layer: number;
  names: string[];
  tests: number;
  others: number;
  examples: string[];
}

export function trace(root: string, file: string, depth = 3): { sources: number; tests: number; inScan: boolean; steps: Step[] } {
  const all = sourceFiles(root);
  const rel = (p: string) => relative(root, p).split(BS).join('/');
  const read = (p: string): string => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  const known = testFilesFound(root).files.map((t) => t.split(BS).join('/'));
  const testSet = new Set(known.map((t) => rel(resolve(root, t))));
  const out: Step[] = [];
  const seen = new Set<string>([rel(resolve(root, file))]);
  let layer = [file];

  for (let step = 1; step <= depth; step += 1) {
    const names = [...new Set(layer.flatMap((f) => (existsSync(resolve(root, f)) ? importNames(root, f) : [])))];
    if (names.length === 0) break;
    const found: string[] = [];
    const next: string[] = [];
    for (const path of all) {
      const where = rel(path);
      if (seen.has(where)) continue;
      if (!importsIt(read(path), names)) continue;
      seen.add(where);
      if (testSet.has(where)) found.push(where);
      else next.push(where);
    }
    out.push({ step, layer: layer.length, names, tests: found.length, others: next.length, examples: (found.length > 0 ? found : next).slice(0, 4) });
    if (found.length > 0) break;
    if (next.length === 0) break;
    layer = next;
  }
  return { sources: all.length, tests: testSet.size, inScan: all.some((p) => rel(p) === file), steps: out };
}

if (import.meta.main) {
  const root = process.argv[2];
  const file = process.argv[3] ?? 'packages/sdk/src/fetch-client.ts';
  if (!root) {
    process.stdout.write(`Give a checkout to trace: node eval/reaches-parity.ts <path> [file]${NL}`);
  } else {
    const t = trace(root, file);
    const lines = [
      `platform ${process.platform}, root ${root}`,
      `source files ${t.sources}, test files ${t.tests}, the changed file is in the scan: ${t.inScan}`,
      '',
    ];
    for (const s of t.steps) {
      lines.push(`step ${s.step}: ${s.layer} file(s) in the layer`);
      lines.push(`  names: ${JSON.stringify(s.names)}`);
      lines.push(`  matched ${s.tests} test(s) and ${s.others} other file(s)`);
      lines.push(`  examples: ${s.examples.join(', ') || '(none)'}`);
    }
    if (t.steps.length === 0) lines.push('no step ran: the file named no importable names at all.');
    process.stdout.write(`${lines.join(NL)}${NL}`);
  }
}
