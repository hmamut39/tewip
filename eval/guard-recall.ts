// What stands between an agent's tools and the real world - measured, because the claim is a
// negative one and nobody had ever checked it.
//
// `agent` reports three things. The tools have a number (eval/agent-recall.ts) and the injection
// flows have one (eval/injection-recall.ts). The guards had none, and were not even listed as
// unmeasured, while the pack printed this about them:
//
//   **Nothing anywhere in this project asks a person anything, declares a step ceiling, or draws
//   its tools from a named list.** Where a tool can delete or pay, that is not a maybe.
//
// That is categorical, and it is an *absence* claim - the hardest kind to earn and the easiest to
// get wrong, because a shape the reader cannot parse produces exactly the same silence as a shape
// that is not there. If `guardsIn` cannot read a framework's gate, the pack tells an IT department
// that an agent which stops and asks does no such thing, in bold, and invites them to act on it.
//
// Every case below is the shape the framework's own documentation uses, with the page that shows it
// named beside it. Where a framework documents a Python form and a JavaScript form, both are here:
// the two are different strings and a reader that only knows one is silent about half the market.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAgent } from '../engine/agent/scan.ts';
import { CASES, DECOYS, type Case } from './guard-cases.ts';
import type { GuardKind } from '../engine/agent/guards.ts';

const NL = String.fromCharCode(10);


export interface Measured {
  framework: string;
  kind: GuardKind;
  source: string;
  found: boolean;
  why?: string;
}

export function measure(): { frameworks: Measured[]; decoys: Measured[] } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-guard-recall-'));
  try {
    for (const c of [...CASES, ...DECOYS]) {
      mkdirSync(join(root, c.file, '..'), { recursive: true });
      writeFileSync(join(root, c.file), c.body, 'utf8');
    }
    // scanAgent rather than guardsIn: the walk and the blanking are part of the answer, and a
    // measurement that skipped them would be about a function instead of about the command.
    const guards = scanAgent(root).guards;
    const judge = (c: Case): Measured => ({
      framework: c.framework,
      kind: c.kind,
      source: c.source,
      found: guards.some((g) => g.file.endsWith(c.file.replace(/\\/g, '/')) && g.kind === c.kind),
      why: c.why,
    });
    return { frameworks: CASES.map(judge), decoys: DECOYS.map(judge) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function report(): void {
  const { frameworks, decoys } = measure();
  const found = frameworks.filter((f) => f.found);
  const invented = decoys.filter((d) => d.found);
  const pct = (n: number) => `${((n / frameworks.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      "# the guards half of agent, measured against each framework's own documentation",
      '',
      `${frameworks.length} gates, each written the way the page that documents it writes it, and`,
      `${decoys.length} decoys that look like gates and stop nothing.`,
      '',
      `Gates found:            ${found.length} of ${frameworks.length} (${pct(found.length)})`,
      `Invented from a decoy:  ${invented.length} of ${decoys.length}`,
      '',
      '## Gates it cannot see',
      '',
      ...(frameworks.filter((f) => !f.found).length === 0
        ? ['None.']
        : frameworks.filter((f) => !f.found).map((f) => `- **${f.framework}** — \`${f.kind}\`, documented at ${f.source}`)),
      '',
      '## Gates it invented',
      '',
      ...(invented.length === 0 ? ['None of them was counted as a guard.'] : invented.map((d) => `- **${d.framework}** — ${d.why}`)),
      '',
      '---',
      '',
      'Why a miss here is the worst kind: the sentence this check produces when it finds nothing is',
      '"nothing anywhere in this project asks a person anything", in bold, about an agent that can',
      'delete and pay. A shape it cannot parse produces that sentence just as readily as a project',
      'with no gate at all. What this cannot measure is whether a gate that exists stands in front',
      'of the tool that issues refunds, which is a property of the running graph; the report says so',
      'in those words rather than implying otherwise.',
      '',
    ].join(NL),
  );
}

// `import.meta.main`, not a substring of argv[1]: a test file named after this harness
// made `process.argv[1].includes('guard-recall')` true, so importing it to read its exports ran the
// whole measurement - minutes of work, on a module that was only being imported.
if (import.meta.main) report();

