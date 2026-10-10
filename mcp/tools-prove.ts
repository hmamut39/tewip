// The tools that prove a change rather than describe it: whether a test could ever fail, whether the
// tests would catch a bug, whether the work is done, which tests to run, what a migration does to a
// live database, and the project's own standards.
//
// Split out of mcp/server.ts for the same reason the CLI verbs were: this project keeps every file
// under 300 lines, and the server had grown past it. The registration is identical - these are the
// same calls, one level down.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface ToolHelpers {
  /** Wraps a handler so a thrown error becomes a tool error instead of a crash. */
  answer: (fn: () => string | Promise<string>) => Promise<Result>;
  /** The shared annotations for a tool that only reads. */
  readOnly: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  /** The shared `project` input: an absolute path. */
  project: z.ZodString;
}

export function registerProofTools(server: McpServer, { answer, readOnly, project }: ToolHelpers): void {
server.registerTool(
  'vouch_tests',
  {
    title: 'Could these tests ever fail?',
    description:
      "Reads test files and says, per test, whether a change to the code could break them: which compare no value, which leave an expectation unfinished, which compare something with itself, which catch and discard their own failure, and which never run. Where the checking happens in a helper it cannot follow it says so instead of accusing. Costs nothing and uses no model. Use it on tests that were just written - including tests you wrote yourself - before claiming a change is covered.",
    inputSchema: {
      project,
      paths: z.array(z.string()).optional().describe('Paths inside the project to read, relative to it. Defaults to the whole project.'),
    },
    annotations: readOnly,
  },
  ({ project: root, paths }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      const { vouchReport } = await import('../engine/vouch/run-vouch.ts');
      return vouchReport(root, paths && paths.length > 0 ? paths : ['.']).report;
    }),
);

server.registerTool(
  'prove_tests_catch_bugs',
  {
    title: 'Would the tests catch a bug here?',
    description:
      "Breaks one source file in small, deliberate ways - a boundary moved by one, a condition inverted, an and that became an or, a returned flag flipped - runs the tests that reach that file, and reports every change none of them noticed. This is execution, not opinion: the line was covered, it just was not checked. Slow by nature (each change means a real test run, so expect minutes) and it needs a unit test framework. The file is always put back exactly as it was, and if the tests turn out not to load the file at all it says so instead of reporting false holes. Use it after writing or changing code, to find out whether the tests you are relying on would have stopped a mistake.",
    inputSchema: {
      project,
      file: z.string().describe('One source file, relative to the project, e.g. src/pricing.js'),
      limit: z.number().optional().describe('How many changes to try (default 6). More is a better answer and a longer wait.'),
      budgetSeconds: z.number().optional().describe('Total seconds to spend before stopping and saying how many were left (default 600)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ({ project: root, file, limit, budgetSeconds }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      // runProve prints its report; over MCP the report is the return value and printing would corrupt
      // the protocol, so the pieces are called directly.
      const { proveOne } = await import('../engine/prove/prove-command.ts');
      return proveOne(root, file, { limit, budgetSeconds });
    }),
);

server.registerTool(
  'is_the_work_done',
  {
    title: 'Is this work actually done?',
    description:
      "One verdict on a change, from the layers that each have their own measured accuracy: is anything failing, is the changed code tested by something that really reaches it, can the tests in the change fail at all, would they catch a bug (only when prove is asked for, because that costs minutes), and is what was asked for covered. Answers ready, not ready, or cannot say - and cannot say is never rounded up to ready. Use it before claiming a piece of work is finished, including your own: a green test run is not the same as work that is done.",
    inputSchema: {
      project,
      diff: z.string().optional().describe('A git range, e.g. main...HEAD (the default)'),
      prove: z.boolean().optional().describe('Also break the changed code and run the tests against it. Costs minutes.'),
    },
    annotations: readOnly,
  },
  ({ project: root, diff, prove }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      // gather/decide/render are pure; runDone prints, which would corrupt the protocol.
      const { gather } = await import('../engine/verdict/verdict-command.ts');
      const { decide, renderDecision } = await import('../engine/verdict/verdict.ts');
      const range = diff ?? 'main...HEAD';
      const gathered = gather({ root, diff: range, prove });
      if (!gathered) return `Nothing changed in ${range}, or that range could not be read here.`;
      return renderDecision(range, decide(gathered.evidence));
    }),
);

server.registerTool(
  'which_tests_to_run',
  {
    title: 'Which tests could notice this change?',
    description:
      "Narrows a test run to the tests that could notice a change, from facts in the source rather than a prediction: a test runs when it imports a changed file, reaches one through another module, is itself edited by the change, reads the repository at run time, or has failed recently. It refuses to narrow at all - and says why - when the change touches dependencies, build or test configuration, shared setup or fixtures, when the suite drives a browser, or when a changed file cannot be traced to any test. Use it to run the right tests quickly; what it leaves out, it leaves out for a stated reason.",
    inputSchema: {
      project,
      diff: z.string().optional().describe('A git range, e.g. main...HEAD (the default)'),
      files: z.array(z.string()).optional().describe('The changed files, when they do not come from a git range'),
    },
    annotations: readOnly,
  },
  ({ project: root, diff, files }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      // choose/renderPick are pure; runPick prints, which would corrupt the protocol.
      const { choose } = await import('../engine/pick/pick-command.ts');
      const { renderPick } = await import('../engine/pick/pick.ts');
      const range = diff ?? 'main...HEAD';
      const chosen = choose({ root, diff: range, files });
      if (!chosen) return `Nothing changed in ${range}, or that range could not be read here.`;
      return renderPick(chosen.picked, chosen.total, chosen.command, chosen.noHistory);
    }),
);

server.registerTool(
  'what_will_this_migration_do',
  {
    title: 'What will this migration do to a live database?',
    description:
      "Reads the migrations in a change and names what will happen when they run against a live database: a column dropped while the version still running keeps selecting it, a table dropped, an index built under a lock that blocks writes, a NOT NULL added to a populated table, a type change that rewrites it, a foreign key validated against every row, a data migration holding a transaction open, a step that cannot be undone. It also searches the repository for code that still uses the column being taken away. Reads SQL, Django, Rails and Alembic, judges only the forward path, and says plainly when it cannot read a migration. It does not know your table sizes, so it says what a statement does rather than how long it will take.",
    inputSchema: {
      project,
      diff: z.string().optional().describe('A git range, e.g. main...HEAD (the default)'),
      files: z.array(z.string()).optional().describe('Migration files to read, when they do not come from a git range'),
    },
    annotations: readOnly,
  },
  ({ project: root, diff, files }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      const { readMigration, renderSchema, schemaFiles, stillUsed } = await import('../engine/schema/schema-command.ts');
      const cmd = { root, diff: diff ?? 'main...HEAD', files };
      const migrations = schemaFiles(cmd).map((file) => readMigration(root, file));
      if (migrations.length === 0) return 'No migration or schema file in that change.';
      return renderSchema(migrations, stillUsed(root, migrations.flatMap((m) => m.findings)));
    }),
);

server.registerTool(
  'accessibility_barriers',
  {
    title: 'Can everybody use this interface?',
    description:
      "Accessibility barriers in a project's markup, each named against the WCAG 2.2 criterion a regulator would cite, with the evidence to check it. Two kinds of answer, kept apart on purpose: barriers that reading the markup proves (no alt attribute at all, a field with no label anywhere, a div that only a mouse can activate), and the ones only a person can settle, where something is written as an expression or a component and the markup cannot say. It also returns every criterion it did NOT check - contrast, focus order, whether alt text is any good - because those need a rendered page. Use it before shipping an interface, or when asked whether something is accessible; a clean result means these checks found nothing, never that the product is accessible. No browser, no network, no model.",
    inputSchema: {
      project,
      path: z.string().optional().describe('A file or directory inside the project to check instead of all of it'),
    },
    annotations: readOnly,
  },
  ({ project: root, path }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      // The pure functions, not runAccess: that one prints, and anything on stdout breaks JSON-RPC.
      const { findBarriers, keyOf, readAccepted, renderAccess } = await import('../engine/access/access-command.ts');
      const { findings, filesRead } = findBarriers(root, path);
      const judged = readAccepted(root);
      const open = findings.filter((f) => !judged.has(keyOf(f)));
      return renderAccess(
        {
          barriers: open.filter((f) => f.confidence === 'barrier'),
          questions: open.filter((f) => f.confidence === 'ask-a-person'),
          accepted: findings.filter((f) => judged.has(keyOf(f))),
          filesRead,
        },
        path ?? root,
      );
    }),
);

server.registerTool(
  'project_standards',
  {
    title: "What are this project's own rules?",
    description:
      "The house rules this team has written down in .tewip/standards/, and whether a change keeps them. Returns two things kept carefully apart: rules Tewip checks and enforces (a forbid or require pattern over a set of files), and guidance it can only carry - prose for the parts no pattern captures, which is passed on when something is written but never reported as verified. Use it before writing or changing code in somebody's project, so what you produce matches their conventions rather than yours.",
    inputSchema: {
      project,
      files: z.array(z.string()).optional().describe('Files to check against the rules. Omit to list what the project has written.'),
      diff: z.string().optional().describe('A git range whose changed files should be checked instead'),
    },
    annotations: readOnly,
  },
  ({ project: root, files, diff }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      const { checkChanged, loadStandards, renderStandards } = await import('../engine/standards/standards-command.ts');
      const { changeSummary } = await import('../engine/quality/grounding.ts');
      const standards = loadStandards(root);
      const changed = files && files.length > 0 ? files : diff ? (changeSummary(root, diff)?.files ?? []) : [];
      return renderStandards(standards, changed.length > 0 ? checkChanged(root, standards, changed) : [], changed.length);
    }),
);
}
