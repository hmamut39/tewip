// The nine checks the evidence pack runs, as one list that both ways of running them share.
//
// They used to be nine inline closures inside `gather`, which was fine while there was one way to
// run them. There are now two - in this thread, or in a worker - and two copies of a list is how a
// check quietly stops being run in one of them. Twice this week something derived from a second
// copy of a fact drifted from the first, so the list lives here and nothing else has one.
//
// Each runner takes a plain job and returns plain data, because a result has to survive a
// structured clone to come back from a worker. Nothing here may return a Set, a Map, a class
// instance or a function; the test beside this clones every result to prove it.
import { findBarriers, readAccepted as readAccessAccepted } from '../access/access-command.ts';
import { scanAgent } from '../agent/scan.ts';
import { verify } from '../audit/audit.ts';
import { scanContracts } from '../contract/contract-command.ts';
import { scanIac } from '../iac/iac-command.ts';
import { inventory } from '../sbom/inventory.ts';
import { imageContents } from '../sbom/sbom-command.ts';
import { migrationsUnder } from '../schema/migration-files.ts';
import { readMigration } from '../schema/schema-command.ts';
import { scanSecrets } from '../secure/secrets.ts';
import { readAccepted, triageSecret } from '../secure/triage.ts';

export type CheckName = 'ships' | 'image' | 'infra' | 'agent' | 'access' | 'secrets' | 'schema' | 'contracts' | 'approvals' | 'accepted';

export interface CheckJob {
  root: string;
  /** The git ref API descriptions are compared against. */
  since?: string;
}

export const CHECK_RUNNERS: Record<CheckName, (job: CheckJob) => unknown> = {
  ships: ({ root }) => inventory(root),
  image: ({ root }) => imageContents(root),
  infra: ({ root }) => scanIac(root),
  agent: ({ root }) => scanAgent(root),
  access: ({ root }) => findBarriers(root),
  secrets: ({ root }) => {
    const judged = readAccepted(root);
    return scanSecrets(root).map((f) => triageSecret(f, root, judged));
  },
  schema: ({ root }) => migrationsUnder(root).map((f) => readMigration(root, f)),
  contracts: ({ root, since }) => scanContracts({ root, since }),
  approvals: ({ root }) => verify(root),
  accepted: ({ root }) => [...readAccepted(root), ...readAccessAccepted(root)],
};

/**
 * Longest first, measured rather than guessed.
 *
 * From the per-check timings in a sealed pack for n8n: `agent` took 37.9 of 66 seconds, more than
 * the other eight together. A pool that happened to start `agent` last would finish no sooner than
 * running everything in order, so the order is part of the design and not an accident of how the
 * object literal above is written.
 */
export const SLOWEST_FIRST: CheckName[] = ['agent', 'secrets', 'contracts', 'access', 'schema', 'image', 'infra', 'ships', 'approvals', 'accepted'];

/** The checks `--quick` leaves out, each with the reason the pack prints in place of an answer. */
export const WHY_SKIPPED: Partial<Record<CheckName, string>> = {
  agent: 'reading every source file for agent tools is the slowest check here',
  access: 'it reads every markup file in the repository',
  secrets: 'it reads every source file, and asks git about each candidate',
};
