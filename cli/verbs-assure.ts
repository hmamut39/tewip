// The verbs that produce evidence rather than a judgement: what shipped and under which licence,
// what the containers let in, who ran what, the same page across forty repositories, the signed
// attestation, and what the whole thing refuses to do.
//
// These are the verbs an IT department reads and keeps, rather than the ones a developer runs and
// forgets, so they sit together. Split out of cli/tewip.ts the same way the work and prove verbs
// were, to keep every file inside this project's own 300-line rule.
import { flag } from './args.ts';

/** Runs `verb` if it is one of these, and says whether it did. */
export async function assureVerb(verb: string, args: string[]): Promise<boolean> {
  switch (verb) {
    case 'attest': {
      const verify = flag(args, 'verify');
      if (verify) {
        const { verifyAttestation } = await import('../engine/attest/attest-command.ts');
        const { ok, report } = verifyAttestation(verify, flag(args, 'key'));
        console.log(report);
        if (!ok) process.exitCode = 1;
        return true;
      }
      const { runAttest } = await import('../engine/attest/attest-command.ts');
      runAttest({ root: process.cwd(), name: flag(args, 'name'), runId: flag(args, 'run'), out: flag(args, 'out'), json: flag(args, 'json') });
      return true;
    }
    case 'agent': {
      const { runAgent } = await import('../engine/agent/agent-command.ts');
      runAgent({ root: args.find((a) => !a.startsWith('--')) ?? process.cwd(), out: flag(args, 'out'), gate: args.includes('--gate') });
      return true;
    }
    case 'contract': {
      const { runContract } = await import('../engine/contract/contract-command.ts');
      runContract({ root: args.find((a) => !a.startsWith('--')) ?? process.cwd(), since: flag(args, 'since'), out: flag(args, 'out'), gate: args.includes('--gate') });
      return true;
    }
    case 'audit': {
      const { runAudit } = await import('../engine/audit/audit-command.ts');
      runAudit({ root: args.find((a) => !a.startsWith('--')) ?? process.cwd(), all: args.includes('--all'), gate: args.includes('--gate') });
      return true;
    }
    case 'portfolio': {
      const { runPortfolio } = await import('../engine/portfolio/portfolio-command.ts');
      runPortfolio({ root: args.find((a) => !a.startsWith('--')) ?? process.cwd(), out: flag(args, 'out'), quick: args.includes('--quick') });
      return true;
    }
    case 'infra': {
      const { runIac } = await import('../engine/iac/iac-command.ts');
      // A folder argument, like `portfolio` and `agent` take. Without this, `tewip infra ~/work/api`
      // silently read the current directory and reported on the wrong repository - the kind of
      // wrong answer that looks exactly like a right one.
      runIac({ root: args.find((a) => !a.startsWith('--')) ?? process.cwd(), out: flag(args, 'out'), gate: args.includes('--gate') });
      return true;
    }
    case 'sbom': {
      const { runSbom } = await import('../engine/sbom/sbom-command.ts');
      runSbom({ root: args.find((a) => !a.startsWith('--')) ?? process.cwd(), out: flag(args, 'out'), gate: args.includes('--gate') });
      return true;
    }
    case 'safety': {
      const { runSafety } = await import('../engine/safety/safety-command.ts');
      runSafety({ root: process.cwd(), out: flag(args, 'out') });
      return true;
    }
    default:
      return false;
  }
}
