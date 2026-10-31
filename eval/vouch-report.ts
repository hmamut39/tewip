// What the vouch-recall measurement is allowed to claim.
//
// Split out of eval/vouch-recall.ts when running it for the first time showed the reporting was the
// weak part. On engine/audit/audit.ts with 8 mutants it printed "named 2 of 4 (50.0%)". With 14
// mutants of the same file, the denominator went to **zero**: every test that had been labelled as
// having lost its check turned out to catch something after all, and the two vouch had "missed"
// were tests that still held a real assertion. The 50% was not a measurement of vouch. It was a
// measurement of how few mutants had been asked for.
//
// The label is "caught at least one mutant before the deletion, and none after". The second half is
// evidence of hollowness only to the extent that the mutants are many: with few of them, "caught
// none" means "none of these three happened to be noticed", which is a different sentence. So the
// harness now judges at two budgets and prints a percentage only when the labels agree at both. If
// they do not, it says the labels are not settled and gives the counts without a rate - the same
// rule the rest of Tewip follows, that "cannot say" beats a number somebody will quote.
const NL = String.fromCharCode(10);

export type Says = 'cannot-fail' | 'crash-only' | 'checks' | 'not-judged' | 'not-found';

export interface Judged {
  /** The `it(...)` title, which is what vouch knows a test by. */
  name: string;
  /** Describe blocks plus title: the only thing that identifies a test uniquely. */
  full: string;
  /** The mutants this test failed for, by line and kind. */
  caught: Set<string>;
  /** What vouch says about it, by reading. */
  says: Says;
  /** Vouch's own reason, printed beside a miss: it is what makes a miss diagnosable. */
  why?: string;
}

/** The tests that caught something before the deletion and nothing after, at one mutant budget. */
export function lostTheirCheck(asWritten: Judged[], afterSeeding: Judged[], hollowed: string[]): Judged[] {
  const before = new Map(asWritten.map((j) => [j.full, j]));
  return afterSeeding.filter((j) => {
    const whole = before.get(j.full);
    return hollowed.includes(j.name) && whole !== undefined && whole.caught.size > 0 && j.caught.size === 0;
  });
}

export interface Pass {
  budget: number;
  asWritten: Judged[];
  afterSeeding: Judged[];
}

export function report(passes: Pass[], hollowed: string[]): string {
  const labelled = passes.map((p) => ({ budget: p.budget, lost: lostTheirCheck(p.asWritten, p.afterSeeding, hollowed), pass: p }));
  const low = labelled[0];
  const high = labelled[labelled.length - 1];
  // Same set of tests at both budgets, by full title: then the labels have settled and a rate means
  // something. Different: the smaller budget was inventing cases, and a rate would be a fiction.
  const names = (l: typeof low) => [...l.lost.map((j) => j.full)].sort().join('|');
  const settled = labelled.length < 2 || names(low) === names(high);

  const lost = high.lost;
  const stillSound = high.pass.afterSeeding.filter((j) => j.caught.size > 0);
  const named = lost.filter((j) => j.says === 'cannot-fail' || j.says === 'crash-only');
  const outright = lost.filter((j) => j.says === 'cannot-fail');
  const missed = lost.filter((j) => j.says === 'checks');
  const accused = stillSound.filter((j) => j.says === 'cannot-fail');
  const rate = (n: number, of: number) => (!settled ? 'not settled' : of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

  const out = [
    '# vouch, judged by execution',
    '',
    `${high.pass.asWritten.length} test(s) in the file. The last statement was dropped from ${hollowed.length}.`,
    `Judged at ${labelled.map((l) => `${l.budget}`).join(' and ')} mutant(s).`,
    '',
  ];

  if (!settled) {
    out.push(
      '## The labels are not settled, so no rate is reported',
      '',
      ...labelled.map((l) => `- at ${l.budget} mutant(s): ${l.lost.length} test(s) labelled as having lost their check`),
      '',
      'A test is labelled hollow here because it caught a mutant before the deletion and none after.',
      'When the two budgets disagree, "caught none after" only meant "none of the few mutants tried',
      'happened to be noticed", and the tests that drop out of the label at the larger budget were',
      'never hollow. Ask for more mutants, or for a file whose mutants saturate, before quoting a',
      'recall figure from this.',
      '',
    );
  }

  out.push(
    `**${lost.length}** test(s) provably lost their check at ${high.budget} mutant(s): each caught a mutation before, and catches none now.`,
    '',
    '## Recall: of the tests that provably lost their check, how many does vouch name?',
    '',
    `Named at all (cannot fail, or compares no value): ${named.length} of ${lost.length} (${rate(named.length, lost.length)})`,
    `Named as unable to fail outright:                 ${outright.length} of ${lost.length} (${rate(outright.length, lost.length)})`,
    `Missed - vouch called them sound:                 ${missed.length}`,
    `Refused to judge:                                ${lost.filter((j) => j.says === 'not-judged').length}`,
    '',
    '## Precision: does it accuse a test that still catches things?',
    '',
    `Tests that still caught a mutation after the deletion: ${stillSound.length}`,
    `Of those, wrongly called unable to fail:               ${accused.length}`,
    '',
    ...(missed.length > 0
      ? ['## The ones it missed', '', "...and vouch's reason for clearing each, which is where a miss turns into a bug:", '', ...missed.slice(0, 15).map((j) => `- ${j.name}${j.why ? ` — ${j.why}` : ''}`), '']
      : []),
    ...(accused.length > 0 ? ['## Wrongly accused', '', ...accused.slice(0, 10).map((j) => `- ${j.name}`), ''] : []),
    '---',
    '',
    'What the labels rest on: a test counted as having lost its check is one that failed for at least',
    'one mutation of the source before the deletion and for none afterwards. That is execution, not',
    "reading, and the deletion rule knows nothing about vouch's vocabulary - which is what stops this",
    'being a measurement of its own seeding.',
    '',
    'What it is still limited by: the mutants are few and the label depends on them, which is why two',
    'budgets are run and a rate is withheld when they disagree. A test whose check survives in a form',
    'no mutant here reaches is not counted at all.',
    '',
  );
  return out.join(NL);
}
