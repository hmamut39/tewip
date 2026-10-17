// Phase 10, the parts that need no account: a bug ticket written from a real diagnosis, and test
// cases written as a file a test-management tool can import. What matters in both is restraint -
// only a failure Tewip really believes is a bug becomes a ticket, the same failure is never filed
// twice, and a file with a comma or a newline in it still parses.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TriageItem } from '../../outlets/items.ts';
import type { Plan } from '../quality/plan.ts';
import { bugBody, bugSummary, CONFIDENT_ENOUGH, seenAgain, whyNothingWasFiled } from '../work/bug-command.ts';
import { cell, toXrayCsv, toZephyrCsv } from '../work/testcase-export.ts';

const NL = String.fromCharCode(10);

const item = (over: Partial<TriageItem> = {}): TriageItem =>
  ({
    title: 'checkout charges the card once',
    testId: 'chromium > checkout.spec.ts > checkout charges the card once',
    file: 'tests/checkout.spec.ts',
    component: 'checkout',
    commit: 'a1b2c3d4e5f6',
    errorHead: 'expected 1 charge, received 2',
    diagnosis: { category: 'REAL_BUG', confidence: 0.93, source: 'rules rules-9' },
    action: { kind: 'file-bug', summary: 'File a bug against checkout; do not change the test.' },
    evidence: ['value mismatch (expected 1, received 2)', 'the test passed on this branch yesterday'],
    source: 'rules rules-9',
    ...over,
  }) as unknown as TriageItem;

describe('a bug ticket written from a diagnosis', () => {
  it('says what failed, what it did, and why Tewip believes it', () => {
    const body = bugBody(item(), 'https://ci.example.com/run/9');
    assert.match(body, /Tewip diagnosed a real bug in the application rather than a problem with the test/);
    assert.match(body, /Test: chromium > checkout\.spec\.ts/);
    assert.match(body, /Run: https:\/\/ci\.example\.com\/run\/9/);
    assert.match(body, /expected 1 charge, received 2/);
    assert.match(body, /Diagnosis: REAL_BUG at 0\.93 confidence \(rules rules-9\)/);
    assert.match(body, /- value mismatch/);
    assert.match(body, /\/triage CATEGORY #n reason/, 'it tells the reader how to correct it');
  });

  it('keeps the same title across runs, so the second failure is recognised', () => {
    assert.equal(bugSummary(item({ component: 'payments' })), 'checkout charges the card once (payments)');
    assert.equal(bugSummary(item()), 'checkout charges the card once', 'the area is left out when the title already says it');
    assert.equal(bugSummary(item({ commit: 'zzzz' } as Partial<TriageItem>)), bugSummary(item()), 'a new commit is the same bug');
  });

  it('has a short line for a bug that happened again', () => {
    const line = seenAgain(item(), 'https://ci.example.com/run/12');
    assert.match(line, /Seen again/);
    assert.match(line, /a1b2c3d4/);
    assert.ok(line.length < 220, 'a repeat is a note, not another report');
  });
});

const PLAN: Plan = {
  title: 'Checkout',
  summary: '',
  scope: [],
  out_of_scope: [],
  risks: [],
  open_questions: [],
  scenarios: [
    {
      id: 'CO-001',
      title: 'a card is charged once, even when "Pay" is pressed twice',
      type: 'functional',
      priority: 'P0',
      preconditions: 'a signed-in shopper with one item in the basket',
      steps: ['open /checkout', 'press "Pay", then press it again', 'wait for the receipt'],
      expected: 'exactly one charge appears, and the receipt says "1 payment"',
      automate: true,
      covered_by: '',
      grounded_on: 'the checkout page',
    },
    {
      id: 'CO-002',
      title: 'a declined card shows why',
      type: 'negative',
      priority: 'P1',
      preconditions: '',
      steps: ['pay with a card the bank declines'],
      expected: 'the page says the card was declined, and nothing is charged',
      automate: true,
      covered_by: 'tests/checkout.spec.ts: declines',
      grounded_on: 'the checkout page',
    },
  ],
};

/** A small CSV reader, so the test checks what an importer would really see. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else value += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(value);
      value = '';
    } else if (ch === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (ch !== '\r') value += ch;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

describe('test cases as a file a tool can import', () => {
  it('writes one row per step for Xray, with the case on the first row', () => {
    const rows = parseCsv(toXrayCsv(PLAN, 'Checkout'));
    assert.deepEqual(rows[0].slice(0, 5), ['Issue ID', 'Summary', 'Description', 'Test Type', 'Action']);
    const first = rows.filter((r) => r[0] === 'CO-001');
    assert.equal(first.length, 3, 'three steps, three rows');
    assert.match(first[0][1], /^CO-001 a card is charged once/);
    assert.equal(first[1][1], '', 'the summary is not repeated on every row');
    assert.equal(first[0][7], 'High', 'P0 becomes the importer\'s own word');
    assert.match(first[2][6], /exactly one charge appears/, 'the expected result sits on the last step');
  });

  it('writes Zephyr\'s own column names', () => {
    const rows = parseCsv(toZephyrCsv(PLAN, 'Checkout'));
    assert.deepEqual(rows[0].slice(0, 4), ['Name', 'Objective', 'Precondition', 'Priority']);
    const second = rows.filter((r) => r[0].startsWith('CO-002'))[0];
    assert.match(second[1], /Already covered by: tests\/checkout\.spec\.ts/);
    assert.equal(second[4], 'Draft', 'a drafted case is not marked approved');
  });

  it('survives a comma, a quote and a line break, which every real test case has', () => {
    const rows = parseCsv(toXrayCsv(PLAN, 'Checkout'));
    const steps = rows.filter((r) => r[0] === 'CO-001').map((r) => r[4]);
    assert.ok(steps.includes('press "Pay", then press it again'), `quotes and commas survived: ${steps.join(' | ')}`);
    assert.equal(cell(`two${NL}lines`), `"two${NL}lines"`);
  });
});

// Phase 64: `tewip bugs` field-tested on real reports and real harvested failures.
//
// Measured with the rules alone over 1,964 failures from five public projects - gutenberg, supabase,
// lxdui, penpot, jupyterlab - **20 REAL_BUG verdicts, of which 1 reaches the 0.8 bar this command
// requires.** Four of the five produce none at all. Phase 55 capped a model-only diagnosis at 0.45
// and this bar has been 0.8 since Phase 10; the two numbers were set eight weeks apart and never
// compared, so a bug only the model recognises can never be filed.
//
// The bar is not lowered here. What is fixed is the refusal, which used to print
// "none of them is a real bug Tewip is confident about (REAL_BUG, ENV)" - naming REAL_BUG inside
// the sentence denying there was one.
describe('why nothing was filed', () => {
  const diagnosed = (category: string, confidence: number, source: string) =>
    ({ category, confidence, source } as unknown as TriageItem['diagnosis']);
  const unsureBug = (confidence: number, source = 'AI gpt-5.4-mini (reasoning low)') =>
    item({ diagnosis: diagnosed('REAL_BUG', confidence, source), source });
  const flaky = item({ diagnosis: diagnosed('TIMING', 0.8, 'rules rules-9'), source: 'rules rules-9' });
  const env = item({ diagnosis: diagnosed('ENV', 0.8, 'rules rules-9'), source: 'rules rules-9' });

  it('does not name REAL_BUG in the sentence that says there is no real bug', () => {
    const said = whyNothingWasFiled([unsureBug(0.45), env], [unsureBug(0.45)]);
    assert.doesNotMatch(said, /none of them (is|looks like) a real bug/, 'there was one; it was not sure enough');
    assert.match(said, /1 of them Tewip reads as a real bug/);
  });

  it('names the bar and the highest confidence, so the reason is checkable', () => {
    const said = whyNothingWasFiled([unsureBug(0.45), unsureBug(0.3), env], [unsureBug(0.45), unsureBug(0.3)]);
    assert.match(said, /2 of them Tewip reads as a real bug/);
    assert.match(said, /0\.80 confidence/, 'the bar');
    assert.match(said, /the highest is 0\.45/, 'and how far off it was');
  });

  it('says that a model-only verdict is capped on purpose, and what would lift it', () => {
    const said = whyNothingWasFiled([unsureBug(0.45)], [unsureBug(0.45)]);
    assert.match(said, /capped at 0\.45 on purpose/);
    // Phase 65 moved the "what would lift it" half into its own sentence, because the honest answer
    // for a CI user is history rather than a vaguer "a rule that agrees".
    assert.match(said, /A person's correction on the failure in CI settles it immediately/);
  });

  it('does not blame the model when the rules were the ones that hesitated', () => {
    const byRules = unsureBug(0.6, 'rules rules-9');
    const said = whyNothingWasFiled([byRules], [byRules]);
    assert.doesNotMatch(said, /capped at 0\.45/, 'that sentence is about the AI layer only');
    assert.match(said, /the highest is 0\.60/);
  });

  it('still says plainly when nothing in the report is a bug at all', () => {
    const said = whyNothingWasFiled([flaky, env], []);
    assert.match(said, /none of them looks like the application being wrong/);
    assert.match(said, /TIMING, ENV/);
    assert.match(said, /which is the point/);
  });

  it('keeps the bar where it is, because a ticket on a model\'s word is the thing not to do', () => {
    assert.equal(CONFIDENT_ENOUGH, 0.8);
  });
});

// Phase 65: the Phase 64 recommendation, measured and refused.
//
// The suggestion was to let the rules call a plain value mismatch a real bug without history, since
// "expected 4, received 3" needs no model. Measured over 2,767 hand-labelled real failures from nine
// projects: 293 value mismatches, of which **TIMING 265 (90.4%)** and REAL_BUG 26 (8.9%). A flaky
// test fails its assertion too. The rule declines for a good reason and keeps declining.
describe('what a refusal tells a CI user to do about it', () => {
  const diagnosed = (category: string, confidence: number, source: string) =>
    ({ category, confidence, source } as unknown as TriageItem['diagnosis']);
  const modelBug = item({ diagnosis: diagnosed('REAL_BUG', 0.45, 'AI gpt-5.4-mini'), source: 'AI gpt-5.4-mini' });

  it('names history as the thing that is missing, not just the confidence', () => {
    const said = whyNothingWasFiled([modelBug], [modelBug]);
    assert.match(said, /What would change this: history/);
    assert.match(said, /stable failing streak/);
  });

  it('says why a wrong value is not enough on its own, with the measured number', () => {
    const said = whyNothingWasFiled([modelBug], [modelBug]);
    assert.match(said, /a flaky test produces the same wrong value/);
    assert.match(said, /nine times out of ten/, 'the 8.9% measured over 2,767 labelled failures');
  });

  it('gives the two things that actually settle it', () => {
    const said = whyNothingWasFiled([modelBug], [modelBug]);
    assert.match(said, /--name <project>/, 'keep the runs and the streak becomes readable');
    assert.match(said, /correction on the failure in CI settles it immediately/);
  });

  it('does not lecture about history when there was no real bug to begin with', () => {
    const env = item({ diagnosis: diagnosed('ENV', 0.8, 'rules rules-9'), source: 'rules rules-9' });
    const said = whyNothingWasFiled([env], []);
    assert.doesNotMatch(said, /What would change this/, 'nothing to change: there was no bug');
  });
});
