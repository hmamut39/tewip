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
      return;
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
      return;
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
      return;
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
      return;
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
      return;
    }
    case 'vouch': {
      const paths = args.filter((a, i) => !a.startsWith('--') && !['--out', '--json'].includes(args[i - 1] ?? ''));
      const { runVouch } = await import('../engine/vouch/run-vouch.ts');
      runVouch({ root: process.cwd(), paths: paths.length > 0 ? paths : ['.'], out: flag(args, 'out'), json: flag(args, 'json'), strict: args.includes('--strict') });
      return;
    }
    default:
      return false;
  }
  return true;
}
