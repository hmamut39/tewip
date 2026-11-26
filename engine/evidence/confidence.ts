// How much each line of the evidence pack is worth, recorded rather than asserted.
//
// "No credentials found" is not evidence of anything on its own. A check that finds nothing scores
// perfect precision, and the reader has no way to tell a careful answer from an empty one. The
// sentence that is worth putting in front of an auditor is the pair: nothing was found, **and this
// check finds 100% of twenty credential formats their own providers publish, with none of five
// decoys wrongly accused**.
//
// So every number here was measured, and every one was measured against something somebody else
// published - the W3C's numbered failure techniques, the database manuals, the providers' token
// formats, the frameworks' quickstarts. Never against Tewip's own rules, because a check marking
// its own homework produces a number that means nothing and reads exactly like one that does.
//
// This file is a record, in the same spirit as corpus/expected.json: each figure names the harness
// that produces it, so a reader who does not believe it can run that harness and get it back.
export interface Confidence {
  /** The row's label, which can name one half of a command. */
  check: string;
  /**
   * The verb this number belongs to.
   *
   * Separate from `check` because one command can make claims of different kinds with different
   * numbers behind them: `agent` reports tools and prompt-injection flows, measured by two
   * harnesses against two published lists. Folding them into one row printed the tools figure
   * underneath a claim it was never measured on.
   */
  command: string;
  /**
   * What it got wrong on real code, and how much real code.
   *
   * Prose, and unlike `measured` nothing re-derives it. `recall` is held to its harness by
   * engine/test/confidence-is-current.test.ts; a precision sentence is only as current as the last
   * person who ran the thing. Where the figure comes from the corpus, `pinnedIn` names the repos it
   * was read on, and `npm run corpus` re-derives it - which is the only form of this claim worth
   * putting in a signed document.
   */
  precision: string;
  /** The corpus repositories this precision figure is pinned on, where it is pinned at all. */
  pinnedIn?: string[];
  /** What it found of a published list, and how long that list was. */
  recall: string;
  /** The harness that re-derives the recall figure. */
  from: string;
  /** Where the list came from, which is the whole argument. */
  groundTruth: string;
  /**
   * The counts behind `recall`, so the prose cannot outlive the thing it describes.
   *
   * `recall` is a sentence, and a sentence keeps reading true after it stops being true. Nothing
   * in CI re-derived any of these: change a rule and the evidence pack would go on publishing
   * "20 of 20" out of this file while the harness returned eighteen - a stated measurement that
   * had quietly stopped holding, signed and sent to somebody who cannot check it. The test beside
   * this runs each harness and holds both these numbers and the sentence to what it returns.
   */
  measured: { found: number; of: number; accused: number; decoys: number };
}

export const MEASURED: Confidence[] = [
  {
    check: 'secure',
    command: 'secure',
    precision: '0 credentials wrongly called actionable across 9 real projects, pinned in the corpus',
    pinnedIn: ['keycloak', 'bitwarden-server', 'saleor', 'govuk-frontend', 'firefly-iii', 'ripgrep', 'nocodb', 'immich', 'n8n'],
    recall: '25 of 25 credential shapes found and kept by triage, 0 of 7 decoys wrongly accused',
    from: 'eval/secure-recall.ts',
    measured: { found: 25, of: 25, accused: 0, decoys: 7 },
    groundTruth: "each provider's own published token format - AWS, GitHub, Stripe, Shopify and the rest",
  },
  {
    check: 'schema',
    command: 'schema',
    precision: '0 false positives across 14 real projects, pinned in the corpus',
    pinnedIn: ['keycloak', 'openmrs-core', 'bitwarden-server', 'saleor', 'govuk-frontend', 'firefly-iii', 'discourse', 'ripgrep', 'angular-components', 'nocodb', 'immich', 'gin', 'dispatch', 'n8n'],
    recall: '15 of 15 harmful migrations named, 0 of 4 safe ones accused',
    from: 'eval/schema-recall.ts',
    measured: { found: 15, of: 15, accused: 0, decoys: 4 },
    groundTruth: 'the PostgreSQL and MySQL manuals, and each framework’s own documentation',
  },
  {
    check: 'access',
    command: 'access',
    precision: '0 barriers wrongly reported across 8 real projects, pinned in the corpus',
    pinnedIn: ['keycloak', 'bitwarden-server', 'govuk-frontend', 'angular-components', 'nocodb', 'immich', 'gin', 'n8n'],
    recall: '11 of 11 documented failures noticed, 0 of 11 documented fixes accused',
    from: 'eval/access-recall.ts',
    measured: { found: 11, of: 11, accused: 0, decoys: 11 },
    groundTruth: "the W3C's numbered failure techniques - F65, F68, F54, F44, H64, H91, H57",
  },
  {
    check: 'agent',
    command: 'agent',
    precision: '0 invented tools and 0 invented flows across 16,654 files of real code, pinned in the corpus',
    pinnedIn: ['n8n', 'nocodb', 'immich', 'saleor', 'gin'],
    recall: '10 of 10 tool shapes read, 0 of 4 decoys invented',
    from: 'eval/agent-recall.ts',
    measured: { found: 10, of: 10, accused: 0, decoys: 4 },
    groundTruth: "the shape each framework's own quickstart declares a tool in",
  },
  {
    check: 'agent (borrowed credential)',
    command: 'agent',
    precision: '0 findings across 66,307 files of the corpus - and two of the three it reported on the way there were correct implementations, now decoys in the harness below',
    pinnedIn: ['n8n', 'nocodb', 'immich', 'saleor', 'gin'],
    recall: '5 of 5 passthroughs read, 0 of 7 correct implementations accused',
    from: 'eval/identity-recall.ts',
    measured: { found: 5, of: 5, accused: 0, decoys: 7 },
    groundTruth:
      'OWASP ASI03, Identity and Privilege Abuse, against a normative rule rather than an opinion: the Model Context Protocol authorization spec (2026-07-28) states that a server "MUST NOT pass through the token it received from the MCP client", and gives the confused deputy as the reason. Each case is a passthrough written the way its library documents the pieces - the MCP TypeScript SDK\u2019s `extra.authInfo.token`, an Express or Hono inbound header, FastAPI\u2019s bearer dependency. What it cannot say is anything about scope or audience claims, which are runtime facts about a signed value, nor whether the agent\u2019s own permissions are wider than its task needs - that is the other half of ASI03 and lives in an IAM policy rather than in this source',
  },
  {
    check: 'infra (Kubernetes)',
    command: 'infra',
    precision: '0 of 8 compliant manifests accused, and 0 findings invented across 4 real repositories in the corpus',
    pinnedIn: ['bitwarden-server', 'keycloak', 'immich', 'gin'],
    recall: '8 of 8 Pod Security Standards controls found, up from 6',
    from: 'eval/infra-recall.ts',
    measured: { found: 8, of: 8, accused: 0, decoys: 8 },
    groundTruth:
      "the Kubernetes project's own Pod Security Standards, which names the field and the allowed value for every control - each planted twice, once as the manifest the standard forbids and once as the one it allows",
  },
  {
    check: 'infra (Terraform)',
    command: 'infra',
    precision: '0 of 7 recommended configurations accused',
    recall: '7 of 7 published AWS controls found',
    from: 'eval/terraform-recall.ts',
    measured: { found: 7, of: 7, accused: 0, decoys: 7 },
    groundTruth:
      "AWS's own guidance, named rather than numbered - blocking public access to S3, security group rules, least privilege in IAM, encryption at rest, CloudTrail logging - each planted twice, in the shape AWS warns against and the shape it recommends. CIS AWS Foundations numbers were checked and refused: the security-group control alone is 4.1 in v1.2.0, 5.02 in v1.4.0 and v2.0, and 6.03 in v6.0",
  },
  {
    check: 'infra (Docker)',
    command: 'infra',
    precision: '0 of 8 recommended configurations accused, including a container that drops a capability rather than adding one',
    recall: '8 of 8 published Docker controls found, up from 7',
    from: 'eval/container-recall.ts',
    measured: { found: 8, of: 8, accused: 0, decoys: 8 },
    groundTruth:
      "Docker's own documentation, named rather than numbered - USER rather than root, a pinned base image, COPY rather than ADD from a URL, no script piped into a shell, no privileged container, no daemon socket mounted in, no host network, no capability that undoes the sandbox - each planted twice, in the shape Docker warns against and the shape it recommends. Measuring it found the capability rule reading only the block list, so `cap_add: [\"SYS_ADMIN\"]`, the form Compose's own reference uses, was missed",
  },
  {
    // Split from the row above rather than folded into it. `agent` reports three things - the tools,
    // the guards, and untrusted text glued into a prompt - and only the tools had ever been
    // measured. The pack printed that one number under all three, which is a figure standing in for
    // claims it was not measured on. Measuring the second half found all three of the flows this
    // check reported on n8n to be false: two object keys and a value appended to its own field.
    check: 'agent (the guards)',
    command: 'agent',
    precision: '0 of 7 decoys counted as a gate, including a shop’s price ceiling, a payments sandbox and a rate limit',
    recall: '19 of 20 documented gates found, across six kinds including a sandbox and a spend cap',
    from: 'eval/guard-recall.ts',
    measured: { found: 19, of: 20, accused: 0, decoys: 7 },
    groundTruth: "the human-in-the-loop page of LangGraph, CrewAI, the OpenAI Agents SDK and the Vercel AI SDK, in both the Python and JavaScript forms each publishes",
  },
  {
    check: 'agent (memory poisoning)',
    command: 'agent',
    precision: '0 of 5 decoys counted as a flow, including a Set, a list append and a store seeded from the project’s own text',
    recall: '6 of 6 documented store writes found, across LangChain, Pinecone and a RAG re-index',
    from: 'eval/memory-recall.ts',
    groundTruth:
      'OWASP ASI06, Memory and Context Poisoning. Each case is the write the library’s own documentation uses, carrying outside text into a store that outlives the request. What it cannot measure is whether that store is read back into a prompt: that happens in a later request, through code this check does not follow, so the claim is that the door exists rather than that somebody walked through it',
    measured: { found: 6, of: 6, accused: 0, decoys: 5 },
  },
  {
    check: 'agent (an interface others can reach)',
    command: 'agent',
    precision: '0 of 5 decoys counted as a door, including a loopback bind, a plain web server, and a client reading somebody else’s agent card',
    recall: '5 of 5 exposed agent interfaces found, across the MCP SDK’s two HTTP transports and A2A',
    from: 'eval/door-recall.ts',
    groundTruth:
      'OWASP ASI07, Insecure Inter-Agent Communication. A conjunction: an agent protocol served, and a bind to every interface, in one file. Either alone is normal and neither is reported. What it cannot say is whether an ingress, a mesh or a security group checks the caller - none of those is in the source - so the report states where the door is and says plainly that the thing in front of it is not something Tewip can see',
    measured: { found: 5, of: 5, accused: 0, decoys: 5 },
  },
  {
    check: 'agent (goal hijack)',
    command: 'agent',
    precision: '0 of 4 turns wrongly escalated, including a `user` role, a HumanMessage and the words “design system” in prose',
    recall: '5 of 5 system-prompt shapes named, across LangChain, OpenAI, the Anthropic and Vercel SDKs and the Agents SDK',
    from: 'eval/goal-recall.ts',
    groundTruth:
      'OWASP ASI01, Agent Goal Hijack, scored on top of the injection flows rather than beside them: every case is already a flow, and what is measured is whether the system prompt is told from a turn. The failure available here is not a false finding but a real one made to sound worse than it is, so the four turns weigh as much as the five system prompts. One shape is unreachable by design and named in the harness: a chain two hops from its source, which this project refuses everywhere it reads a flow',
    measured: { found: 5, of: 5, accused: 0, decoys: 4 },
  },
  {
    check: 'agent (prompt-injection flows)',
    command: 'agent',
    precision: '0 of 5 decoys accused, every one real code this check had reported',
    recall: '8 of 8 documented flows found, up from 6',
    from: 'eval/injection-recall.ts',
    measured: { found: 8, of: 8, accused: 0, decoys: 5 },
    groundTruth: "the shape each framework's own documentation glues outside text into a prompt in",
  },
  {
    check: 'vouch',
    command: 'vouch',
    precision: '0 of 157 sound tests wrongly accused here, and 0 of 74 on a stranger’s Python suite; pinned across 10 real projects in the corpus',
    pinnedIn: ['keycloak', 'openmrs-core', 'bitwarden-server', 'saleor', 'govuk-frontend', 'firefly-iii', 'discourse', 'ripgrep', 'angular-components', 'gin'],
    recall: '48 of 64 (75.0%) tests that provably lost their check were named',
    from: 'eval/vouch-recall.ts',
    measured: { found: 48, of: 64, accused: 0, decoys: 157 },
    groundTruth:
      'execution - a test that caught a mutation before and catches none now. The recall figure is measured on this project’s own suite in JavaScript, and on no other language: until Phase 162 the harness ran only Mocha and node:test and parsed every test file as JavaScript whatever its extension. A pytest runner now exists and extends the *precision* figure to Python, but not the recall one - the seeding rule drops a test’s last statement, and pytest’s commonest shape is a parametrised function whose body is a single assertion, which it cannot hollow out',
  },
];

/**
 * Checks that carry no measured recall yet, named rather than left out of the table.
 *
 * Being in this list is the point. A check in neither list renders no line at all, and a missing
 * honesty line looks exactly like a passing one - which is the failure this whole file exists to
 * prevent, arriving through the file itself. `audit` was in neither for the eleven phases it has
 * been part of the evidence pack; `engine/test/confidence.test.ts` now fails when any check the
 * pack runs is unaccounted for.
 */
export const NOT_MEASURED: Array<{ check: string; why: string }> = [
  { check: 'sbom', why: 'it reads a lockfile rather than deciding anything, so there is nothing to be right or wrong about - what it cannot read is listed in its own report' },
  { check: 'contract', why: 'the comparison is exact once both versions parse; what is unmeasured is how many real descriptions the YAML reader can read, and the report says when it cannot read one' },
  {
    check: 'audit',
    why:
      'the chain either verifies or it does not, so there is no rate to measure: an edited or removed entry breaks every hash after it and the report names the line. ' +
      'What it cannot detect is the whole log being deleted, or lines removed from the end, and it says so in its own report rather than leaving it to be discovered',
  },
];

export const confidenceFor = (command: string): Confidence | undefined => MEASURED.find((m) => m.command === command);

/** The table, and the sentence that says why it is here. */
export function confidenceSection(used: string[]): string[] {
  const rows = MEASURED.filter((m) => used.includes(m.command));
  const missing = NOT_MEASURED.filter((m) => used.includes(m.check));
  if (rows.length === 0 && missing.length === 0) return [];
  const lines = [
    '## How much each line above is worth',
    '',
    'Nothing found is not evidence of anything on its own: a check that finds nothing scores perfect',
    'precision, and a reader cannot tell a careful answer from an empty one. Each figure below was',
    'measured against a list somebody else published, never against Tewip’s own rules, and each names',
    'the harness that re-derives it.',
    '',
  ];
  if (rows.length > 0) {
    lines.push('| check | wrong on real code | found of a published list | measured against |', '| --- | --- | --- | --- |');
    for (const r of rows) lines.push(`| \`${r.check}\` | ${r.precision} | ${r.recall} | ${r.groundTruth} |`);
    lines.push('', ...rows.map((r) => `- \`${r.check}\` — re-derive with \`node ${r.from}\``), '');
  }
  if (missing.length > 0) {
    lines.push('**Carrying no measured recall:**', '', ...missing.map((m) => `- \`${m.check}\` — ${m.why}`), '');
  }
  return lines;
}
