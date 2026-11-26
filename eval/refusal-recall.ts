// OWASP ASI09, measured: a gate that cannot say no.
//
// The measuring only; the cases are in `refusal-cases.ts` beside this, with the reasoning for each
// one there rather than repeated here.
//
// What this exists to stop is a sentence this project prints. `guards.ts` finds the places a
// project asks a person something, and the report says "something here stops and waits for a
// person" - a reassuring claim that nothing checked. A `confirm()` whose answer is discarded asks
// the question and carries on, and the person has been told by the software that they were
// consulted. OWASP's own description of ASI09 is confident presentation leading a human operator
// to approve what they would otherwise refuse, and an approval step that has quietly stopped being
// a check is the version of that which lives in source.
//
// Run: node eval/refusal-recall.ts
import { toothlessGates } from '../engine/agent/gate-refuses.ts';
import { CASES, type Case } from './refusal-cases.ts';

const NL = String.fromCharCode(10);

export interface Measured {
  name: string;
  found: boolean;
}

const read = (c: Case): boolean => toothlessGates(c.file, c.code).length > 0;

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { flows: Measured[]; decoys: Measured[] } {
  const ran = (c: Case): Measured => ({ name: c.name, found: read(c) });
  return {
    flows: CASES.filter((c) => !c.refuses).map(ran),
    decoys: CASES.filter((c) => c.refuses).map(ran),
  };
}

function report(): void {
  const { flows, decoys } = measure();
  const found = flows.filter((f) => f.found).length;
  const accused = decoys.filter((d) => d.found).length;
  const lines = [
    '# a gate that cannot say no (OWASP ASI09), measured',
    '',
    `${found} of ${flows.length} toothless gates read, and ${accused} of ${decoys.length} working gates accused.`,
    '',
    'Ground truth is the shape each library documents for asking a person. Every decoy is real code from the corpus, and',
    'most of them are shapes this check reported as broken before they were read by hand.',
    '',
    '| case | can the person refuse? | read as | |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of CASES) {
    const got = read(c);
    const ok = got === !c.refuses;
    lines.push(`| ${c.name} | ${c.refuses ? 'yes' : 'no'} | ${got ? 'reported' : 'quiet'} | ${ok ? 'ok' : '**wrong**'} |`);
  }
  lines.push(
    '',
    'The decoys outnumber the findings on purpose. A gate is a reassuring thing to contradict: telling somebody their',
    'approval step does nothing, when it works, is the kind of wrong that gets a check switched off - and then somebody',
    'has written "we check our approval gates" on a form. The first draft of this reported 54 gates across the corpus and',
    'every one of them was a correct implementation.',
    '',
  );
  process.stdout.write(lines.join(NL));
}

if (import.meta.main) report();
