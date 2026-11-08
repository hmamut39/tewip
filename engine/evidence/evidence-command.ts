// `tewip evidence`: every check over one repository, as one document somebody can sign and send.
//
// Six commands and six reports is what an IT department has today, and it is not what anybody asks
// them for. A customer security questionnaire, a supplier review and an EU AI Act technical file all
// want the same four answers about one artifact - what ships, what it is allowed to do, what breaks
// if it ships, and who approved it - with some stated reason to believe each one. `attest` signs a
// test run and `portfolio` spans repositories; neither combines the checks for one repository into a
// single document. This does.
//
// The seal is the existing attest machinery, and the distinction it keeps is kept here too: a digest
// says the document is undamaged, and only a signature checked against a key says who made it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { signingKey } from '../attest/attest.ts';
import { seal, type Seal } from '../attest/seal.ts';
import { MEASURED, NOT_MEASURED } from './confidence.ts';
import { gather, type Evidence, type Part } from './gather.ts';
import { CHECKS, renderEvidence } from './render.ts';

const NL = String.fromCharCode(10);

export interface EvidenceCommand {
  root: string;
  /** Where to write the document. */
  out?: string;
  /** Where to write the machine-readable bundle, which is the thing that carries the seal. */
  json?: string;
  /** The git ref API descriptions are compared against. */
  since?: string;
  /** Skip the checks that walk every source file. */
  quick?: boolean;
  /** Exit non-zero when something in the pack needs a person. */
  gate?: boolean;
  /**
   * An Ed25519 private key, as a PEM or a path to one. Defaults to TEWIP_ATTEST_KEY; without
   * either, the bundle carries a digest and says in as many words that it is not a signature.
   */
  key?: string;
}

export interface EvidenceBundle {
  tool: 'tewip';
  engine: string;
  producedAt: string;
  project: string;
  subject: Evidence['subject'];
  /** One row per check: whether it established anything, and how long it took. */
  checks: Array<{ command: string; about: string; established: boolean; refused?: string; seconds: number }>;
  /** The measured confidence behind the claims this run actually made. */
  confidence: Array<{ check: string; precision: string; recall: string; measuredAgainst: string; reDeriveWith: string }>;
  /** Checks in this pack carrying no measured recall, named rather than quietly omitted. */
  unmeasured: Array<{ check: string; why: string }>;
  /**
   * The document, in full. The seal covers this field, so a digest that still matches is a
   * statement about the words a person read - not merely about a summary of them.
   */
  document: string;
  seconds: number;
  seal?: Seal;
}

const partOf = (e: Evidence, key: keyof Evidence): Part<unknown> => e[key] as Part<unknown>;

/** What in this pack is waiting on a person. Each entry is a thing somebody has to decide. */
export function needsAPerson(e: Evidence): string[] {
  const out: string[] = [];
  const secrets = (e.secrets?.result ?? []).filter((i) => i.verdict === 'real-risk');
  if (secrets.length > 0) out.push(`${secrets.length} committed credential(s) are reachable`);
  const breaks = (e.contracts?.result?.files ?? []).reduce((n, f) => n + f.breaks.length, 0);
  if (breaks > 0) out.push(`${breaks} breaking change(s) to a published interface`);
  const migrations = (e.schema?.result ?? []).flatMap((m) => m.findings.filter((f) => f.risk !== 'fine' && f.risk !== 'slow'));
  if (migrations.length > 0) out.push(`${migrations.length} migration statement(s) break something`);
  const barriers = (e.access?.result?.findings ?? []).filter((f) => f.confidence === 'barrier');
  if (barriers.length > 0) out.push(`${barriers.length} accessibility barrier(s)`);
  const ships = (e.infra?.result?.findings ?? []).filter((f) => f.ships);
  if (ships.length > 0) out.push(`${ships.length} infrastructure finding(s) in files that ship`);
  const agent = e.agent?.result;
  if (agent && agent.guards.length === 0 && agent.tools.some((t) => ['destructive', 'deletes', 'pays', 'sends', 'runs-code'].includes(t.reach))) {
    out.push('a tool that cannot be taken back, with no guard anywhere in the project');
  }
  if (agent?.emptyBudget) out.push('a step ceiling written down and set to nothing');
  const audit = e.approvals?.result;
  if (audit && (audit.edited.length > 0 || audit.broken.length > 0)) out.push('the audit log has been changed since it was written');
  const licences = (e.ships?.result?.components ?? []).filter((c) => ['strong-copyleft', 'source-available', 'not-stated'].includes(c.licence.standing));
  if (licences.length > 0) out.push(`${licences.length} licence(s) need a decision`);
  return out;
}

export function bundleOf(e: Evidence, document: string): EvidenceBundle {
  const ran = new Set(CHECKS.filter((c) => partOf(e, c.key).result !== undefined).map((c) => c.command));
  return {
    tool: 'tewip',
    engine: e.engine,
    producedAt: e.at,
    project: e.project,
    subject: e.subject,
    checks: CHECKS.map((c) => {
      const p = partOf(e, c.key);
      return {
        command: c.command,
        about: c.label,
        established: p.result !== undefined,
        ...(p.refused !== undefined ? { refused: p.refused } : {}),
        seconds: p.seconds,
      };
    }),
    confidence: MEASURED.filter((m) => ran.has(m.check)).map((m) => ({
      check: m.check,
      precision: m.precision,
      recall: m.recall,
      measuredAgainst: m.groundTruth,
      reDeriveWith: `node ${m.from}`,
    })),
    unmeasured: NOT_MEASURED.filter((m) => ran.has(m.check)).map((m) => ({ check: m.check, why: m.why })),
    document,
    seconds: e.seconds,
  };
}

/**
 * The footer on the written document, which is deliberately outside the digest.
 *
 * The digest covers `bundle.document`, and this names the digest - so it cannot be inside it. The
 * footer says so in as many words, because a reader who assumed otherwise would check the wrong
 * thing: the file on disk is the document plus these lines, and what gets verified is the document.
 */
function footer(bundle: EvidenceBundle, jsonPath?: string): string[] {
  const s = bundle.seal;
  if (!s) return [];
  return [
    '',
    '---',
    '',
    `Digest of this document (sha256): \`${s.digest}\``,
    s.signature
      ? `Signed with Ed25519. A digest that matches says the document is undamaged; only this signature, checked against the matching public key, says who produced it.`
      : 'No signature: a matching digest says this document is undamaged, not that nobody edited it — anyone who edits a document can recompute its digest. Pass `--key <private.pem>` to sign.',
    '',
    jsonPath
      ? `Check it with \`tewip attest --verify ${jsonPath}${s.signature ? ' --key <public.pem>' : ''}\`. These last few lines sit outside the digest, which covers the document above them — it has to, since it names the digest.`
      : 'Pass `--json <file>` to write the bundle these can be checked against. These last few lines sit outside the digest, which covers the document above them.',
  ];
}

/**
 * The pack, built and sealed, with nothing written and nothing printed.
 *
 * Separate from `runEvidence` so the MCP server and the tests can have the document without a
 * process exit code or a console write. The argument for reaching this over MCP is the one
 * `what_tewip_may_do` makes: the person who needs an evidence pack - whoever signs the supplier
 * review, whoever answers the questionnaire - is the least likely of anyone to open a terminal.
 */
export function buildEvidence(cmd: Omit<EvidenceCommand, 'out' | 'json' | 'gate'>): {
  document: string;
  bundle: EvidenceBundle;
  pending: string[];
} {
  const e = gather({ root: cmd.root, since: cmd.since, quick: cmd.quick });
  const pending = needsAPerson(e);
  const document = [
    renderEvidence(e),
    '## Waiting on a person',
    '',
    ...(pending.length > 0
      ? ['Each of these is a decision Tewip does not make:', '', ...pending.map((p) => `- ${p}`), '']
      : ['Nothing in this pack is waiting on a decision, among the questions it answers. The section above lists the ones it does not answer.', '']),
  ].join(NL);

  const bundle = bundleOf(e, document);
  // Sealed last, over the finished bundle, so the digest covers the document a person reads.
  // `--key` is a PEM or a path to one, and falls through to TEWIP_ATTEST_KEY by the same rules
  // `attest` uses, so there is one way to find a signing key rather than two.
  const given = cmd.key?.trim();
  const key = given ? (given.includes('BEGIN') ? given : readFileSync(resolve(given), 'utf8')) : signingKey();
  bundle.seal = seal(bundle as unknown as Record<string, unknown>, key);
  return { document, bundle, pending };
}

export function runEvidence(cmd: EvidenceCommand): { report: string; bundle: EvidenceBundle; pending: string[] } {
  const { document, bundle, pending } = buildEvidence(cmd);
  const report = [document, ...footer(bundle, cmd.json)].join(NL);
  console.log(report);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}${NL}`, 'utf8');
    console.error(`${NL}Written to ${cmd.out}`);
  }
  if (cmd.json) {
    mkdirSync(dirname(resolve(cmd.json)), { recursive: true });
    writeFileSync(resolve(cmd.json), `${JSON.stringify(bundle, null, 2)}${NL}`, 'utf8');
    console.error(`Sealed bundle written to ${cmd.json}`);
  }
  if (cmd.gate && pending.length > 0) process.exitCode = 1;
  return { report, bundle, pending };
}
