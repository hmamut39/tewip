// The evidence pack, and the two things that would make it worthless.
//
// The first is the folder bug it found on its own first run: `tewip sbom --out sbom.md` read a
// folder called `sbom.md`, found nothing, and printed a complete, confident, empty bill of
// materials. Six verbs shared the line. The tests below pin the fix and, more usefully, pin the
// rule that caught it - that a verb's list of value-taking flags has to cover the flags it reads.
//
// The second is a section that says nothing when a check could not run. A pack is signed and sent
// to somebody who will not re-run it, so an empty section reading as a clean one is the one defect
// that cannot be allowed anywhere near it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { flag, folderArg } from '../../cli/args.ts';
import { HELP } from '../../cli/help.ts';
import { check } from '../attest/seal.ts';
import { MEASURED } from '../evidence/confidence.ts';
import { bundleOf, needsAPerson, runEvidence } from '../evidence/evidence-command.ts';
import { gather, subjectOf, type Evidence, type Part } from '../evidence/gather.ts';
import { CHECKS, renderEvidence } from '../evidence/render.ts';
import { answer } from '../evidence/sections.ts';
import { looksPlanted } from '../secure/secrets.ts';

const CLI_DIR = join(import.meta.dirname, '..', '..', 'cli');

describe('the folder a verb was pointed at', () => {
  it('does not mistake the value of a flag for the folder', () => {
    // The bug, exactly as it shipped: this is the invocation the help text tells people to use.
    assert.equal(folderArg(['--out', 'sbom.md'], ['out']), undefined);
    assert.equal(folderArg(['--json', 'pack.json', '--since', 'HEAD~1'], ['json', 'since']), undefined);
  });

  it('still reads an explicit folder, before or after the flags', () => {
    assert.equal(folderArg(['./repo', '--out', 'x.md'], ['out']), './repo');
    assert.equal(folderArg(['--out', 'x.md', './repo'], ['out']), './repo');
  });

  it('is not fooled by the --out=value form, which consumes nothing after it', () => {
    assert.equal(folderArg(['--out=x.md', './repo'], ['out']), './repo');
  });

  it('leaves a folder alone after a flag that takes no value', () => {
    assert.equal(folderArg(['--gate', './repo'], ['out']), './repo');
    assert.equal(folderArg(['--quick', '--gate', './repo'], ['out']), './repo');
  });

  it('no verb module searches for the first undashed argument itself', () => {
    // The structural half of the fix: the next verb to be written cannot reintroduce the bug by
    // copying the line above it, because the line is not there to copy.
    for (const file of ['verbs-assure.ts', 'verbs-prove.ts', 'verbs-work.ts']) {
      const text = readFileSync(join(CLI_DIR, file), 'utf8');
      assert.ok(
        !/args\s*\.\s*find\s*\(\s*\(\s*a\s*\)\s*=>\s*!\s*a\s*\.\s*startsWith/.test(text),
        `${file} finds its folder by searching for the first undashed argument, which is the value of --out`,
      );
    }
  });

  it('gives folderArg every value-taking flag the same verb reads', () => {
    // The guard that generalises. Each `folderArg(args, [...])` has to list every flag name the
    // same `case` block passes to `flag(args, ...)`; a flag added later and left out of the list
    // puts the bug back for that one verb, silently, in exactly the shape it had before.
    const text = readFileSync(join(CLI_DIR, 'verbs-assure.ts'), 'utf8');
    const blocks = text.split(/case '/).slice(1);
    for (const block of blocks) {
      const verb = block.slice(0, block.indexOf("'"));
      const listed = /folderArg\(args,\s*\[([^\]]*)\]/.exec(block);
      if (!listed) continue;
      const declared = new Set([...listed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
      const read = [...block.matchAll(/flag\(args,\s*'([^']+)'\)/g)].map((m) => m[1]);
      const missing = read.filter((f) => !declared.has(f));
      assert.deepEqual(missing, [], `tewip ${verb} reads --${missing.join(', --')} but does not tell folderArg, so that flag's value will be read as the folder`);
    }
  });
});

describe('a check that could not run', () => {
  const refused: Part<string> = { refused: 'the lockfile could not be read', seconds: 0.1 };

  it('says so in place of its answer, rather than rendering nothing', () => {
    const out = answer(refused, () => ['everything is fine']);
    assert.ok(out.join(' ').includes('Not established'), 'a refusal must be stated, not left as an empty section');
    assert.ok(!out.join(' ').includes('everything is fine'), 'the body must not run for a refused check');
  });

  it('warns the reader not to take the section as a clean result', () => {
    assert.match(answer(refused, () => []).join(' '), /should be read as a clean result/i);
  });

  it('is counted as established nothing in the summary, not quietly dropped', () => {
    const e = gather({ root: mkdtempSync(join(tmpdir(), 'tewip-ev-')), quick: true });
    const bundle = bundleOf(e, 'x');
    assert.equal(bundle.checks.length, CHECKS.length, 'every check must appear in the bundle, whether it ran or not');
    const skipped = bundle.checks.filter((c) => !c.established);
    assert.ok(skipped.length >= 3, 'the three --quick checks must be reported as not established');
    for (const c of skipped) assert.ok(c.refused, `${c.command} established nothing and must say why`);
  });
});

describe('what the pack is about', () => {
  it('never lists a file outside the folder it was pointed at', () => {
    // The defect this pins is a privacy leak, not a cosmetic one. Git walks *up* for a repository,
    // and a home directory can itself be one - so a pack about any folder beneath it listed
    // `.bash_history`, `.claude.json` and every other dotfile as differing from the commit, inside
    // a document built to be signed and sent outside the company.
    const dir = mkdtempSync(join(tmpdir(), 'tewip-scope-'));
    writeFileSync(join(dir, 'only-file.txt'), 'x', 'utf8');
    const s = subjectOf(dir);
    for (const f of s.dirty) {
      assert.ok(
        f.includes(basename(dir)),
        `${f} is outside the folder this pack is about, so the pack is reporting somebody else's files`,
      );
    }
  });

  it('says so when the folder is only part of a bigger repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tewip-part-'));
    const s = subjectOf(dir);
    // Either this folder is in no repository at all, or it is inside one and must name it rather
    // than present that repository's commit as though the pack covered all of it.
    if (s.commit || s.noGit?.includes('no commits')) {
      assert.ok(s.partOf, 'a folder that is not the root of its repository must name the repository');
      assert.match(renderEvidence({ ...gather({ root: dir, quick: true }), subject: s }), /part of a larger repository/);
    }
  });

  it('lists every changed file, with its whole name', () => {
    // `git()` trimmed its own output, which strips the leading status column of the **first**
    // porcelain line only, so the first dirty file came out as `li/args.ts`.
    //
    // The first version of this test read this repository's own working tree and looped over
    // whatever it found. Sabotage proved it worthless: with the trim back in place the first line
    // no longer matches `XY <path>` at all, so it is dropped rather than mangled, and a loop over
    // the survivors sees nothing wrong. A test for "nothing was lost" cannot be written against a
    // list whose contents it does not know - so this builds the repository and names the answer.
    const dir = mkdtempSync(join(tmpdir(), 'tewip-dirty-'));
    const g = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    };
    g('init', '-q');
    writeFileSync(join(dir, 'alpha.txt'), 'one', 'utf8');
    writeFileSync(join(dir, 'beta.txt'), 'two', 'utf8');
    g('add', '-A');
    g('commit', '-qm', 'first');
    writeFileSync(join(dir, 'alpha.txt'), 'changed', 'utf8');
    writeFileSync(join(dir, 'gamma.txt'), 'new', 'utf8');
    // alpha.txt is modified and sorts first, which is exactly the position the bug lived in.
    assert.deepEqual(subjectOf(dir).dirty.sort(), ['alpha.txt', 'gamma.txt']);
  });

  it('says a dirty tree does not describe the commit it names', () => {
    const e = gather({ root: join(import.meta.dirname, '..', '..'), quick: true });
    if (e.subject.dirty.length === 0) return;
    assert.match(renderEvidence(e), /working tree was not clean/);
  });
});

describe('the document and its seal', () => {
  const root = join(import.meta.dirname, '..', '..');

  it('covers the words a person reads, so changing them breaks the digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tewip-seal-'));
    const { bundle } = runEvidence({ root, quick: true, json: join(dir, 'p.json') });
    assert.ok(bundle.seal?.digest, 'the bundle must carry a digest');
    assert.equal(check(bundle as never).contentMatches, true);
    // The claim the seal makes: edit the finding and the digest no longer matches.
    const edited = { ...bundle, document: bundle.document.replace('Not established', 'All clear') };
    assert.equal(check(edited as never).contentMatches, false, 'the digest must cover the document itself');
  });

  it('does not call a digest a signature', () => {
    const { report } = runEvidence({ root, quick: true });
    assert.match(report, /No signature/);
    assert.match(report, /not that nobody edited it/);
  });

  it('writes the file it says it wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tewip-out-'));
    runEvidence({ root, quick: true, out: join(dir, 'pack.md') });
    assert.match(readFileSync(join(dir, 'pack.md'), 'utf8'), /# Evidence pack/);
  });
});

describe('the confidence table', () => {
  it('names a harness for every number, so a reader can re-derive it', () => {
    for (const m of MEASURED) {
      assert.match(m.from, /^eval\/[\w-]+\.ts$/, `${m.check} must name the harness that produces its number`);
      assert.ok(m.groundTruth.length > 20, `${m.check} must say what list it was measured against`);
    }
  });

  it('is in the document for the checks that ran, and not for the ones that did not', () => {
    const e = gather({ root: join(import.meta.dirname, '..', '..'), quick: true });
    const doc = renderEvidence(e);
    // secure is one of the three --quick skips, so its number must not be quoted as backing a
    // claim this run never made.
    assert.ok(!doc.includes('eval/secure-recall.ts'), 'a skipped check must not contribute a confidence row');
    assert.ok(doc.includes('eval/schema-recall.ts'), 'a check that ran must contribute its number');
  });
});

describe('a credential somebody is writing about', () => {
  it('is not reported as a live credential', () => {
    const line = '"verified": "2026-10-31. Pinned to hold Phase 127. All three findings read by hand: a Slack token in a README table, `xoxb-4913726584-ZqVn7Tk2Lm9B`';
    assert.match(looksPlanted('xoxb-4913726584-ZqVn7Tk2Lm9B', line, 'corpus/expected.json') ?? '', /written about rather than used/);
  });

  it('counts a sentence that ends on a digit, which is what its own founding case did', () => {
    // The character before the full stop was first restricted to letters, and both sentences in
    // the note that prompted the rule end on a number.
    const line = 'We rotated every one of these on 2026-10-31. The old value we had committed was xoxb-4913726584-ZqVn7Tk2Lm9B, and it is dead now';
    assert.ok(looksPlanted('xoxb-4913726584-ZqVn7Tk2Lm9B', line, 'notes.md'), 'a sentence ending in a number still ends a sentence');
  });

  it('would rather report a real credential than dismiss one, so ten words is the floor', () => {
    // The threshold is deliberately on the cautious side of the trade. A dismissal that is too
    // eager hides a live credential; one that is too shy prints a finding somebody reads and
    // closes. Nine words of prose is not enough to earn a dismissal.
    const nine = 'We rotated this one last month and it was xoxb-4913726584-ZqVn7Tk2Lm9B';
    assert.equal(looksPlanted('xoxb-4913726584-ZqVn7Tk2Lm9B', nine, 'notes.md'), null);
  });

  it('does not dismiss a credential that is simply assigned, however it is quoted', () => {
    for (const line of ['const token = `xoxb-4913726584-ZqVn7Tk2Lm9B`;', 'slack_token: xoxb-4913726584-ZqVn7Tk2Lm9B', 'TOKEN="xoxb-4913726584-ZqVn7Tk2Lm9B"']) {
      assert.equal(looksPlanted('xoxb-4913726584-ZqVn7Tk2Lm9B', line, 'app.ts'), null, `dismissed a real assignment: ${line}`);
    }
  });

  it('needs prose and not merely a few words, so a short label does not excuse it', () => {
    assert.equal(looksPlanted('xoxb-4913726584-ZqVn7Tk2Lm9B', 'the key. xoxb-4913726584-ZqVn7Tk2Lm9B', 'app.ts'), null);
  });
});

describe('what the pack leaves to a person', () => {
  it('reports a broken audit chain as needing somebody', () => {
    const e = { approvals: { result: { entries: [{}], edited: [], broken: [3], unreadable: [] }, seconds: 0 } } as unknown as Evidence;
    assert.ok(needsAPerson(e).some((p) => /audit log has been changed/.test(p)));
  });

  it('asks nobody for anything on an empty project', () => {
    const e = gather({ root: mkdtempSync(join(tmpdir(), 'tewip-empty-')) });
    assert.deepEqual(needsAPerson(e), []);
  });

  it('names a tool that cannot be taken back when nothing guards it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tewip-tool-'));
    writeFileSync(
      join(dir, 'app.py'),
      ['from langchain.tools import tool', '', '@tool', 'def delete_account(user_id: str) -> str:', '    """Delete a user account for good."""', '    return "gone"', ''].join('\n'),
      'utf8',
    );
    const e = gather({ root: dir });
    assert.ok(
      needsAPerson(e).some((p) => /cannot be taken back/.test(p)),
      `a deleting tool with no guard anywhere must reach a person; got ${JSON.stringify(needsAPerson(e))}`,
    );
  });
});

describe('an eval harness', () => {
  it('is not read as tools the project ships', () => {
    // The pack's first run against this repository reported five tools that can delete, pay or
    // send. Every one was planted in `eval/` by the harness that measures this very check: the one
    // directory certain to be full of the most alarming examples somebody could write on purpose.
    const dir = mkdtempSync(join(tmpdir(), 'tewip-eval-'));
    mkdirSync(join(dir, 'eval'));
    mkdirSync(join(dir, 'src'));
    const docstring = `${'"'.repeat(3)}Delete everything for good.${'"'.repeat(3)}`;
    const tool = (name: string) =>
      ['from langchain.tools import tool', '', '@tool', `def ${name}(x: str) -> str:`, `    ${docstring}`, '    return "gone"', ''].join('\n');
    writeFileSync(join(dir, 'eval', 'recall.py'), tool('delete_planted'), 'utf8');
    writeFileSync(join(dir, 'src', 'app.py'), tool('delete_real'), 'utf8');
    const names = (gather({ root: dir }).agent.result?.tools ?? []).map((t) => t.name);
    assert.ok(!names.includes('delete_planted'), `a tool planted in eval/ was reported as shipped: ${JSON.stringify(names)}`);
    assert.ok(names.includes('delete_real'), 'excluding eval/ must not also hide the real tool beside it');
  });
});

describe('the help', () => {
  it('documents every flag evidence reads, in evidence own block', () => {
    // The first version of this asked whether each flag appeared anywhere in the help, which every
    // one of them does: `--out` and `--key` belong to half the verbs. It would have passed with the
    // evidence block deleted. So the block is cut out first, and the flags looked for inside it.
    const block = /\n {2}tewip evidence[\s\S]*?(?=\n {2}tewip attest)/.exec(HELP);
    assert.ok(block, 'the help has no tewip evidence block at all');
    const read = [...readFileSync(join(CLI_DIR, 'verbs-assure.ts'), 'utf8').split("case 'evidence':")[1].split("case '")[0].matchAll(/flag\(args, '([^']+)'\)|args\.includes\('--([^']+)'\)/g)]
      .map((m) => m[1] ?? m[2])
      .filter((f) => f !== 'verify');
    assert.ok(read.length >= 4, `expected to find the flags evidence reads; found ${JSON.stringify(read)}`);
    const missing = read.filter((f) => !block[0].includes(`--${f}`));
    assert.deepEqual(missing, [], `tewip evidence reads --${missing.join(', --')} and its own help block does not mention it`);
    assert.equal(flag(['--key', 'k.pem'], 'key'), 'k.pem');
  });
});
