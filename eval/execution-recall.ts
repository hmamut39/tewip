// OWASP ASI05, measured: the model's answer, run as code.
//
// The measuring only. The cases are in `execution-cases.ts` beside this, each one either a
// published CVE - LangChain's PALChain and LLMMathChain, Vanna.AI's generated Plotly code - or the
// same shape written in an SDK people use now, with the forms that must stay quiet as decoys. The
// reasoning for each is there rather than repeated here, because two copies of it would drift.
//
// One case is scored apart from the recall figure: LLMMathChain slices the model's answer out of a
// variable before evaluating it, which is two hops, and this project refuses the second hop
// everywhere it reads a flow. Counting a deliberate refusal as a miss would make the number argue
// for removing the refusal; counting it as a find would be a lie. It is named in the report.
//
// Run: node eval/execution-recall.ts
import { executionFlows } from '../engine/agent/execution-flow.ts';
import { blank } from '../engine/agent/source-text.ts';
import { CASES, type Case } from './execution-cases.ts';

const NL = String.fromCharCode(10);

export interface Measured {
  name: string;
  found: boolean;
  reachable: boolean;
}

const read = (c: Case): boolean => executionFlows(c.file, c.code, blank(c.code, c.file.endsWith('.py'))).length > 0;

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { flows: Measured[]; decoys: Measured[] } {
  const ran = (c: Case): Measured => ({ name: c.name, found: read(c), reachable: c.reachable });
  return {
    flows: CASES.filter((c) => c.runs).map(ran),
    decoys: CASES.filter((c) => !c.runs).map(ran),
  };
}

function report(): void {
  const { flows, decoys } = measure();
  const reachable = flows.filter((f) => f.reachable);
  const found = reachable.filter((f) => f.found).length;
  const accused = decoys.filter((d) => d.found).length;
  const refused = flows.filter((f) => !f.reachable);
  const lines = [
    '# the model’s answer, run as code (OWASP ASI05), measured',
    '',
    `${found} of ${reachable.length} executions read, and ${accused} of ${decoys.length} safe shapes accused.`,
    '',
    'Ground truth is three published CVEs - LangChain’s PALChain (CVE-2023-36258), its LLMMathChain (CVE-2023-29374) and',
    'Vanna.AI’s generated Plotly code (CVE-2024-5565) - plus the same shape written in the SDKs people use now.',
    '',
    '| case | does the model’s answer run? | read as | |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of CASES) {
    const got = read(c);
    const expected = c.reachable ? c.runs : false;
    const ok = got === expected;
    lines.push(`| ${c.name} | ${c.runs ? 'yes' : 'no'} | ${got ? 'reported' : 'quiet'} | ${ok ? 'ok' : '**wrong**'} |`);
  }
  if (refused.length > 0) {
    lines.push(
      '',
      `**${refused.length} documented shape(s) this project refuses to follow**, named rather than left out of the denominator:`,
      '',
    );
    for (const r of refused) lines.push(`- ${r.name} — ${CASES.find((c) => c.name === r.name)?.why ?? ''}`);
  }
  lines.push(
    '',
    'The two decoys that carry the most weight are the sandbox and the person, because both are controls OWASP names for',
    'this risk and Vanna’s own hardening guide asks for the first by name. A check that reports the project which read',
    'the advisory is worse than no check. The third is `eval` of a constant in a body where a model was also called,',
    'which is the commonest arrangement in real code and the false finding that would arrive first.',
    '',
  );
  process.stdout.write(lines.join(NL));
}

if (import.meta.main) report();

