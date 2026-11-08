// How much each line of the evidence pack is worth, recorded rather than asserted.
//
// "No credentials found" is not evidence of anything on its own. A check that finds nothing scores
// perfect precision, and the reader has no way to tell a careful answer from an empty one. The
// sentence that is worth putting in front of an auditor is the pair: nothing was found, **and this
// check finds 100% of twenty credential formats their own providers publish, with none of five
// decoys wrongly accused**.
//
// So every number here was measured, and every one was measured against something somebody else
// published - the W3C's numbered failure techniques, the database manuals, the providers' token
// formats, the frameworks' quickstarts. Never against Tewip's own rules, because a check marking
// its own homework produces a number that means nothing and reads exactly like one that does.
//
// This file is a record, in the same spirit as corpus/expected.json: each figure names the harness
// that produces it, so a reader who does not believe it can run that harness and get it back.
export interface Confidence {
  /** The command the claim belongs to. */
  check: string;
  /** What it got wrong on real code, and how much real code. */
  precision: string;
  /** What it found of a published list, and how long that list was. */
  recall: string;
  /** The harness that re-derives the recall figure. */
  from: string;
  /** Where the list came from, which is the whole argument. */
  groundTruth: string;
}

export const MEASURED: Confidence[] = [
  {
    check: 'secure',
    precision: '0 findings across 18,617 files of real code',
    recall: '20 of 20 credential shapes found and kept by triage, 0 of 5 decoys wrongly accused',
    from: 'eval/secure-recall.ts',
    groundTruth: "each provider's own published token format - AWS, GitHub, Stripe, Shopify and the rest",
  },
  {
    check: 'schema',
    precision: '0 false positives across 14 real projects',
    recall: '15 of 15 harmful migrations named, 0 of 4 safe ones accused',
    from: 'eval/schema-recall.ts',
    groundTruth: 'the PostgreSQL and MySQL manuals, and each framework’s own documentation',
  },
  {
    check: 'access',
    precision: "0 barriers on Google's Compose samples",
    recall: '11 of 11 documented failures noticed, 0 of 11 documented fixes accused',
    from: 'eval/access-recall.ts',
    groundTruth: "the W3C's numbered failure techniques - F65, F68, F54, F44, H64, H91, H57",
  },
  {
    check: 'agent',
    precision: '0 findings across 1,691 files of real agent code',
    recall: '10 of 10 framework shapes read, 0 of 4 decoys invented',
    from: 'eval/agent-recall.ts',
    groundTruth: "the shape each framework's own quickstart shows",
  },
  {
    check: 'vouch',
    precision: '0 of 157 sound tests wrongly accused',
    recall: '48 of 64 (75.0%) tests that provably lost their check were named',
    from: 'eval/vouch-recall.ts',
    groundTruth: 'execution - a test that caught a mutation before and catches none now',
  },
];

/** Checks that carry no measured recall yet, named rather than left out of the table. */
export const NOT_MEASURED: Array<{ check: string; why: string }> = [
  { check: 'sbom', why: 'it reads a lockfile rather than deciding anything, so there is nothing to be right or wrong about - what it cannot read is listed in its own report' },
  { check: 'infra', why: 'measured for precision on three real infrastructure repositories; its recall has no published list to measure against yet' },
  { check: 'contract', why: 'the comparison is exact once both versions parse; what is unmeasured is how many real descriptions the YAML reader can read, and the report says when it cannot read one' },
];

export const confidenceFor = (check: string): Confidence | undefined => MEASURED.find((m) => m.check === check);

/** The table, and the sentence that says why it is here. */
export function confidenceSection(used: string[]): string[] {
  const rows = MEASURED.filter((m) => used.includes(m.check));
  const missing = NOT_MEASURED.filter((m) => used.includes(m.check));
  if (rows.length === 0 && missing.length === 0) return [];
  const lines = [
    '## How much each line above is worth',
    '',
    'Nothing found is not evidence of anything on its own: a check that finds nothing scores perfect',
    'precision, and a reader cannot tell a careful answer from an empty one. Each figure below was',
    'measured against a list somebody else published, never against Tewip’s own rules, and each names',
    'the harness that re-derives it.',
    '',
  ];
  if (rows.length > 0) {
    lines.push('| check | wrong on real code | found of a published list | measured against |', '| --- | --- | --- | --- |');
    for (const r of rows) lines.push(`| \`${r.check}\` | ${r.precision} | ${r.recall} | ${r.groundTruth} |`);
    lines.push('', ...rows.map((r) => `- \`${r.check}\` — re-derive with \`node ${r.from}\``), '');
  }
  if (missing.length > 0) {
    lines.push('**Carrying no measured recall:**', '', ...missing.map((m) => `- \`${m.check}\` — ${m.why}`), '');
  }
  return lines;
}
