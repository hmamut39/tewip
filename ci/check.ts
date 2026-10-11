// GitHub Action "check" mode (see action.yml): run the verdict verbs in CI.
//
// Until this existed, the Action could do three things - triage a failed run, build the team report,
// and narrow a test run - and six of Tewip's strongest commands could not be reached from CI at all:
// `access`, `schema`, `vouch`, `standards`, `done` and `perf`. That is the wrong way round. CI is where
// a team actually adopts a tool; a migration reader that only runs on somebody's laptop reads very few
// migrations.
//
// One step runs as many checks as a team asks for:
//
//   - uses: hmamut39/tewip@v1
//     with:
//       mode: check
//       checks: schema, access, vouch
//       gate: blocking
//
// Three decisions worth stating, because each is the difference between a check a team keeps and one
// they switch off:
//
//   - **Every check always runs.** One failing does not stop the next, so a pull request gets the whole
//     picture in one go rather than one problem per push.
//   - **The gate is narrower than the report.** `gate: blocking` fails the job only on what the verb
//     itself calls blocking; everything else is reported and does not break the build. A gate that
//     fires on advice teaches a team to pass `continue-on-error`, and then it never fires at all.
//   - **A check Tewip cannot run says so and does not fail the job.** No migrations in the diff is not
//     a pass and not a failure; it is nothing to report, and silently green is how a tool gets trusted
//     for the wrong reason.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readCiContext, type CiContext } from './context.ts';
import { GitHub } from './github.ts';

const NL = String.fromCharCode(10);

/** What each check is called, which verb runs it, and how it is argued in CI. */
interface Check {
  id: string;
  title: string;
  verb: string;
  /** Arguments that make sense on a pull request, where the diff is what matters. */
  args: (ctx: CiContext, range: string) => string[];
  /** Why there might be nothing to do, so an empty answer is explained rather than counted as a pass. */
  nothingToDo: RegExp;
}

export const CHECKS: readonly Check[] = [
  {
    id: 'done',
    title: 'Is this work done?',
    verb: 'done',
    args: (_ctx, range) => ['--diff', range],
    nothingToDo: /cannot say/i,
  },
  {
    id: 'schema',
    title: 'What will this migration do to a live database?',
    verb: 'schema',
    args: (_ctx, range) => ['--diff', range],
    nothingToDo: /No migration or schema file in this change/i,
  },
  {
    id: 'standards',
    title: "Does this keep the team's own standards?",
    verb: 'standards',
    args: (_ctx, range) => ['--diff', range],
    nothingToDo: /has taught Tewip nothing yet/i,
  },
  {
    id: 'vouch',
    title: 'Could these tests ever fail?',
    verb: 'vouch',
    args: (ctx) => (ctx.testsDir ? [ctx.testsDir] : []),
    nothingToDo: /0 test\(s\) read/i,
  },
  {
    id: 'access',
    title: 'Can everybody use this?',
    verb: 'access',
    args: () => [],
    nothingToDo: /Read 0 markup files/i,
  },
  {
    id: 'perf',
    title: 'Is this change slower?',
    verb: 'perf',
    // Needs a report to read, which only the workflow knows the path of.
    args: () => [process.env.TEWIP_PERF_REPORT ?? ''],
    nothingToDo: /is not JSON|not a k6 summary|not a Lighthouse report/i,
  },
];

export interface Ran {
  check: Check;
  report: string;
  /** The verb's own exit code under --strict: non-zero is what it calls blocking. */
  blocking: boolean;
  /** Nothing in this change for it to look at. */
  idle: boolean;
}

/** The checks a workflow asked for, in the order they were asked for, ignoring names Tewip has no verb for. */
export function chosenChecks(asked: string): { checks: Check[]; unknown: string[] } {
  const names = asked
    .split(/[,\s]+/)
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return { checks: [CHECKS[0]], unknown: [] };
  const checks: Check[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    if (name === 'all') {
      for (const c of CHECKS) if (!checks.includes(c)) checks.push(c);
      continue;
    }
    const found = CHECKS.find((c) => c.id === name);
    if (found) {
      if (!checks.includes(found)) checks.push(found);
    } else unknown.push(name);
  }
  return { checks, unknown };
}

function runCheck(ctx: CiContext, check: Check, range: string, gate: boolean): Ran {
  const entry = join(import.meta.dirname, '..', 'cli', 'tewip.ts');
  const args = [entry, check.verb, ...check.args(ctx, range).filter((a) => a !== ''), ...(gate ? ['--strict'] : [])];
  const ran = spawnSync(process.execPath, args, {
    cwd: ctx.workspace,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (ran.error) {
    return { check, report: `Tewip could not run \`${check.verb}\`: ${ran.error.message}`, blocking: false, idle: true };
  }
  const report = `${ran.stdout ?? ''}`.trim();
  const idle = report === '' || check.nothingToDo.test(report);
  // A check with nothing to look at never fails the job, whatever its exit code.
  return { check, report, blocking: gate && !idle && ran.status !== 0, idle };
}

/** The one comment a pull request gets, however many checks ran. */
export function renderChecks(ran: Ran[], unknown: string[]): string {
  const blocking = ran.filter((r) => r.blocking);
  const lines = ['## Tewip', ''];

  lines.push(
    blocking.length > 0
      ? `**${blocking.length} of ${ran.length} checks found something blocking.**`
      : `**${ran.length} ${ran.length === 1 ? 'check' : 'checks'} ran, nothing blocking.**`,
    '',
  );

  for (const r of ran) {
    const mark = r.blocking ? 'blocking' : r.idle ? 'nothing to check' : 'ran, nothing blocking';
    lines.push(`<details${r.blocking ? ' open' : ''}>`, `<summary><b>${r.check.title}</b> — ${mark}</summary>`, '');
    lines.push(r.idle && r.report === '' ? '_Nothing in this change for it to look at._' : r.report, '', '</details>', '');
  }

  if (unknown.length > 0) {
    lines.push(
      `Tewip has no check called ${unknown.map((u) => `\`${u}\``).join(', ')}. It has: ` +
        `${CHECKS.map((c) => `\`${c.id}\``).join(', ')}, or \`all\`.`,
      '',
    );
  }
  lines.push('', '_Every answer above says what it did not check. Nothing here is a claim that the change is correct._');
  return lines.join(NL);
}

async function main(): Promise<void> {
  const ctx = readCiContext();
  mkdirSync(ctx.outDir, { recursive: true });

  const { checks, unknown } = chosenChecks(process.env.TEWIP_CHECKS ?? '');
  for (const name of unknown) console.error(`[tewip] no check called "${name}"`);
  const gate = ctx.gate === 'blocking';

  // The same range pick as pick mode: a pull request against its base, a branch against the default.
  const base = ctx.pr?.baseRef ?? ctx.defaultBranch;
  const range = `origin/${base}...HEAD`;

  const ran: Ran[] = [];
  for (const check of checks) {
    console.log(`[tewip] ${check.id}: ${check.title}`);
    // Deliberately not stopping at the first blocking one: a pull request should get the whole
    // picture in one push, not one problem at a time.
    const result = runCheck(ctx, check, range, gate);
    ran.push(result);
    writeFileSync(join(ctx.outDir, `${check.id}.md`), `${result.report}${NL}`, 'utf8');
  }

  const body = renderChecks(ran, unknown);
  if (ctx.stepSummary) appendFileSync(ctx.stepSummary, `${body.slice(0, 900_000)}${NL}${NL}`, 'utf8');
  writeFileSync(join(ctx.outDir, 'checks.md'), `${body}${NL}`, 'utf8');

  if (ctx.postPrComment && ctx.pr && ctx.token) {
    try {
      const github = new GitHub(ctx.token, ctx.apiUrl, ctx.repo);
      await github.upsertComment(ctx.pr.number, '<!-- tewip-checks -->', `<!-- tewip-checks -->${NL}${body}`);
    } catch (error) {
      // A comment that cannot be posted must not fail a check that ran fine.
      console.error(`[tewip] could not post the pull request comment: ${(error as Error).message}`);
    }
  }

  const blocking = ran.filter((r) => r.blocking);
  if (blocking.length > 0) {
    console.error(`${NL}[tewip] blocking: ${blocking.map((b) => b.check.id).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
