// Phase 10, the parts that need no account: a bug ticket written from a real diagnosis, and test
// cases written as a file a test-management tool can import. What matters in both is restraint -
// only a failure Tewip really believes is a bug becomes a ticket, the same failure is never filed
// twice, and a file with a comma or a newline in it still parses.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TriageItem } from '../../outlets/items.ts';
import type { Plan } from '../quality/plan.ts';
import { bugBody, bugSummary, seenAgain } from '../work/bug-command.ts';
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
