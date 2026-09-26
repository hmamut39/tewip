// `tewip attest`: the evidence for one run, as an artifact a build can carry.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { datasetFiles, readJsonl, readTriageRecords } from '../../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { ENGINE_VERSION } from '../engine.ts';
import { attestRun, renderAttestation, type Attestation } from './attest.ts';
import { check } from './seal.ts';

/**
 * Checks a bundle somebody was handed. It reports what the check establishes and, just as
 * importantly, what it does not: a digest that matches proves the file is undamaged, and only a
 * signature checked against a key says who made it.
 */
export function verifyAttestation(file: string, keyFile?: string): { ok: boolean; report: string } {
  const bundle = JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<string, unknown>;
  const publicKey = keyFile ? readFileSync(resolve(keyFile), 'utf8') : undefined;
  const checked = check(bundle, publicKey);
  const ok = checked.contentMatches && checked.signature !== 'invalid';
  const report = [
    `# ${ok ? 'Checked' : 'Do not trust this bundle'}: ${file.split(/[\/]/).pop()}`,
    '',
    `Content matches its digest: ${checked.contentMatches ? 'yes' : 'NO'}`,
    `Signature: ${checked.signature.replace(/-/g, ' ')}`,
    '',
    checked.says + '.',
    '',
    ...(checked.signature === 'no-key-given' ? ['Pass `--key <public.pem>` to check the signature itself.'] : []),
  ].join(String.fromCharCode(10));
  return { ok, report };
}

export interface AttestCommand {
  root: string;
  /** Which kept project, when the history holds several. */
  name?: string;
  /** A specific run; the most recent one by default. */
  runId?: string;
  out?: string;
  /** Write the machine-readable bundle here as well. */
  json?: string;
}

/** Everything Tewip kept for one project, newest run last. */
function history(root: string, only?: string): { project: string; runs: RunSummary[]; records: TriageRecord[] } {
  const dir = join(root, '.tewip', 'history');
  const projects = existsSync(dir) ? (only ? [only] : readdirSync(dir)) : [];
  for (const project of projects) {
    const files = datasetFiles(join(dir, project));
    const runs = readJsonl<RunSummary>(files.runs);
    if (runs.length > 0) return { project, runs, records: readTriageRecords(files.triage) };
  }
  return { project: only ?? 'this project', runs: [], records: [] };
}

/**
 * What ran, in the words of the thing that ran. Only what is recorded counts: an attestation that
 * listed checks Tewip merely supports would be the fabrication this whole phase exists to prevent.
 */
function whatWasChecked(records: TriageRecord[]): { checked: string[]; notChecked: string[] } {
  const checked: string[] = [];
  const notChecked: string[] = [];
  checked.push('every failing test in the run was read, and each was given a cause or left undecided');
  const byRules = records.filter((r) => (r.diagnosis as { source?: string } | undefined)?.source === 'rules').length;
  const byModel = records.filter((r) => (r.diagnosis as { source?: string } | undefined)?.source === 'llm').length;
  if (byRules > 0) checked.push(`${byRules} decided by deterministic rules (${ENGINE_VERSION}), which call no model and give the same answer every time`);
  if (byModel > 0) checked.push(`${byModel} sent to the model, because no rule could settle them`);

  // What Tewip is silent about unless it was asked, and therefore must say it did not do.
  notChecked.push('the application itself: no security scan, dependency audit or web check is part of this bundle unless `tewip secure` ran and is quoted here');
  notChecked.push('tests that passed: a passing test is counted, not examined');
  notChecked.push('anything no test covers, which no test report can show');
  return { checked, notChecked };
}

export function runAttest(cmd: AttestCommand): Attestation {
  const { project, runs, records } = history(cmd.root, cmd.name);
  if (runs.length === 0) {
    throw new Error('nothing to attest: no run has been kept here yet. Run `tewip explain <report>` first, so there is evidence to attest to.');
  }
  const run = cmd.runId ? runs.find((r) => r.runId === cmd.runId) : runs[runs.length - 1];
  if (!run) throw new Error(`no run called ${cmd.runId} was kept here`);

  const mine = records.filter((r) => r.runId === run.runId);
  const { checked, notChecked } = whatWasChecked(mine);
  const attestation = attestRun(project, run, mine, { checked, notChecked, tool: 'tewip', engine: ENGINE_VERSION });

  const markdown = renderAttestation(attestation);
  console.log(markdown);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${markdown}\n`, 'utf8');
    console.error(`\nWritten to ${cmd.out}`);
  }
  if (cmd.json) {
    mkdirSync(dirname(resolve(cmd.json)), { recursive: true });
    writeFileSync(resolve(cmd.json), `${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
    console.error(`Machine-readable bundle written to ${cmd.json}`);
  }
  return attestation;
}
