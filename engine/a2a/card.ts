// Phase 34: the agent card, so other agents can find out what Tewip will answer.
//
// A2A is the one capability on the standard list that matches this product's thesis exactly. Tewip
// exists to prove work "written by a person or by an agent", and MCP already lets an assistant call
// it as a tool. A2A is the other direction: Tewip as a peer that another agent has to satisfy
// before its diff counts as finished. When most code is written by agents, the thing that checks
// the work has to be reachable by agents.
//
// Every field here was taken from the v1.0 specification rather than from memory, because four
// details would have been wrong: discovery is `/.well-known/agent-card.json` and not `agent.json`;
// the JSON-RPC method is `SendMessage` in PascalCase, not `message/send`; a role is `ROLE_USER`,
// not `user`; and a task state is `TASK_STATE_COMPLETED`, not `completed`. Each of those is the
// kind of mistake that produces a server nothing can talk to.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One thing Tewip will answer, as A2A describes a skill. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: Array<{ url: string; transport: string }>;
  provider?: { organization: string; url: string };
  version: string;
  documentationUrl?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  iconUrl?: string;
}

/**
 * The verbs a caller down a socket is allowed to reach, and the single rule behind the list:
 * **everything here reads and nothing here writes.**
 *
 * `fix`, `write`, `build` and `pursue` change files; `prove` deliberately breaks a file and runs the
 * suite before putting it back. None of those belongs behind an HTTP port that another program can
 * reach. The whole guardrail story in this project is an allowlist of what may be done rather than
 * a blocklist of what may not, and this is the same allowlist applied to a new door.
 */
export const ANSWERABLE: ReadonlyArray<AgentSkill & { verb: string }> = [
  {
    id: 'explain-failures',
    verb: 'explain',
    name: 'Why did these tests fail?',
    description:
      'Reads a test report and gives each failure a cause with the evidence for it: a real bug, a flaky test, the environment, the test data, or a changed selector. Answers "cannot say" rather than guessing.',
    tags: ['testing', 'triage', 'ci', 'debugging'],
    examples: ['Why did the checkout tests fail in this report?', 'Is this failure flaky or a real bug?'],
  },
  {
    id: 'could-these-tests-fail',
    verb: 'vouch',
    name: 'Could these tests ever fail?',
    description:
      'Reads a test file and names the tests that check nothing: an assertion that compares a value with itself, an expectation left unfinished, a test with no assertion at all. A suite that cannot fail is not evidence.',
    tags: ['testing', 'quality', 'review'],
    examples: ['Can the tests in this file actually fail?'],
  },
  {
    id: 'which-tests-notice',
    verb: 'pick',
    name: 'Which tests could notice this change?',
    description:
      'Narrows a test run from facts in the source, and refuses to narrow when it cannot show the rest are unaffected. Returns the files to run, or says it cannot be done safely.',
    tags: ['testing', 'ci', 'performance'],
    examples: ['Which tests do I need to run for this diff?'],
  },
  {
    id: 'migration-safety',
    verb: 'schema',
    name: 'What will this migration do to a live database?',
    description:
      'Names what breaks the version still running during a rolling deploy, destroys data, blocks writes, or cannot be undone - and searches the repository for code that still uses a column being dropped. Reads SQL, Django, Rails, Alembic, TypeORM, Sequelize, Knex, EF Core and Liquibase, which covers Prisma, Drizzle and Flyway too.',
    tags: ['database', 'migrations', 'deployment', 'risk'],
    examples: ['Is this migration safe to deploy?', 'Will this drop break the running version?'],
  },
  {
    id: 'accessibility',
    verb: 'access',
    name: 'Can everybody use this interface?',
    description:
      'Names the accessibility barriers that reading the markup proves, each against its WCAG 2.2 criterion and EN 301 549 clause, and keeps apart the ones only a person can settle. Always reports which criteria it could not check.',
    tags: ['accessibility', 'wcag', 'compliance', 'frontend'],
    examples: ['Is this component accessible?', 'What WCAG failures are in this page?'],
  },
  {
    id: 'is-it-slower',
    verb: 'perf',
    name: 'Is this change slower?',
    description:
      'Judges a k6 or Lighthouse run against recorded baselines, and refuses to call a regression without at least three of them, because one run against one run cannot tell a change from a busy machine.',
    tags: ['performance', 'benchmarking', 'regression'],
    examples: ['Did this change make the checkout slower?'],
  },
  {
    id: 'house-standards',
    verb: 'standards',
    name: "Does this keep the team's own rules?",
    description:
      "Checks a change against the rules this team wrote down in .tewip/standards/, quoting the offending line and the team's own reason. Rules it enforces are kept apart from guidance it can only carry.",
    tags: ['code-review', 'standards', 'conventions'],
    examples: ['Does this change follow our conventions?'],
  },
  {
    id: 'is-this-done',
    verb: 'done',
    name: 'Is this work actually finished?',
    description:
      'One verdict over a change, from layers that each have a measured accuracy: is anything failing, is the changed code tested by something that really reaches it, can those tests fail at all, and is what was asked for covered. Answers ready, not ready, or cannot say - and never rounds cannot say up to ready.',
    tags: ['code-review', 'quality', 'verification'],
    examples: ['Is this pull request ready to merge?', 'Is my change done?'],
  },
];

/** The version Tewip is running, so the card does not claim a version it is not. */
function versionOf(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The card, built from the same list the server answers from, so the two cannot drift. A card that
 * advertises a skill the server will not perform is worse than no card.
 */
export function agentCard(url: string, tewipRoot: string): AgentCard {
  return {
    name: 'Tewip',
    description:
      'Proves software work, written by a person or by an agent. Triages a failing test to a cause with evidence, says whether a test could ever fail, reads what a migration will do to a live database, names who cannot use an interface, and gives one verdict on whether a change is done. It answers "cannot say" rather than guessing, and every answer carries what it did not check.',
    supportedInterfaces: [{ url, transport: 'JSONRPC' }],
    provider: { organization: 'Mamuti Aishan (Hasan)', url: 'https://github.com/hmamut39/tewip' },
    version: versionOf(tewipRoot),
    documentationUrl: 'https://github.com/hmamut39/tewip#readme',
    // Both false, and the specification is explicit that an operation whose flag is false must
    // return an error. Declaring a capability that is not implemented is the one thing a card must
    // not do, and streaming a verdict that is computed in one step would buy nothing anyway.
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'text/markdown'],
    skills: ANSWERABLE.map(({ verb: _verb, ...skill }) => skill),
    iconUrl: 'https://raw.githubusercontent.com/hmamut39/tewip/main/assets/logo.svg',
  };
}

/** The skill a caller asked for by id, if it is one Tewip answers. */
export function skillById(id: string): (AgentSkill & { verb: string }) | undefined {
  return ANSWERABLE.find((s) => s.id === id);
}
