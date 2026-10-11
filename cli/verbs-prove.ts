// The verbs that prove a change rather than describe it: the verdict, the project's own standards,
// what a migration does to a live database, which tests could notice a change, whether the tests would
// catch a bug, and whether a test could ever fail. Split out of cli/tewip.ts the same way the work
// verbs were, to keep every file inside this project's own 300-line rule.
import { flag } from './args.ts';

/** Runs `verb` if it is one of these, and says whether it did. */
export async function proveVerb(verb: string, args: string[]): Promise<boolean> {
  switch (verb) {
    case 'done': {
      const { runDone } = await import('../engine/verdict/verdict-command.ts');
      runDone({
        root: process.cwd(),
        diff: flag(args, 'diff') ?? 'main...HEAD',
        prove: args.includes('--prove'),
        proveBudgetSeconds: Number(flag(args, 'budget') ?? '300'),
        out: flag(args, 'out'),
        json: flag(args, 'json'),
        name: flag(args, 'name'),
        strict: args.includes('--strict'),
      });
      return true;
    }
    case 'a2a': {
      const { serveA2A } = await import('../engine/a2a/serve.ts');
      const { dirname, join } = await import('node:path');
      serveA2A({
        root: process.cwd(),
        port: Number(flag(args, 'port') ?? '41241'),
        // Loopback unless somebody asks for otherwise in so many words. The server runs commands
        // against a repository and has no authentication, so the default must be the safe one.
        host: flag(args, 'host') ?? '127.0.0.1',
        tewipRoot: join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'),
      });
      return true;
    }
    case 'perf': {
      const { runPerf } = await import('../engine/perf/perf-command.ts');
      const paths = args.filter((a, i) => !a.startsWith('--') && !['--out', '--label', '--against'].includes(args[i - 1] ?? ''));
      if (paths.length === 0) {
        console.error('tewip perf needs a k6 summary, a Lighthouse report or a JMeter .jtl.');
        console.error('  tewip perf summary.json [--record] [--label checkout]');
        console.error('  tewip perf now.jtl --against before.jtl');
        process.exitCode = 1;
        return true;
      }
      runPerf({
        root: process.cwd(),
        summary: paths[0],
        label: flag(args, 'label'),
        against: flag(args, 'against'),
        record: args.includes('--record'),
        out: flag(args, 'out'),
        gate: args.includes('--strict'),
      });
      return true;
    }
    case 'access': {
      const { runAccess } = await import('../engine/access/access-command.ts');
      const paths = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--report');
      runAccess({
        root: process.cwd(),
        only: paths[0],
        out: flag(args, 'out'),
        report: flag(args, 'report'),
        gate: args.includes('--strict'),
      });
      return true;
    }
    case 'standards': {
      const { runStandards } = await import('../engine/standards/standards-command.ts');
      runStandards({
        root: process.cwd(),
        diff: flag(args, 'diff'),
        files: args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--diff' && args[i - 1] !== '--out'),
        out: flag(args, 'out'),
        strict: args.includes('--strict'),
      });
      return true;
    }
    case 'schema': {
      const { runSchema } = await import('../engine/schema/schema-command.ts');
      runSchema({
        root: process.cwd(),
        diff: flag(args, 'diff') ?? 'main...HEAD',
        files: args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--diff' && args[i - 1] !== '--out'),
        out: flag(args, 'out'),
        strict: args.includes('--strict'),
      });
      return true;
    }
    case 'pick': {
      const { runPick } = await import('../engine/pick/pick-command.ts');
      runPick({
        root: process.cwd(),
        diff: flag(args, 'diff') ?? 'main...HEAD',
        files: args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--diff' && args[i - 1] !== '--out' && args[i - 1] !== '--recent' && args[i - 1] !== '--name'),
        out: flag(args, 'out'),
        list: args.includes('--list'),
        recentRuns: Number(flag(args, 'recent') ?? '5'),
        name: flag(args, 'name'),
      });
      return true;
    }
    case 'prove': {
      const paths = args.filter((a, i) => !a.startsWith('--') && !['--out', '--diff', '--limit', '--budget'].includes(args[i - 1] ?? ''));
      const { runProve } = await import('../engine/prove/prove-command.ts');
      runProve({
        root: process.cwd(),
        files: paths,
        diff: flag(args, 'diff'),
        limit: Number(flag(args, 'limit') ?? '6'),
        budgetSeconds: Number(flag(args, 'budget') ?? '600'),
        out: flag(args, 'out'),
        strict: args.includes('--strict'),
      });
      return true;
    }
    case 'vouch': {
      const paths = args.filter((a, i) => !a.startsWith('--') && !['--out', '--json'].includes(args[i - 1] ?? ''));
      const { runVouch } = await import('../engine/vouch/run-vouch.ts');
      runVouch({ root: process.cwd(), paths: paths.length > 0 ? paths : ['.'], out: flag(args, 'out'), json: flag(args, 'json'), strict: args.includes('--strict') });
      return true;
    }
    default:
      return false;
  }
  return true;
}
