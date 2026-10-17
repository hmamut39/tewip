// Phase 27: a team's own standards, as something Tewip can read, check and pass on.
//
// Tewip knows a great deal that is true of software in general and nothing that is true of *this*
// company. Every IT department has its own rules - "never drop a column in the release that stops
// writing to it", "locators must use data-testid", "no test may sleep", "every migration needs a
// ticket" - and until now there was nowhere to put them. A tool that cannot be taught the house rules
// is a tool that argues with the house.
//
// A standard is a markdown file in `.tewip/standards/`, written by the team, and it is deliberately
// split in two:
//
//   - **Rules Tewip can check** are listed in the front matter as `forbid:` or `require:` patterns over
//     a set of files. These are enforced, with the line quoted.
//   - **Everything else is guidance**: prose the team writes for the parts a pattern cannot capture. It
//     is passed to the model when Tewip writes or fixes something, and quoted in reports - but it is
//     never counted as checked, and never reported as a pass.
//
// That split is the whole honesty of the feature. "We have a standard" and "the standard was enforced"
// are different claims, and a tool that blurs them turns a policy document into a comfort blanket.
export interface Rule {
  kind: 'forbid' | 'require';
  /** The pattern, as the team wrote it. */
  pattern: string;
  /** Files it applies to, as glob-ish suffixes or path fragments. Empty means the standard's own scope. */
  where: string[];
  /**
   * Files the rule does **not** apply to, from a `not` clause: `in engine/ not -command.ts`.
   *
   * Every real house rule has an exception, and until this existed none could be written. This
   * project's own rule - engine code must not print, because printing corrupts the MCP stdout
   * stream - is true of every file in `engine/` except the command layer, whose job is to print. With
   * no way to say that, the only choices were a rule that reports a known-acceptable line forever or
   * no rule at all. The help text for this feature says a rule nobody enforces is worse than no
   * rule; a rule that cries wolf becomes one within a week.
   */
  except: string[];
  /** Why, in the team's words. Printed with every violation. */
  because: string;
}

export interface Standard {
  name: string;
  description: string;
  /** Files this standard is about, as path fragments or extensions. Empty means everything. */
  appliesTo: string[];
  rules: Rule[];
  /** The prose. Real guidance, never counted as checked. */
  guidance: string;
  /** Why this file could not be used, when it could not. */
  unusable: string;
}

export interface Violation {
  standard: string;
  file: string;
  line: number;
  text: string;
  rule: Rule;
}

/**
 * Reads one standard.
 *
 * The format is deliberately plain: a markdown file with a small front matter block. A team should be
 * able to write one without reading a manual, and anything Tewip cannot understand is reported as
 * unusable rather than silently ignored - a rule nobody is enforcing is worse than no rule, because
 * somebody believes in it.
 */
export function readStandard(file: string, rawText: string): Standard {
  const name = file.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? file;
  // A leading byte-order mark, which Notepad, Visual Studio and PowerShell's `Set-Content -Encoding
  // utf8` all write by default on Windows. Three invisible bytes before `---` stop the front matter
  // matching, so **every enforced rule in the file silently becomes prose** and the report says
  // "0 with rules Tewip can check" without once mentioning why. Found by accident: this project's own
  // standards file was rewritten by a PowerShell command and four working rules stopped being
  // enforced with no error anywhere. For a team on Windows that is total, silent rule loss - the
  // exact thing `unusable` exists to prevent, happening in the one place it could not report.
  const text = rawText.replace(/^﻿/, '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const body = front ? text.slice(front[0].length).trim() : text.trim();
  const standard: Standard = { name, description: '', appliesTo: [], rules: [], guidance: body, unusable: '' };
  if (!front) {
    // Prose only. That is allowed, and it is guidance - but say so, so nobody thinks it is enforced.
    standard.description = firstLine(body);
    return standard;
  }

  for (const line of front[1].split(String.fromCharCode(10))) {
    const entry = /^\s*([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!entry) continue;
    const [, key, rawValue] = entry;
    const value = rawValue.trim();
    if (key === 'name' && value) standard.name = value;
    else if (key === 'description') standard.description = value;
    else if (key === 'applies-to') standard.appliesTo = list(value);
    else if (key === 'forbid' || key === 'require') {
      const rule = parseRule(key, value, standard.appliesTo);
      if (rule) standard.rules.push(rule);
      else standard.unusable = `the ${key} on this line could not be read: ${line.trim().slice(0, 120)}`;
    }
  }
  if (!standard.description) standard.description = firstLine(body);
  return standard;
}

/**
 * `forbid: /waitForTimeout/ in tests because a fixed wait hides a race`
 *
 * The `in` clause may carry an exception: `in engine/ not -command.ts`. Everything before `not` is
 * where the rule applies, everything after it is where it does not.
 */
function parseRule(kind: 'forbid' | 'require', value: string, scope: string[]): Rule | null {
  const shape = /^\/(.+?)\/([a-z]*)\s*(?:\bin\s+([^]*?))?\s*(?:\bbecause\s+([^]*))?$/i.exec(value.trim());
  if (!shape) return null;
  try {
    new RegExp(shape[1], shape[2] || undefined); // it has to be a pattern before it is a rule
  } catch {
    return null;
  }
  const [inside, outside] = (shape[3] ?? '').split(/\bnot\b/);
  return {
    kind,
    pattern: shape[2] ? `/${shape[1]}/${shape[2]}` : shape[1],
    where: inside && inside.trim() ? list(inside) : scope,
    except: outside ? list(outside) : [],
    because: (shape[4] ?? '').trim(),
  };
}

const list = (value: string): string[] =>
  value
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((v) => v.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

const firstLine = (text: string): string => text.split(String.fromCharCode(10)).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 160) ?? '';

/** Does this file fall under that scope? A suffix, an extension, or a path fragment. */
export function covers(where: string[], file: string): boolean {
  if (where.length === 0) return true;
  const path = file.split('\\').join('/');
  return where.some((pattern) => {
    const clean = pattern.replace(/^\*\*?\//, '').replace(/\*/g, '');
    return clean !== '' && path.includes(clean);
  });
}

const regexOf = (rule: Rule): RegExp => {
  const slashed = /^\/(.+)\/([a-z]*)$/.exec(rule.pattern);
  return slashed ? new RegExp(slashed[1], slashed[2]) : new RegExp(rule.pattern);
};

/**
 * The rules this file breaks.
 *
 * `forbid` is checked line by line, so the violation can be quoted. `require` is checked over the whole
 * file, because "this file must mention X" is a statement about the file and pointing at a line would be
 * inventing a location.
 */
export function check(standards: Standard[], file: string, text: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split(String.fromCharCode(10));
  for (const standard of standards) {
    if (!covers(standard.appliesTo, file)) continue;
    for (const rule of standard.rules) {
      // `covers([])` is deliberately true - an empty scope means everything - so an exception has to
      // be checked for existence first. Written the short way, `|| covers(rule.except, file)`, every
      // rule with no exception is skipped and the report says nothing broke: a clean answer produced
      // by a bug, which is the exact shape this project keeps finding.
      if (!covers(rule.where, file) || (rule.except.length > 0 && covers(rule.except, file))) continue;
      let pattern: RegExp;
      try {
        pattern = regexOf(rule);
      } catch {
        continue;
      }
      if (rule.kind === 'forbid') {
        lines.forEach((line, index) => {
          if (pattern.test(line)) out.push({ standard: standard.name, file, line: index + 1, text: line.trim().slice(0, 160), rule });
        });
      } else if (!pattern.test(text)) {
        out.push({ standard: standard.name, file, line: 0, text: '', rule });
      }
    }
  }
  return out;
}

/** The section for a review, a pull request comment or a verdict. Empty when nothing is broken. */
export function renderViolations(violations: Violation[], loaded: Standard[]): string[] {
  if (violations.length === 0) return [];
  const lines = [`## Your own standards (${violations.length})`, ''];
  for (const v of violations.slice(0, 20)) {
    const where = v.line > 0 ? `${v.file}:${v.line}` : v.file;
    lines.push(
      v.rule.kind === 'forbid'
        ? `- **${v.standard}** — \`${where}\` has \`${v.rule.pattern}\`, which this project forbids`
        : `- **${v.standard}** — \`${where}\` does not have \`${v.rule.pattern}\`, which this project requires`,
    );
    if (v.text) lines.push(`  - \`${v.text.replace(/`/g, "'")}\``);
    if (v.rule.because) lines.push(`  - ${v.rule.because}`);
  }
  if (violations.length > 20) lines.push(`- …and ${violations.length - 20} more`);
  const guidance = loaded.filter((s) => s.guidance.trim().length > 0);
  if (guidance.length > 0) {
    lines.push(
      '',
      `${guidance.length} standard(s) also carry guidance Tewip cannot check: ${guidance.map((s) => s.name).join(', ')}. It is passed on when Tewip writes or fixes something, and it is not counted here as either kept or broken.`,
    );
  }
  lines.push('');
  return lines;
}
