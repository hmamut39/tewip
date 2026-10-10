// `tewip standards`: what this project has taught Tewip, and what of it can actually be checked.
//
// Loading is on demand and cheap: only the name and description of each standard are read until
// something needs the rest, which is the same discipline a skill file uses. The report leads with the
// split that matters - rules Tewip enforces, and guidance it can only carry - because a team that
// believes an unenforceable rule is being enforced is worse off than a team with no tool at all.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { changeSummary } from '../quality/grounding.ts';
import { check, readStandard, renderViolations, type Standard, type Violation } from './standards.ts';

export interface StandardsCommand {
  root: string;
  /** Check the files a change touched, rather than only listing what is loaded. */
  diff?: string;
  files?: string[];
  out?: string;
  /** Exit non-zero when a standard is broken. */
  strict?: boolean;
}

export const STANDARDS_DIR = join('.tewip', 'standards');

/** Every standard this project has written, newest name order, with unreadable ones reported. */
export function loadStandards(root: string): Standard[] {
  const dir = join(root, STANDARDS_DIR);
  if (!existsSync(dir)) return [];
  const out: Standard[] = [];
  for (const entry of readdirSync(dir).filter((f) => /\.(md|markdown)$/i.test(f)).sort()) {
    try {
      out.push(readStandard(entry, readFileSync(join(dir, entry), 'utf8')));
    } catch {
      out.push({ name: entry, description: '', appliesTo: [], rules: [], guidance: '', unusable: 'the file could not be read' });
    }
  }
  return out;
}

/**
 * The guidance to hand a model when writing or fixing something in this file.
 *
 * Only the standards that apply, and only their prose: the checkable rules are enforced afterwards by
 * `check`, so repeating them in a prompt would be asking politely for something that is about to be
 * verified anyway.
 */
export function guidanceFor(standards: Standard[], file: string): string {
  const relevant = standards.filter((s) => s.guidance.trim() && covers(s.appliesTo, file));
  if (relevant.length === 0) return '';
  return relevant.map((s) => `## ${s.name}${s.description ? ` - ${s.description}` : ''}${String.fromCharCode(10)}${s.guidance.trim()}`).join(String.fromCharCode(10) + String.fromCharCode(10)).slice(0, 6000);
}

const covers = (where: string[], file: string): boolean => where.length === 0 || where.some((p) => file.split('\\').join('/').includes(p.replace(/^\*\*?\//, '').replace(/\*/g, '')));

/** Violations in the files a change touched. */
export function checkChanged(root: string, standards: Standard[], files: string[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    const full = resolve(root, file);
    if (!existsSync(full)) continue;
    try {
      out.push(...check(standards, file.split('\\').join('/'), readFileSync(full, 'utf8')));
    } catch {
      // Unreadable: nothing can be said about it.
    }
  }
  return out;
}

export function renderStandards(standards: Standard[], violations: Violation[], checkedFiles: number): string {
  if (standards.length === 0) {
    return [
      '# This project has taught Tewip nothing yet',
      '',
      `Put a markdown file in \`${STANDARDS_DIR.split('\\').join('/')}/\` and Tewip will read it. For example, \`no-fixed-waits.md\`:`,
      '',
      '```markdown',
      '---',
      'description: A fixed wait hides a race instead of fixing it.',
      'applies-to: tests/, e2e/',
      'forbid: /waitForTimeout|sleep\\(/ because a fixed wait passes by luck and fails in CI',
      '---',
      '',
      'Wait for the thing you are actually waiting for - an element, a response, a state -',
      'never for a number of milliseconds.',
      '```',
      '',
      'The `forbid` and `require` lines are checked and enforced. The prose below them is guidance: Tewip',
      'passes it on when it writes or fixes something, and never claims to have verified it.',
    ].join(String.fromCharCode(10));
  }

  const checkable = standards.filter((s) => s.rules.length > 0);
  const guidanceOnly = standards.filter((s) => s.rules.length === 0 && s.guidance.trim());
  const lines = [
    '# What this project has taught Tewip',
    '',
    `${standards.length} standard(s) loaded: ${checkable.length} with rules Tewip can check, ${guidanceOnly.length} guidance only.`,
    ...(checkedFiles > 0 ? ['', `${checkedFiles} changed file(s) checked. **${violations.length}** broke a rule.`] : []),
    '',
    '## Checked and enforced',
    '',
  ];
  if (checkable.length === 0) lines.push('None. No standard here carries a `forbid:` or `require:` rule, so nothing is enforced.', '');
  for (const standard of checkable) {
    lines.push(`- **${standard.name}**${standard.description ? ` — ${standard.description}` : ''}`);
    for (const rule of standard.rules) {
      lines.push(`  - ${rule.kind} \`${rule.pattern}\`${rule.where.length > 0 ? ` in ${rule.where.join(', ')}` : ''}${rule.because ? ` — ${rule.because}` : ''}`);
    }
  }
  lines.push('');

  if (guidanceOnly.length > 0) {
    lines.push(
      '## Carried, but not checked',
      '',
      'Tewip passes these to the model when it writes or fixes something, and quotes them in reports. It',
      'cannot verify them, and it will never report them as kept.',
      '',
      ...guidanceOnly.map((s) => `- **${s.name}**${s.description ? ` — ${s.description}` : ''}`),
      '',
    );
  }

  const unusable = standards.filter((s) => s.unusable);
  if (unusable.length > 0) {
    lines.push(`## Could not be used (${unusable.length})`, '', ...unusable.map((s) => `- **${s.name}**: ${s.unusable}`), '');
  }

  lines.push(...renderViolations(violations, standards));
  lines.push(
    '---',
    '',
    'A rule is enforced only if it appears above under "checked and enforced". Everything else is prose',
    'Tewip carries for you - useful, and not the same thing as a check.',
  );
  return lines.join(String.fromCharCode(10));
}

export function runStandards(cmd: StandardsCommand): { violations: number } {
  const standards = loadStandards(cmd.root);
  const files = cmd.files && cmd.files.length > 0 ? cmd.files : cmd.diff ? (changeSummary(cmd.root, cmd.diff)?.files ?? []) : [];
  const violations = files.length > 0 ? checkChanged(cmd.root, standards, files.map((f) => f.split('\\').join('/'))) : [];
  const report = renderStandards(standards, violations, files.length);
  console.log(report);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), report + String.fromCharCode(10), 'utf8');
  }
  if (cmd.strict && violations.length > 0) {
    console.error(String.fromCharCode(10) + `${violations.length} violation(s) of this project's own standards.`);
    process.exitCode = 1;
  }
  return { violations: violations.length };
}
