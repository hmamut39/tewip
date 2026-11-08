// The two tools that answer "is this safe to run, and what is the evidence" - the page somebody
// asks for before letting an agent near a repository, and the pack somebody asks for before signing
// a supplier review.
//
// Split out of mcp/tools-prove.ts when adding the evidence pack pushed it past the 300 lines this
// project allows, the same split as cli/verbs-assure.ts beside cli/tewip.ts. The registration is
// identical: these are the same calls, one level down.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ToolHelpers } from './tools-prove.ts';

export function registerAssuranceTools(server: McpServer, { answer, readOnly, project }: ToolHelpers): void {
// The page somebody asks for before letting an agent near a repository. It is reachable from an
// assistant because the person who needs it - whoever has to approve this - is the least likely
// of anyone to open a terminal and run a command to get it.
server.registerTool(
  'what_tewip_may_do',
  {
    title: 'What may Tewip change here, and what will it never do?',
    description:
      "What Tewip is allowed to do to this codebase and what it refuses to do, with the test that enforces each promise named beside it - and how many failures it declined to explain in this project rather than guessing. The page is written by reading those tests off disk, so a promise whose test has been deleted is reported as no longer enforced instead of being repeated. Use it when somebody asks whether this agent is safe to run, what it can touch, or what evidence there is for either answer. No model is called.",
    inputSchema: { project },
    annotations: readOnly,
  },
  ({ project: root }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      const { safetyReport } = await import('../engine/safety/safety-command.ts');
      return safetyReport(root);
    }),
);

// The document a supplier review asks for, reachable by the person who has to produce it. Same
// argument as the tool above: whoever signs a security questionnaire is the least likely of anyone
// to run a command for it.
server.registerTool(
  'evidence_pack',
  {
    title: 'The evidence pack for one repository',
    description:
      'One document answering what a supplier review, a customer security questionnaire and an EU AI Act technical file all ask about one repository: what ships and under which licence, what a model and the infrastructure are allowed to do, what breaks if it ships, and who approved it - with the measured precision and recall behind each claim, each naming the harness that re-derives it. A check that could not run says so in place of its answer, so no empty section reads as a clean one. There is no overall pass or fail: it reports what was established, what was not, and what is waiting on a person. No model is called and nothing is fetched. Use `quick` to skip the three whole-repository walks, which the document then names as skipped.',
    inputSchema: {
      project,
      quick: z.boolean().optional().describe('Skip the checks that read every source file; the document names each one it skipped'),
      since: z.string().optional().describe('The git ref to compare API descriptions against, e.g. HEAD~1 or a tag'),
    },
    annotations: readOnly,
  },
  ({ project: root, quick, since }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      const { buildEvidence } = await import('../engine/evidence/evidence-command.ts');
      const { document, bundle } = buildEvidence({ root, quick, since });
      // The digest is given here too: an assistant that passes the pack on should be able to say
      // which document it is quoting, and a digest is the only identity the pack has.
      return `${document}\n\nDigest of this document (sha256): \`${bundle.seal?.digest ?? 'none'}\`${
        bundle.seal?.signature ? '\nSigned with Ed25519.' : '\nNot signed: a digest says the document is undamaged, not who made it.'
      }`;
    }),
);
}
