// Phase 28: `tewip access` - the accessibility barriers that can be proved by reading the markup,
// separated from the questions only a person can answer, with everything it did not check named.
//
// Why this exists when axe, Lighthouse and pa11y already do: those tools hand a team a few hundred
// undifferentiated violations, a large share of which are not barriers at all, and the team turns
// the check off. Tewip makes exactly two kinds of statement - "this stops somebody, here is the
// element" and "only you can settle this one" - and prints the criteria it cannot reach. It needs
// no browser, no server, no network and no model, so it runs on any repository in a second.
//
// It never says a page is accessible. It says what was checked.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { sourceFiles } from '../secure/secrets.ts';
import { JS_LIKE, MARKUP, tags } from './markup.ts';
import { checkFile, type Finding } from './checks.ts';
import { readAxeReport, type BrowserFinding } from './reports.ts';
import { merge, nowChecked, pagesIn, renderBrowserSection, standardOf, stillNotChecked } from './merge.ts';
import { blocks, criterionOf, NOT_CHECKED, RULES, type Severity } from './wcag.ts';

export interface AccessCommand {
  root: string;
  out?: string;
  /** Exit non-zero when a barrier is found, for a CI gate. */
  gate?: boolean;
  /** Only this file or directory, rather than the whole repository. */
  only?: string;
  /** An axe run's JSON (Phase 29), which settles what reading markup cannot. */
  report?: string;
}

export interface AccessResult {
  barriers: Finding[];
  questions: Finding[];
  accepted: Finding[];
  filesRead: number;
  report: string;
  /** Phase 29, when a browser run was given. */
  browser?: {
    barriers: BrowserFinding[];
    questions: BrowserFinding[];
    advice: BrowserFinding[];
    /** Source findings the run supersedes, because it re-checked them on a real page. */
    superseded: Finding[];
    pages: string[];
    /** Every axe rule that ran, whatever its outcome: what the run can be said to have checked. */
    rulesRun: Set<string>;
  };
}

const ORDER: Record<Severity, number> = { blocker: 0, serious: 1, moderate: 2, minor: 3 };

/** One line per finding a person has already judged: "<rule> <file>:<line> - reason". */
export function readAccepted(root: string): Set<string> {
  const file = join(root, '.tewip', 'access-accepted.txt');
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.split(' - ')[0].trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
}

export function keyOf(f: Finding): string {
  return `${f.rule} ${f.file}:${f.line}`;
}

export function worstFirst(a: Finding, b: Finding): number {
  const sa = ORDER[RULES[a.rule]?.severity ?? 'minor'];
  const sb = ORDER[RULES[b.rule]?.severity ?? 'minor'];
  if (sa !== sb) return sa - sb;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

/** Reads every markup file under `root` and returns what the markup alone can settle. */
/**
 * Markup written to exercise code, not to be used by a person. An `<img>` with no alt in a
 * clipboard test is not a barrier to anybody, and excalidraw's test suite produced exactly that.
 */
const TEST_MARKUP = /(?:^|[\\/])(?:__tests__|__mocks__|tests?|spec|e2e|stories|fixtures?)[\\/]|\.(?:test|spec|stories|cy)\.[cm]?[jt]sx?$/i;

export function findBarriers(root: string, only?: string): { findings: Finding[]; filesRead: number } {
  const base = only ? resolve(root, only) : root;
  const all = existsSync(base) && MARKUP.test(base) ? [base] : sourceFiles(base).filter((f) => MARKUP.test(f));
  // Asking for a path by name overrides the exclusion: if you point at a fixture, you want it read.
  const files = only ? all : all.filter((f) => !TEST_MARKUP.test(relative(root, f)));
  const findings: Finding[] = [];
  let filesRead = 0;
  for (const path of files) {
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // A file too large to be hand-written is generated or minified, and accusing it helps nobody.
    if (source.length > 400_000) continue;
    filesRead++;
    const jsLike = JS_LIKE.test(path);
    // One page, rather than a file of components: only then do repeated ids land in one document.
    const isDocument = /\.html?$/i.test(path);
    findings.push(...checkFile(source, tags(source, jsLike), relative(root, path).replaceAll('\\', '/'), isDocument));
  }
  return { findings, filesRead };
}

function group(findings: Finding[]): Map<string, Finding[]> {
  const by = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = by.get(f.rule);
    if (list) list.push(f);
    else by.set(f.rule, [f]);
  }
  return by;
}

function section(title: string, findings: Finding[], lines: string[]): void {
  if (findings.length === 0) return;
  lines.push(`## ${title}`, '');
  for (const [rule, found] of group(findings)) {
    const meta = RULES[rule];
    lines.push(`### ${rule} - ${found.length} ${found.length === 1 ? 'place' : 'places'}`, '');
    lines.push(`${criterionOf(rule)}, ${meta?.severity ?? 'unrated'}.`, '');
    if (meta) lines.push(`Who it stops: ${meta.stops}.`, '');
    for (const f of found.slice(0, 20)) {
      lines.push(`- \`${f.file}:${f.line}\`  ${f.element}`);
      lines.push(`  - ${f.why}`);
      lines.push(`  - do this: ${f.next}`);
    }
    if (found.length > 20) lines.push(`- ...and ${found.length - 20} more of the same, in the JSON beside this report.`);
    lines.push('');
  }
}

export function renderAccess(result: Omit<AccessResult, 'report'>, scanned: string): string {
  const { barriers, questions, accepted, filesRead, browser } = result;
  const lines = ['# Tewip accessibility check', ''];

  lines.push(`Read ${filesRead} markup ${filesRead === 1 ? 'file' : 'files'} under \`${scanned}\`, without rendering any of them.`, '');
  if (browser) {
    lines.push(
      `Also read an axe run over ${browser.pages.length} rendered ${browser.pages.length === 1 ? 'page' : 'pages'}, ` +
        'which settles what reading markup cannot.',
      '',
    );
  }

  if (barriers.length === 0 && questions.length === 0 && !browser) {
    lines.push('No barrier was found that reading the markup can settle, and nothing needs a decision.', '');
  } else {
    const stopping = barriers.filter((f) => blocks(f.rule)).length;
    const counts = [
      `${barriers.length} ${barriers.length === 1 ? 'barrier' : 'barriers'} (${stopping} that stop somebody outright)`,
      `${questions.length} for a person to settle`,
    ];
    if (accepted.length > 0) counts.push(`${accepted.length} already accepted`);
    if (browser) {
      counts.unshift(`${browser.barriers.length} barriers the browser run proves`);
      if (browser.questions.length > 0) counts.push(`${browser.questions.length} the browser could not determine`);
    }
    lines.push(`**${counts.join(', ')}.**`, '');
  }

  if (browser) {
    renderBrowserSection('Barriers seen in the browser', browser.barriers, lines);
    renderBrowserSection('The browser could not determine these', browser.questions, lines);
  }

  section('Barriers read from the source', [...barriers].sort(worstFirst), lines);
  section('Only a person can settle these', [...questions].sort(worstFirst), lines);

  if (browser && browser.advice.length > 0) {
    // Kept out of the counts above on purpose. These are axe's own best-practice rules, which test
    // no standard: on nine real pages they were 51 of 174 findings, outnumbering every real barrier.
    // Reporting them as equals is how a team learns to ignore the whole report.
    const rules = [...new Set(browser.advice.map((f) => f.rule))].sort();
    lines.push('## Advice, not barriers', '');
    lines.push(
      `${browser.advice.length} findings come from axe rules that map to no WCAG criterion - ` +
        `${rules.join(', ')}. They are somebody's good idea rather than a standard, so they are not counted as barriers ` +
        'and never fail a build. Worth reading once; not worth a release.',
      '',
    );
  }

  if (browser && browser.superseded.length > 0) {
    lines.push('## Set aside, because the browser run checked them', '');
    lines.push(
      `${browser.superseded.length} source ${browser.superseded.length === 1 ? 'finding' : 'findings'} ` +
        'are not listed above: the axe run checked their criterion on a rendered page, so its answer is the better ' +
        'one and repeating them here would count the same barrier twice. They are in the JSON beside this report.',
      '',
    );
  }

  if (accepted.length > 0) {
    lines.push('## Already accepted', '');
    lines.push(`${accepted.length} ${accepted.length === 1 ? 'finding is' : 'findings are'} listed in \`.tewip/access-accepted.txt\`, so they are not repeated here.`, '');
  }

  // Coverage comes from every rule that ran, not from the ones that found something: a contrast
  // check that ran and passed has still checked contrast.
  const ran = browser?.rulesRun ?? new Set<string>();
  const settled = nowChecked(ran);
  const remaining = stillNotChecked(ran);

  if (settled.length > 0) {
    lines.push('## Checked here only because a browser run was given', '');
    for (const n of settled) lines.push(`- **${n.criterion}** - would otherwise be unreachable: ${n.why}`);
    lines.push('');
  }

  lines.push('## What was not checked', '');
  lines.push(
    browser
      ? 'Even with the browser run, none of the following was tested:'
      : 'This read the markup. It did not render a page, so none of the following was tested:',
    '',
  );
  for (const n of remaining) lines.push(`- **${n.criterion}** - ${n.why}`);
  if (browser) {
    lines.push('');
    lines.push(
      `The run covered ${browser.pages.length} ${browser.pages.length === 1 ? 'page' : 'pages'}. ` +
        'Nothing is known about a page it did not open, or about a state it did not reach - a dialog that was never ' +
        'opened, a form that was never submitted, an error that was never triggered.',
    );
  }
  lines.push('');
  lines.push(
    'A clean result here means these checks found nothing, not that the product is accessible. ' +
      'Roughly a third of WCAG can be judged by a machine at all' +
      (browser ? '' : ', and reading source rather than a rendered page reaches less than that') +
      '. The rest needs a person, ideally one who uses a screen reader.',
    '',
  );
  lines.push('To accept a finding, add its key to `.tewip/access-accepted.txt`, one per line, with a reason after ` - `.', '');
  return lines.join('\n');
}

export function runAccess(cmd: AccessCommand): AccessResult {
  const root = resolve(cmd.root);
  const { findings, filesRead } = findBarriers(root, cmd.only);
  const alreadyJudged = readAccepted(root);

  const accepted = findings.filter((f) => alreadyJudged.has(keyOf(f)));
  const open = findings.filter((f) => !alreadyJudged.has(keyOf(f)));

  // Phase 29: a browser run, where one was given. It is the better witness for every criterion it
  // checked, so the source findings for those criteria are set aside rather than repeated.
  const run = cmd.report ? readAxeReport(resolve(root, cmd.report)) : undefined;
  const graded = run ? merge(open, run, root) : undefined;
  const kept = graded ? graded.kept : open;

  const barriers = kept.filter((f) => f.confidence === 'barrier');
  const questions = kept.filter((f) => f.confidence === 'ask-a-person');

  const browser =
    run && graded
      ? {
          barriers: run.findings.filter((f) => f.confidence === 'barrier'),
          questions: run.findings.filter((f) => f.confidence === 'ask-a-person'),
          advice: run.findings.filter((f) => f.confidence === 'advice'),
          superseded: graded.superseded,
          pages: pagesIn(run),
          rulesRun: run.rulesRun,
        }
      : undefined;

  const result = { barriers, questions, accepted, filesRead, ...(browser ? { browser } : {}) };
  const report = renderAccess(result, cmd.only ? resolve(root, cmd.only) : root);
  console.log(report);

  // What fails a build is deliberately narrower than what gets reported. A question never fails it:
  // a build that breaks because something needs a human decision teaches a team to stop asking. Nor
  // does a moderate finding - bootstrap's example pages skip a heading level, which is worth knowing
  // and not worth blocking a release over. Only the barriers that stop somebody outright.
  // A browser barrier counts the same way: axe saw it on a rendered page, which is stronger
  // evidence than reading source, not weaker. Advice never counts, whatever axe's impact says.
  const blocking = barriers.filter((f) => blocks(f.rule)).length + (browser?.barriers.filter((f) => f.severity === 'blocker').length ?? 0);
  if (cmd.gate && blocking > 0) {
    const found = barriers.length + (browser?.barriers.length ?? 0);
    console.error(`${String.fromCharCode(10)}${blocking} accessibility barrier(s) that stop somebody outright, out of ${found} found.`);
    process.exitCode = 1;
  }

  if (cmd.out) {
    const path = resolve(root, cmd.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report, 'utf8');
    writeFileSync(path.replace(/\.md$/, '') + '.json', JSON.stringify({ barriers, questions, accepted, filesRead }, null, 2), 'utf8');
  }

  return { ...result, report };
}
