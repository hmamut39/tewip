// What each corpus check counts, derived from the engine rather than from the words of a report.
//
// Split out of scripts/corpus.ts in Phase 207, when adding the front door took that file past this
// project's 300-line rule. The runner there does the cloning, the comparing and the exit code;
// this does the measuring, and the separation is the useful one - a number here is produced by the
// same function the product uses, so a check cannot drift from the thing it checks by being
// re-implemented beside it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vouchAll } from '../engine/vouch/vouch-command.ts';
import { findBarriers } from '../engine/access/access-command.ts';
import { migrationsUnder, readMigration } from '../engine/schema/schema-command.ts';
import { scanSecrets } from '../engine/secure/secrets.ts';
import { scanAgent } from '../engine/agent/scan.ts';
import { scanIac } from '../engine/iac/iac-command.ts';
import { inventory } from '../engine/sbom/inventory.ts';
import { imageContents } from '../engine/sbom/sbom-command.ts';
import { scanContracts } from '../engine/contract/contract-command.ts';
import { NEEDS_A_LOOK } from '../engine/sbom/licences.ts';
import { sourceFiles } from '../engine/walk.ts';
import { triageSecret } from '../engine/secure/triage.ts';
import { lookAround, total } from '../engine/start/look.ts';
import { gather } from '../engine/verdict/verdict-command.ts';
import { decide } from '../engine/verdict/verdict.ts';

export interface Expectation {
  [key: string]: number;
}

export type Command = 'vouch' | 'schema' | 'access' | 'secrets' | 'agent' | 'infra' | 'sbom' | 'contract' | 'start' | 'done';

/** Counts, derived from the engine rather than from the words of a report. */
export function measure(command: Command, root: string, diff?: string): Expectation {
  // The release gate, pinned at last.
  //
  // `done` is the command with the most riding on one word: somebody reads "ready" and merges. Of
  // the nine commands pinned above it, five were read on a stranger's repository in Phase 216's
  // trust pass and four were wrong in the sentence they printed. `done` had never been read on
  // real code at all, and the first reading found it naming three distant tests while the changed
  // file's own spec sat unnamed in the same list.
  //
  // The verdict is counted one-hot rather than as a word, because a verdict that flips from
  // "cannot-say" to "ready" is the single most consequential number in this manifest and it has to
  // move a number to be noticed. `direct` beside `covering` is the Phase 216 distinction: a test
  // that imports the change and one six hops away are both "covering" and are not the same
  // evidence, so pinning only the total would not have caught what that phase fixed.
  if (command === 'done') {
    const got = gather({ root, diff: diff ?? 'HEAD~1...HEAD' });
    if (!got) return { 'no-change': 1 };
    const e = got.evidence;
    const d = decide(e);
    return {
      changed: got.changed.length,
      changedSource: e.changedSource.length,
      changedTests: e.changedTests.length,
      covering: e.covering.length,
      direct: e.covering.filter((c) => c.how === 'imports it').length,
      viaPackage: e.covering.filter((c) => c.how === 'imports the package it is in').length,
      cannotFail: e.cannotFail.length,
      crashOnly: e.crashOnly,
      couldNotJudge: e.couldNotJudge,
      met: d.checks.filter((c) => c.standing === 'met').length,
      'not-met': d.checks.filter((c) => c.standing === 'not-met').length,
      'not-checked': d.checks.filter((c) => c.standing === 'not-checked').length,
      ready: d.verdict === 'ready' ? 1 : 0,
      'not-ready': d.verdict === 'not-ready' ? 1 : 0,
      'cannot-say': d.verdict === 'cannot-say' ? 1 : 0,
    };
  }
  // The front door, pinned at last.
  //
  // `tewip start` is the first command anybody runs and the only number a new user has no way to
  // check - and it is the one command this manifest never held. That gap is why the same count
  // broke three times: Phase 185 under-counted the Flutter SDK, Phase 186 fixed it, and Phase 200
  // found it reporting **298 test files in this repository against a real 133**, because a tool
  // built out of regular expressions calls `.test(` in nearly every file it has. Each fix was
  // aimed at a reported symptom; nothing was watching the number itself.
  //
  // `stoppedEarly` is counted as a number because it changes what every other number here means:
  // the look is bounded at 4,000 files, and a count from a bounded look is "at least this many".
  // Pinning it stops a repository silently crossing that line and the counts quietly becoming
  // samples reported as totals, which is Phase 185 exactly.
  if (command === 'start') {
    const found = lookAround(root);
    return {
      tests: total(found.tests),
      languages: found.tests.size,
      markup: found.markup,
      migrations: total(found.migrations),
      manifests: total(found.manifests),
      containers: found.containers,
      unreadable: total(found.unreadable),
      'stopped-early': found.stoppedEarly ? 1 : 0,
    };
  }
  if (command === 'vouch') {
    // `['.']` is what the CLI passes when nobody names a path, and `vouchAll` does its own walking -
    // handing it the walked list again would join absolute paths onto the root a second time.
    const files = vouchAll(root, ['.']);
    const out: Expectation = { files: files.length, tests: 0 };
    for (const file of files)
      for (const judgement of file.judgements) {
        out.tests += 1;
        out[judgement.verdict] = (out[judgement.verdict] ?? 0) + 1;
      }
    return out;
  }
  if (command === 'secrets') {
    // Counted by verdict, because the number that matters is not how many shapes matched but how
    // many people are told to go and revoke something. Saleor at its pinned commit reported six of
    // those, all high, three of them the Django localhost default - the kind of false accusation
    // this corpus exists to catch, and the kind no unit test was ever going to find.
    const found = scanSecrets(root, sourceFiles(root));
    const out: Expectation = { filesRead: sourceFiles(root).length, findings: found.length, 'needs-someone': 0 };
    for (const finding of found) {
      const verdict = triageSecret(finding, root, new Set<string>()).verdict;
      out[verdict] = (out[verdict] ?? 0) + 1;
      if (verdict === 'real-risk') out['needs-someone'] += 1;
    }
    return out;
  }
  if (command === 'agent') {
    // The flagship check, and until now the one with no pinned number on real code at all.
    //
    // Its recall is measured three ways against published shapes - tools, guards and
    // prompt-injection flows - and `engine/test/confidence-is-current.test.ts` re-derives each of
    // those in CI. Its *precision* was a sentence in confidence.ts: "0 findings across 1,691 files
    // of real agent code", true when somebody ran it once and unguarded ever since. Three phases
    // of changes to this check went in against that sentence.
    //
    // Counted the way the other commands are: by the thing a person is told, not by how many
    // patterns matched. `tools` and `guards` are what the report shows, and `injections` is the
    // one where a wrong number is an accusation.
    const scan = scanAgent(root);
    const out: Expectation = {
      filesRead: scan.filesRead,
      tools: scan.tools.length,
      injections: scan.injections.length,
      guards: scan.guards.length,
    };
    for (const g of scan.guards) out[g.kind] = (out[g.kind] ?? 0) + 1;
    for (const t of scan.tools) out[`reach-${t.reach}`] = (out[`reach-${t.reach}`] ?? 0) + 1;
    return out;
  }
  if (command === 'infra') {
    // Counted by what ships, because that is the number the report leads with: a finding in a file
    // that never reaches production is a different claim from one in the image you deploy.
    const scan = scanIac(root);
    const out: Expectation = {
      filesRead: scan.dockerfiles + scan.composeFiles + scan.terraformFiles + scan.manifests,
      findings: scan.findings.length,
      ships: scan.findings.filter((f) => f.ships).length,
    };
    for (const f of scan.findings) out[f.risk] = (out[f.risk] ?? 0) + 1;
    return out;
  }
  if (command === 'sbom') {
    // `flagged` is the one a person acts on - a licence needing a decision - and `notRead` is the
    // honesty line: an ecosystem present and unreadable is a gap, not a clean bill of materials.
    const inv = inventory(root);
    const image = imageContents(root);
    return {
      components: inv.components.length,
      flagged: inv.components.filter((c) => NEEDS_A_LOOK.includes(c.licence.standing)).length,
      'dev-unknown': inv.components.filter((c) => !c.devKnown).length,
      notRead: inv.notRead.length,
      dockerfiles: image.dockerfiles,
      bases: image.bases.length,
      imagePackages: image.packages.length,
    };
  }
  if (command === 'contract') {
    // Against HEAD on a pinned clean tree, so every description is compared with itself and the
    // breaks are trivially nought. That is not what this measures. `checked` is how many real
    // OpenAPI descriptions the reader found, and `unreadable` is how many it could not parse -
    // which is exactly what engine/evidence/confidence.ts admits is unmeasured about this command.
    const scan = scanContracts({ root });
    return {
      checked: scan.checked,
      unreadable: scan.files.filter((f) => f.unreadable).length,
      breaks: scan.files.reduce((n, f) => n + f.breaks.length, 0),
      isNew: scan.isNew.length,
    };
  }
  if (command === 'access') {
    const { findings, filesRead } = findBarriers(root);
    const out: Expectation = { filesRead, findings: findings.length };
    for (const f of findings) out[f.confidence] = (out[f.confidence] ?? 0) + 1;
    return out;
  }
  const files = migrationsUnder(root);
  const out: Expectation = { filesRead: 0, findings: 0 };
  for (const file of files) {
    const migration = readMigration(root, file);
    if (migration.unread) continue;
    out.filesRead += 1;
    for (const f of migration.findings) {
      out.findings += 1;
      out[f.risk] = (out[f.risk] ?? 0) + 1;
    }
  }
  return out;
}
