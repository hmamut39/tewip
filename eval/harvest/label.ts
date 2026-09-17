// Turns data/real/<dataset>/evidence.jsonl into ground-truth labels using explicit,
// evidence-based rules. Written BEFORE looking at the pipeline's answers on this data.
// Anything the evidence can't settle is excluded (and counted), never guessed.
// Usage: node eval/harvest/label.ts [dataset] [labels out] [warm-up end]
// The EXCLUDED and MANUAL lists hold project-specific decisions (so far from Gutenberg).
//   defaults: gutenberg  eval/ground-truth.jsonl  2026-09-08T01:00:00Z
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastCall } from '../../engine/autofix/locate.ts';
import { extractLocator } from '../../engine/error-parse.ts';
import { locatorWords, ROLE_WORDS } from '../../engine/similarity.ts';
import { summarizeTrace } from '../../engine/trace/trace-summary.ts';
import { PROJECT_ROOT, readJsonl, readTriageRecords } from '../../reporters/store.ts';
import type { RootCause, TriageRecord } from '../../reporters/types.ts';
import type { GroundTruthLabel } from '../evaluate.ts';
import type { Evidence } from './evidence.ts';

const DATASET = process.argv[2] ?? 'gutenberg';
const OUT_FILE = process.argv[3] ?? 'eval/ground-truth.jsonl';
/** Cases need some history before them: skip the first hour of the harvested window. */
const WARM_UP_UNTIL = process.argv[4] ?? '2026-09-08T01:00:00Z';
/** One PR broke 163 tests in a single run; cap it so one root cause can't dominate. */
const MAX_CASES_PER_RUN = 10;
const LABELED_BY = 'claude (from CI evidence: retries, later runs, fix diffs)';

const NETWORK = /socket hang up|apiRequestContext\.\w+: Timeout|ECONNRESET|ECONNREFUSED/;
const UI_RACE =
  /^(TimeoutError: locator\.(click|fill|dragTo|waitFor)|Error: expect\(locator\)\.(toBeVisible|toHaveCount|toBeChecked|toBeFocused|toHaveValue|toBeDisabled|toContainText|toHaveText)\(|Error: expect\(received\)\.(toBe|toMatchObject)\(|Error: locator\.evaluate: Error: The selection change event listener|Error: locator\.check: Clicking the checkbox did not change its state)/;

/** Clusters the evidence cannot settle, with the reason they are left out. */
const EXCLUDED: Array<{ test: RegExp; error?: RegExp; reason: string }> = [
  { test: /single-file-placeholder-drop/, reason: 'media found after a "uploads nothing" test: leftover data or an intermittent app upload race, cannot tell' },
  { test: /collaboration-stress/, reason: 'stress test with performance thresholds: slow runner (ENV) vs race (TIMING) unclear' },
  { test: /.*/, error: /resolveLink\d* is not a function/, reason: 'intermittent TypeError: app loading race vs real bug unclear' },
  { test: /.*/, error: /toMatchSnapshot|strict mode violation|should select all blocks/, reason: 'snapshot / ambiguous intermittent failure' },
];

/** Manual decisions from reading the fix diffs (fixed-by-test-change cases). */
const MANUAL: Array<{ test: RegExp; label: RootCause | null; note: string }> = [
  { test: /user-global-styles-revisions\.spec\.js > Style Revisions > should close the revisions panel/, label: 'LOCATOR_DRIFT', note: 'button still exists but its name changed from "Apply the selected revision to your site." to "Reset"; fix only updated the locator' },
  { test: /block-bindings\/post-meta\.spec\.js/, label: null, note: 'Settings tab was removed on purpose; fix deleted the step. Outdated test: no matching category in the taxonomy' },
  { test: /list\.spec\.js > List \(@firefox\) > should outdent an empty middle item/, label: 'LOCATOR_DRIFT', note: '"Add default block" still exists but its role changed from document to button; fix only changed the role in the locator' },
  { test: /navigation\.spec\.js > .*can add a page link to an empty link field/, label: 'LOCATOR_DRIFT', note: 'locator started matching 2 elements after a similarly named element appeared; fix only made the name match exact' },
  { test: /undo\.spec\.js > undo > should be able to undo and redo property cross property changes/, label: 'TIMING', note: 'app now merges title edits made within a second into one undo level; fix only added a wait between the edits' },
  { test: /preview\.spec\.js > Preview > /, label: 'LOCATOR_DRIFT', note: 'preview dropdown was refactored; fix only replaced the "Preview in new tab" locator' },
  { test: /post-summary\.spec\.js > .*sets the description of a custom template/, label: 'TEST_DATA', note: 'setup created the template as a WordPress suggestion, so it was not custom and the description field was hidden; fix only changed how the test creates its data' },
];

/**
 * Label rule v2 (added 2026-09-14 after reviewing disagreements, applied to every case):
 * a third-party service the test depends on failed during the test, per its own trace.
 * v1 labelled these TIMING because it never looked at the trace.
 */
function traceFailures(record: TriageRecord | undefined): { external: string | null; serverError: string | null } {
  const trace = record?.attachments.find((a) => a.name === 'trace')?.path;
  if (!trace) return { external: null, serverError: null };
  try {
    const failed = summarizeTrace(join(PROJECT_ROOT, trace)).network.failed;
    const show = (f: { method: string; url: string; status: number | null } | undefined) => (f ? `${f.method} ${f.url} ${f.status ?? 'no response'}` : null);
    return {
      external: show(failed.find((f) => !/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(f.url))),
      // Label rule v3 (2026-09-17): the app's own backend answered with a server error.
      serverError: show(failed.find((f) => f.status !== null && f.status >= 500)),
    };
  } catch {
    return { external: null, serverError: null };
  }
}

/** Label rule v3: tests colliding on shared data (e.g. two tests creating the same record). */
const DATA_COLLISION = /duplicate key value violates unique constraint|UNIQUE constraint failed|already exists/i;
/** Label rule v3: a test-level timeout, i.e. the awaited state did not arrive in time on this attempt. */
const TEST_TIMEOUT = /^Test timeout of \d+ms exceeded/;

const LOCATOR_CALL = /(?:locator|getBy(?:Role|Text|Label|TestId|Placeholder|Title|AltText))\((?:[^()]|\([^()]*\))*\)/g;
const squash = (s: string) => s.replaceAll('"', "'").replace(/\s+/g, '');

/**
 * Label rule v4 (2026-09-17): the fix removed the failing locator and added a locator for the
 * same element: the two share a content word, e.g. getByRole('button', { name: 'Edit' }) became
 * { name: 'Edit link' }. A step removed without a replacement (an outdated test) does not count,
 * nor does a replacement that only shares a role word such as "button".
 */
function renamedLocator(e: Evidence, record: TriageRecord | undefined): { from: string; to: string } | null {
  const printed = record ? extractLocator(record.errorMessage) : null;
  if (!e.specPatch || !printed) return null;
  const failing = lastCall(printed);
  const key = squash(failing).replace(/^(?:locator|getBy\w+)\(/, '').replace(/\)$/, '').slice(0, 40);
  const lines = e.specPatch.split('\n');
  const removed = squash(lines.filter((l) => l.startsWith('-')).join(''));
  const addedLines = lines.filter((l) => l.startsWith('+'));
  if (!key || !removed.includes(key) || squash(addedLines.join('')).includes(key)) return null;

  const contentWords = (call: string) => new Set(locatorWords(call).tokens.filter((t) => !ROLE_WORDS.has(t)));
  const old = contentWords(failing);
  for (const line of addedLines) {
    for (const [call] of line.matchAll(LOCATOR_CALL)) {
      if ([...contentWords(call)].some((w) => old.has(w))) return { from: failing, to: call.replace(/\s+/g, ' ') };
    }
  }
  return null;
}

function decide(e: Evidence, record: TriageRecord | undefined): { label: RootCause; note: string } | { excluded: string } {
  const error = e.errorHead.split(' | ')[0];
  const excluded = EXCLUDED.find((x) => x.test.test(e.testId) && (!x.error || x.error.test(e.errorHead)));

  if (e.basis === 'passed-on-retry' || e.basis === 'recurs-on-unrelated-branches') {
    const why = e.basis === 'passed-on-retry' ? 'passed on a retry of the same code' : 'fails on unrelated branches and passes elsewhere';
    if (NETWORK.test(e.errorHead)) return { label: 'ENV', note: `${why}; the test lost its connection to the WordPress test server (${error.slice(0, 60)})` };
    const trace = traceFailures(record);
    if (trace.external) return { label: 'ENV', note: `${why}; a third-party service the test depends on failed during the test (${trace.external})` };
    if (record && DATA_COLLISION.test(record.errorMessage)) {
      return { label: 'TEST_DATA', note: `${why}; tests collided on shared data (${record.errorMessage.match(DATA_COLLISION)?.[0]})` };
    }
    if (trace.serverError) return { label: 'ENV', note: `${why}; the backend returned a server error during the test (${trace.serverError})` };
    if (excluded) return { excluded: excluded.reason };
    const assertion = record ? /expect\((locator|received|page)\)/.test(record.errorMessage) : false;
    if (UI_RACE.test(error) || TEST_TIMEOUT.test(error) || assertion) {
      return { label: 'TIMING', note: `${why}; a wait or assertion that succeeds on another attempt: a race` };
    }
    return { excluded: `non-deterministic, error type not covered by a labelling rule: ${error.slice(0, 60) || '(empty error)'}` };
  }
  if (e.basis === 'fixed-by-test-change' || e.basis === 'fixed-by-mixed-change') {
    const manual = MANUAL.find((m) => m.test.test(e.testId));
    if (manual) return manual.label ? { label: manual.label, note: manual.note } : { excluded: manual.note };
    const renamed = renamedLocator(e, record);
    if (renamed) return { label: 'LOCATOR_DRIFT', note: `the fix replaced the failing locator ${renamed.from} with ${renamed.to}, a locator for the same element` };
  }
  if (e.basis === 'fixed-by-test-change') {
    const manual = MANUAL.find((m) => m.test.test(e.testId));
    if (!manual) return { excluded: 'test-change fix not reviewed' };
    return manual.label ? { label: manual.label, note: manual.note } : { excluded: manual.note };
  }
  if (e.basis === 'fixed-by-app-change') {
    const s = e.stats;
    if (s.failedBranches === 1 && s.failuresHere === s.attemptsHere && s.attemptsHere >= 2) {
      return { label: 'REAL_BUG', note: `every attempt failed (${s.failuresHere}/${s.attemptsHere}), only on this branch; passed after app-only changes with the spec untouched` };
    }
    return { excluded: 'app change fixed it, but the test also failed elsewhere or passed a retry' };
  }
  return { excluded: e.basis === 'unresolved' ? 'no later passing run on the branch in the window' : 'fix mixed app and test changes' };
}

function main(): void {
  const evidence = readJsonl<Evidence>(join(PROJECT_ROOT, 'data/real', DATASET, 'evidence.jsonl'))
    .filter((e) => e.stats.createdAt >= WARM_UP_UNTIL)
    .sort((a, b) => a.runId.localeCompare(b.runId) || a.testId.localeCompare(b.testId));

  const labels: Array<GroundTruthLabel & { basis: string }> = [];
  const exclusions: Record<string, number> = {};
  const perRun = new Map<string, Evidence[]>();
  for (const e of evidence) perRun.set(e.runId, [...(perRun.get(e.runId) ?? []), e]);

  const records = readTriageRecords(join(PROJECT_ROOT, 'data/real', DATASET, 'triage.jsonl'));
  const recordOf = (e: Evidence) => records.find((r) => r.runId === e.runId && r.testId === e.testId && r.retry === e.retry);
  for (const cases of perRun.values()) {
    const decided = cases.map((e) => ({ e, d: decide(e, recordOf(e)) }));
    const labelled = decided.filter((x) => 'label' in x.d);
    // Spread the cap evenly over the run's (sorted) cases instead of taking the first ones.
    const step = Math.max(1, labelled.length / MAX_CASES_PER_RUN);
    const kept = new Set(labelled.filter((_, i) => i % step < 1).slice(0, MAX_CASES_PER_RUN));
    for (const x of decided) {
      if ('excluded' in x.d) exclusions[x.d.excluded] = (exclusions[x.d.excluded] ?? 0) + 1;
      else if (!kept.has(x)) exclusions['over the per-run cap (one root cause, many tests)'] = (exclusions['over the per-run cap (one root cause, many tests)'] ?? 0) + 1;
      else labels.push({ testId: x.e.testId, runId: x.e.runId, label: x.d.label, dataset: 'real', labeledBy: LABELED_BY, basis: x.e.basis, note: x.d.note });
    }
  }

  const target = join(PROJECT_ROOT, OUT_FILE);
  writeFileSync(target, labels.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const byLabel = labels.reduce<Record<string, number>>((m, l) => ({ ...m, [l.label]: (m[l.label] ?? 0) + 1 }), {});
  console.log(`[label] ${labels.length} labelled case(s) from ${evidence.length} after warm-up -> ${target}`);
  console.log('by label:', byLabel);
  console.log('excluded:', exclusions);
}

if (import.meta.main) main();
