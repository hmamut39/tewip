// Running `tewip agent`: scan, render, write the baseline, decide the exit code.
//
// Split out of `agent-command.ts` in Phase 196, when the capability inventory took that file past
// this project's 300-line rule. The same shape as `vouch/run-vouch.ts` next door: the report is one
// file and the command around it is another, so the MCP server can ask the same question without
// anything being printed to the stream it speaks on.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanAgent } from './scan.ts';
import { IRREVERSIBLE, trifectaIn } from './tools.ts';
import { changedSince, inventoryOf, renderInventory, type Inventory } from './inventory.ts';
import { INVENTORY_AT, renderAgent, type AgentCommand } from './agent-command.ts';

const NL = String.fromCharCode(10);

/** The baseline somebody accepted, or null when there is none to compare against. */
function baselineAt(root: string): Inventory | null {
  const at = join(root, INVENTORY_AT);
  if (!existsSync(at)) return null;
  try {
    return JSON.parse(readFileSync(at, 'utf8')) as Inventory;
  } catch {
    // A baseline nobody can read is not a baseline. Treated as absent rather than as empty, which
    // would report every capability in the project as newly arrived.
    return null;
  }
}

export function runAgent(cmd: AgentCommand): { report: string; ungated: number } {
  const scan = scanAgent(cmd.root);
  const now = inventoryOf(scan);
  const baseline = baselineAt(cmd.root);
  let report = renderAgent(scan, cmd.root);
  if (cmd.inventory) {
    report += NL + renderInventory(now, baseline, INVENTORY_AT).join(NL);
    // Writing is approval; gating is checking, and doing both in one run means the check accepts
    // what it has just flagged. The first gated run failed on an unapproved capability, wrote the
    // new baseline on its way out, and the next run passed - a gate that can only ever fail once.
    // So `--gate` compares and does not write, and a person re-baselines deliberately.
    if (!cmd.gate) {
      const at = join(cmd.root, INVENTORY_AT);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, `${JSON.stringify(now, null, 2)}${NL}`, 'utf8');
    }
  }
  if (cmd.out) writeFileSync(cmd.out, report, 'utf8');
  else console.log(report);
  const asksAPerson = scan.guards.some((g) => g.kind === 'asks-a-person');
  const ungated = asksAPerson ? 0 : scan.tools.filter((t) => IRREVERSIBLE.includes(t.reach)).length;
  // The gate fails on the trifecta whether or not a person is asked: an approval step in front of
  // one tool does not close a path that runs through three.
  if (cmd.gate && (ungated > 0 || trifectaIn(scan.tools).complete)) process.exitCode = 1;
  // A capability nobody approved. Gated only when a baseline exists: the first run of `--inventory`
  // writes one, and failing a build because there was nothing to compare against yet would teach
  // people to pass `--inventory` without `--gate` and never come back.
  if (cmd.gate && cmd.inventory && baseline && changedSince(baseline, now).added.length > 0) process.exitCode = 1;
  return { report, ungated };
}
