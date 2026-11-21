// A gate that cannot fail is not a gate.
//
// `channels.yml` ran every night for nine days while npm sat a release behind. It printed BEHIND
// every time, in full, into the job summary - and reported success every time, because of this:
//
//     node scripts/channels.ts | tee answer.txt
//     code=$?
//
// After a pipeline `$?` is the status of the last command in it. That is `tee`, which always
// succeeds, so `code` was always 0 and the `exit 1` below it was unreachable. The check was right
// and nobody was told.
//
// Nothing could have caught it: the script has tests, the YAML parses, and the step is three lines
// of shell that no suite runs. So the suite reads the shell instead. This cannot prove a workflow
// works, and it can refuse the one shape that silently throws an exit code away.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const NL = String.fromCharCode(10);
const DIR = '.github/workflows';
const workflows = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('a workflow step that reads an exit code', () => {
  it('has workflows to read', () => {
    assert.ok(workflows.length > 0, 'no workflow files found');
  });

  for (const file of workflows) {
    it(`does not take $? from a pipeline in ${file}`, () => {
      const lines = readFileSync(join(DIR, file), 'utf8').split(NL);
      const offenders: string[] = [];
      for (const [i, line] of lines.entries()) {
        // `code=$?` immediately after a line that pipes: the status captured is the last stage's.
        if (!/^\s*\w+=\$\?\s*$/.test(line)) continue;
        const before = (lines[i - 1] ?? '').replace(/#.*$/, '');
        const pipes = /\|(?!\|)/.test(before);
        if (pipes) offenders.push(`line ${i + 1}: reads $? from "${before.trim().slice(0, 60)}"`);
      }
      assert.deepEqual(offenders, [], `${file} throws an exit code away:${NL}${offenders.join(NL)}`);
    });
  }
});

// Phase 203. The other way a gate stops being read: it fails when nobody asked it a question, and
// the owner stops believing the word "failed".
//
// `scripts/corpus.ts` exits 1 whenever a pinned number moves, which is right for the weekly run and
// for a release tag - nobody asked, and a number that drifted unnoticed is the whole fear. It is
// wrong for a run dispatched by hand, which is somebody asking what a fix moved. Three of those
// went out in one afternoon as "corpus: All jobs have failed", every one dispatched on purpose, and
// from the email they are indistinguishable from a broken build.
describe('the corpus gate fails where failing means something', () => {
  const corpus = readFileSync(join(DIR, 'corpus.yml'), 'utf8');

  it('reports rather than fails when the run was dispatched by hand', () => {
    const run = corpus.split(NL).find((l) => l.includes('scripts/corpus.ts'));
    assert.ok(run, 'corpus.yml must run scripts/corpus.ts');
    assert.match(run, /--asking/, 'a dispatched run must pass --asking, or it emails a failure for a question');
    assert.match(run, /workflow_dispatch/, '--asking must be conditional on the dispatch, not always on');
  });

  it('still fails on the schedule and on a release tag, which is where the guard lives', () => {
    // Guarding the guard: if the condition is ever loosened to "always", the weekly run stops
    // failing on drift and the corpus becomes decoration.
    const run = corpus.split(NL).find((l) => l.includes('scripts/corpus.ts')) ?? '';
    assert.doesNotMatch(run, /^\s*run:\s*node scripts\/corpus\.ts[^\n]*--asking\s*$/, '--asking must not be unconditional');
    assert.match(corpus, /schedule:/, 'the weekly run is half the guard');
    assert.match(corpus, /tags:\s*\['v\*'\]/, 'a release tag is the other half');
  });

  it('refuses a repository name that matches nothing, instead of checking none', () => {
    //  printed "Every number still holds" and exited 0,
    // having re-derived not one number. The dispatch input is a free-text box, so one typo bought
    // a green run over 0 of 14 repositories. Behavioural, because the textual version of this
    // check is what a vacuous guard looks like.
    const ran = spawnSync('node', ['scripts/corpus.ts', 'nosuchrepo'], { encoding: 'utf8' });
    assert.equal(ran.status, 1, 'a name matching nothing must fail, not report a clean run');
    assert.match(ran.stderr, /No repository here is called/, 'and it must say which names exist');
  });

  it('does not read a flag as the name of a repository', () => {
    // `only` was `process.argv[2]`, with `only === '--record'` special-cased beside it. A second
    // flag would have been taken as a repository name, matched nothing, and the run would have
    // checked no repositories at all while printing "Every number still holds".
    const src = readFileSync(join('scripts', 'corpus.ts'), 'utf8');
    assert.match(src, /process\.argv\.slice\(2\)\.find\(\(a\) => !a\.startsWith\('--'\)\)/, 'the repository name must be the first non-flag argument');
  });
});
