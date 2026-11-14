// Do the browser and component-test tools the README names appear in the labelled failure data?
//
// The README said the rules for them were "checked against more than 500 real messages from public
// projects". That figure appears nowhere else in this repository - not in ROADMAP.md, not in
// eval/README.md, not in a data file - so it is indistinguishable from a number somebody felt was
// about right. This settles what is actually there.
//
// The answer is zero, and that is worth publishing rather than hiding. Every labelled dataset on
// disk was harvested from a Playwright project, so a Selenium or Cypress message could not be in
// one. The rules for those tools are checked against the wording each tool really prints, captured
// in engine/test/driver-errors.test.ts with variants taken from public issue threads, and they run
// on every commit - which is a different and smaller claim than "measured on real failures", and
// the README now makes the smaller one.
//
// One tool cannot be counted this way at all, and saying so is the point of the `ambiguous` field:
// jest-dom's matchers are `toBeVisible`, `toBeInTheDocument`, `toHaveTextContent` - and Playwright's
// own expect API uses the same names. A match proves nothing about which library produced it. The
// first version of this counted 1,210 of them as jest-dom and would have published that number.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl } from '../reporters/store.ts';
import type { TriageRecord } from '../reporters/types.ts';

const NL = String.fromCharCode(10);

interface Tool {
  tool: string;
  /** How this tool says things, in its own words. */
  re: RegExp;
  /** Set when a match cannot be attributed to this tool, with the reason. */
  ambiguous?: string;
}

const TOOLS: Tool[] = [
  {
    tool: 'Selenium',
    re: /\b(?:NoSuchElementException|StaleElementReferenceException|ElementClickInterceptedException|ElementNotInteractableException)\b/,
  },
  { tool: 'WebdriverIO', re: /element \(".*"\) still not displayed|\bwaitUntil\b[^]*?\bexpected\b/ },
  { tool: 'Cypress', re: /\bCypressError\b|cy\.[a-z]+\(\) failed/ },
  { tool: 'Testing Library', re: /TestingLibraryElementError|Unable to find (?:an? (?:accessible )?element|role=|a label)/ },
  { tool: 'Vue Test Utils', re: /\[vue-test-utils\]|\bDOMWrapper\b/ },
  {
    tool: 'jest-dom',
    re: /\b(?:toBeInTheDocument|toHaveTextContent|toBeVisible)\b/,
    ambiguous: "Playwright's own expect API uses the same matcher names, so a match says nothing about which library printed it",
  },
  { tool: 'Jasmine', re: /\bjasmine\b/i },
];

export interface Wordings {
  tool: string;
  found: number;
  ambiguous: string | null;
}

export interface Counted {
  tools: Wordings[];
  datasets: string[];
  records: number;
  withMessage: number;
}

export function measure(root = process.cwd()): Counted {
  const counts = new Map<string, number>(TOOLS.map((t) => [t.tool, 0]));
  const datasets: string[] = [];
  let records = 0;
  let withMessage = 0;

  const dir = join(root, 'data', 'real');
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    entries = [];
  }

  for (const name of entries) {
    let rows: TriageRecord[] = [];
    try {
      rows = readJsonl<TriageRecord>(join(dir, name, 'triage.jsonl'));
    } catch {
      continue;
    }
    if (rows.length === 0) continue;
    datasets.push(name);
    for (const r of rows) {
      records += 1;
      const text = `${r.errorMessage ?? ''}${NL}${r.errorStack ?? ''}`;
      if (text.trim()) withMessage += 1;
      for (const t of TOOLS) if (t.re.test(text)) counts.set(t.tool, (counts.get(t.tool) ?? 0) + 1);
    }
  }

  return {
    tools: TOOLS.map((t) => ({ tool: t.tool, found: counts.get(t.tool) ?? 0, ambiguous: t.ambiguous ?? null })),
    datasets,
    records,
    withMessage,
  };
}

function report(): void {
  const r = measure();
  const countable = r.tools.filter((t) => !t.ambiguous);
  const total = countable.reduce((n, t) => n + t.found, 0);

  process.stdout.write(
    [
      '# the browser and component-test tools, looked for in the labelled failure data',
      '',
      `${r.datasets.length} datasets, ${r.records} records, ${r.withMessage} of them carrying an error message.`,
      '',
      '| tool | messages found |',
      '| --- | --- |',
      ...r.tools.map((t) => `| ${t.tool} | ${t.ambiguous ? `not countable here — ${t.ambiguous}` : t.found} |`),
      '',
      `Countable tools: **${total}** messages across ${countable.length} tools.`,
      '',
      '## What the zero means',
      '',
      'Not that the rules are untested - that this is the wrong place to look for evidence about them.',
      'Every dataset here was harvested from a Playwright project, so a Selenium or Cypress message',
      'could not be in one. The rules are checked against the wording each tool really prints, in',
      'engine/test/driver-errors.test.ts, with variants taken from public issue threads, and those run',
      'on every commit.',
      '',
      'That is a smaller claim than "measured on real failures from public projects", and it is the',
      'one the README now makes. The figure it used to make - "more than 500 real messages" - appears',
      'nowhere in this repository and nothing re-derived it.',
      '',
      '---',
      '',
      'What this cannot settle: whether the wordings captured in the tests are the current ones. A tool',
      'that changes its message wording would break these rules silently, and nothing here watches for',
      'that - it would need a real suite per tool in CI, which is what the polyglot workflow does for',
      'the eight test runners and does not do for these seven.',
      '',
    ].join(NL),
  );
}

if (import.meta.main) report();
