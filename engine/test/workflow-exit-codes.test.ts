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
