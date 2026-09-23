// Phase 10: QA departments keep their test cases in a test-management tool, not in a folder of
// JSON. The two most common on top of Jira are Xray and Zephyr, and both import a CSV where each
// row is one step of one test. Tewip writes that file; importing it stays a person's decision, and
// both importers let a person map the columns, so a name that differs slightly costs nothing.
//
// No account, no token, no network: this is a file on disk, which is also why it can be tested.
import type { Plan } from '../quality/plan.ts';

type Scenario = Plan['scenarios'][number];

/** One cell of a CSV, quoted the way every spreadsheet and importer expects. */
export function cell(value: string): string {
  const text = String(value ?? '').replace(/\r?\n/g, '\n');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const row = (cells: string[]): string => cells.map(cell).join(',');

/** Xray's manual-test import: the test is repeated on every step row, as its importer expects. */
export function toXrayCsv(plan: Plan, feature: string): string {
  const header = ['Issue ID', 'Summary', 'Description', 'Test Type', 'Action', 'Data', 'Expected Result', 'Priority', 'Labels'];
  const lines = [row(header)];
  for (const s of plan.scenarios) {
    const steps = s.steps.length > 0 ? s.steps : ['(see the expected result)'];
    steps.forEach((step, index) => {
      lines.push(
        row([
          s.id,
          index === 0 ? `${s.id} ${s.title}` : '',
          index === 0 ? describe(s, feature) : '',
          index === 0 ? 'Manual' : '',
          step,
          index === 0 ? s.preconditions : '',
          index === steps.length - 1 ? s.expected : '',
          index === 0 ? priority(s.priority) : '',
          index === 0 ? `tewip ${s.type}` : '',
        ]),
      );
    });
  }
  return lines.join('\n');
}

/** Zephyr Scale's test-case import, whose columns are named differently for the same idea. */
export function toZephyrCsv(plan: Plan, feature: string): string {
  const header = ['Name', 'Objective', 'Precondition', 'Priority', 'Status', 'Labels', 'Folder', 'Step', 'Test Data', 'Expected Result'];
  const lines = [row(header)];
  for (const s of plan.scenarios) {
    const steps = s.steps.length > 0 ? s.steps : ['(see the expected result)'];
    steps.forEach((step, index) => {
      lines.push(
        row([
          index === 0 ? `${s.id} ${s.title}` : '',
          index === 0 ? describe(s, feature) : '',
          index === 0 ? s.preconditions : '',
          index === 0 ? priority(s.priority) : '',
          index === 0 ? 'Draft' : '',
          index === 0 ? `tewip,${s.type}` : '',
          index === 0 ? `/${feature.replace(/[^\w -]+/g, '').slice(0, 60)}` : '',
          step,
          '',
          index === steps.length - 1 ? s.expected : '',
        ]),
      );
    });
  }
  return lines.join('\n');
}

const PRIORITY: Record<string, string> = { P0: 'High', P1: 'Medium', P2: 'Low' };
const priority = (p: string): string => PRIORITY[p] ?? 'Medium';

/** What the case is for, and where it came from, so a reviewer can judge it. */
function describe(s: Scenario, feature: string): string {
  return [
    s.title,
    `Feature: ${feature}`,
    `Type: ${s.type}`,
    s.grounded_on ? `Grounded on: ${s.grounded_on}` : '',
    s.covered_by ? `Already covered by: ${s.covered_by}` : 'Not covered by an existing test.',
    'Drafted by Tewip; review before you rely on it.',
  ]
    .filter(Boolean)
    .join('\n');
}

export type ExportFormat = 'xray' | 'zephyr';

export function exportTestCases(plan: Plan, feature: string, format: ExportFormat): string {
  return format === 'xray' ? toXrayCsv(plan, feature) : toZephyrCsv(plan, feature);
}

/** What to tell the person after writing the file, since importing is their step, not Tewip's. */
export function importHint(format: ExportFormat, file: string): string {
  return format === 'xray'
    ? `Written to ${file}. In Jira: Xray > Import > Tests from CSV, and check the column mapping on the first screen.`
    : `Written to ${file}. In Jira: Zephyr Scale > Test Cases > Import > CSV, and check the column mapping on the first screen.`;
}
