// Vouching for the tests a change touched, rather than for a whole repository.
//
// This is where the question actually pays off. Nobody runs a checker over 5,000 existing tests, but
// every pull request now arrives with tests an agent wrote, and the reviewer has minutes. So the
// review and the CI comment ask only about the test files in the diff, and say nothing at all when
// there is nothing to say - a section that appears on every PR to report "all fine" is a section
// people learn to scroll past.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANNOT_FAIL, vouchFile, type Judgement } from './vouch.ts';

export interface ChangedTests {
  /** Test files in the change that Tewip could read. */
  files: number;
  read: number;
  cannotFail: Judgement[];
  crashOnly: Judgement[];
}

export function vouchChanged(root: string, changed: string[]): ChangedTests {
  const out: ChangedTests = { files: 0, read: 0, cannotFail: [], crashOnly: [] };
  for (const file of changed) {
    const full = join(root, file);
    if (!existsSync(full)) continue; // deleted in this change, so there is nothing to read
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const vouched = vouchFile(file.split('\\').join('/'), text);
    if (vouched.judgements.length === 0) continue;
    out.files += 1;
    out.read += vouched.judgements.length;
    out.cannotFail.push(...vouched.judgements.filter((j) => CANNOT_FAIL.includes(j.verdict)));
    out.crashOnly.push(...vouched.judgements.filter((j) => j.verdict === 'crash-only'));
  }
  return out;
}

/**
 * The section for a review or a PR comment. Empty when every test in the change can fail: silence is
 * the right report, and it keeps the finding worth reading when it does appear.
 */
export function changedTestLines(seen: ChangedTests): string[] {
  if (seen.cannotFail.length === 0 && seen.crashOnly.length === 0) return [];
  const lines: string[] = [`## Tests in this change that cannot fail (${seen.cannotFail.length} of ${seen.read})`, ''];
  if (seen.cannotFail.length === 0) lines.length = 0;

  for (const j of seen.cannotFail.slice(0, 10)) {
    lines.push(`- **${j.name}** — \`${j.file}:${j.line}\``);
    if (j.evidence) lines.push(`  - \`${j.evidence.replace(/`/g, "'")}\``);
    lines.push(`  - ${j.why}`);
  }
  if (seen.cannotFail.length > 10) lines.push(`- …and ${seen.cannotFail.length - 10} more`);
  if (seen.cannotFail.length > 0) lines.push('', 'A test that cannot fail still passes and still counts as coverage.', '');

  if (seen.crashOnly.length > 0) {
    lines.push(
      `## Tests in this change that compare no value (${seen.crashOnly.length})`,
      '',
      'These fail if the code throws and pass whatever it returns. Sometimes that is the intention.',
      '',
      ...seen.crashOnly.slice(0, 8).map((j) => `- ${j.name} — \`${j.file}:${j.line}\``),
      ...(seen.crashOnly.length > 8 ? [`- …and ${seen.crashOnly.length - 8} more`] : []),
      '',
    );
  }
  return lines;
}
