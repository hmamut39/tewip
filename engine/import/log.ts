// When a CI job dies before any test report is written, there is nothing for the importer to read:
// no tests ran, so Tewip has nothing to diagnose and, until now, said nothing at all. The job log is
// still there, though, and it usually says plainly what happened - an image that would not pull, a
// runner out of disk, a service container that never became healthy, a step killed for memory.
// This reads that log and reports the cause in the same words as a failing test's environment
// diagnosis, so a team is told "your CI broke, here is why" instead of being left with a red X.
import { deviceEnvSignal } from '../device-errors.ts';
import { networkSignal } from '../error-parse.ts';
import { INFRA_MEANING, infraSignal } from '../infra-errors.ts';

export interface LogDiagnosis {
  /** What broke, in plain words. */
  meaning: string;
  /** The line that shows it, trimmed. */
  quote: string;
  /** 1-based line number in the log. */
  line: number;
  confidence: number;
  /** The reader that recognised it, for the evidence trail. */
  source: 'infrastructure' | 'network' | 'device' | 'runner';
}

/** Failures of the job itself, which no per-test reader covers. */
const RUNNER_PATTERNS: Array<{ meaning: string; confidence: number; pattern: RegExp }> = [
  { meaning: 'the job was cancelled or the runner was shut down', confidence: 0.9, pattern: /The runner has received a shutdown signal|The operation was canceled|Received request to deprovision/i },
  { meaning: 'the job ran past its time limit', confidence: 0.9, pattern: /has exceeded the maximum execution time|The job running on runner [^\n]*has exceeded|Job is about to be cancelled after exceeding/i },
  { meaning: 'a step was killed for using too much memory', confidence: 0.75, pattern: /Process completed with exit code 137\b|Killed\s*$|JavaScript heap out of memory/im },
  { meaning: 'the runner lost contact with the service', confidence: 0.85, pattern: /The self-hosted runner[^\n]*lost communication|Runner connect error|The hosted runner[^\n]*lost communication/i },
  { meaning: 'a package registry could not be reached', confidence: 0.85, pattern: /npm ERR!\s*network|ECONNRESET[^\n]*registry\.npmjs\.org|Could not resolve dependencies[^\n]*Connection (?:timed out|refused)|Failed to download metadata for repo/i },
  { meaning: 'a service container never became healthy', confidence: 0.88, pattern: /Failed to initialize container[^\n]*|service container [^\n]*is unhealthy|Waiting for all services to be ready[\s\S]{0,200}?failed/i },
];

/** A line worth quoting: short enough to read, with its indentation and timestamps trimmed. */
const tidy = (line: string) => line.replace(/^\s*(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*)?/, '').trim().slice(0, 200);

/**
 * Why the job died, read from its log, or null when nothing recognisable is there. The first match
 * wins, and infrastructure is checked before the general network reader because "could not pull the
 * image" is more useful than "a connection failed".
 */
export function diagnoseLog(log: string): LogDiagnosis | null {
  const lines = log.split('\n');
  for (const [i, line] of lines.entries()) {
    const infra = infraSignal(line);
    if (infra) return { meaning: INFRA_MEANING[infra.kind], quote: tidy(line), line: i + 1, confidence: infra.confidence, source: 'infrastructure' };
    for (const { meaning, confidence, pattern } of RUNNER_PATTERNS) {
      if (pattern.test(line)) return { meaning, quote: tidy(line), line: i + 1, confidence, source: 'runner' };
    }
    const device = deviceEnvSignal(line);
    if (device) return { meaning: `a mobile device problem: ${device.match}`, quote: tidy(line), line: i + 1, confidence: device.confidence, source: 'device' };
    const network = networkSignal(line);
    if (network) return { meaning: `a ${network.kind} problem reaching a dependency`, quote: tidy(line), line: i + 1, confidence: network.confidence, source: 'network' };
  }
  return null;
}

/** What to show a person: the cause, the line it came from, and what to do about it. */
export function renderLogDiagnosis(found: LogDiagnosis | null, where: string): string {
  if (!found) {
    return [
      `## Tewip: the job failed before any test report was written`,
      '',
      `No test report was produced, and nothing in ${where} names a cause Tewip recognises. Look at the`,
      'job log itself: the failure happened before or around the tests, so it is not a test result.',
    ].join('\n');
  }
  return [
    `## Tewip: the job failed before any test report was written`,
    '',
    `**${found.meaning}** — this is the environment, not a test and not the change.`,
    '',
    '```',
    `${where}:${found.line}: ${found.quote}`,
    '```',
    '',
    'No test ran, so nothing can be said about the code. Fix the environment or re-run the job.',
  ].join('\n');
}
