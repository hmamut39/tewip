// Can `incident` read a real stack trace, and does it only claim your code when it is your code?
//
// `incident` writes a reproduction against "the code the trace names", and the code it names is
// `ourFrames(incident)[0]`. Two things have to hold for that to be worth anything: the frames must
// parse, and a frame must only be called yours when it actually names a file in your project.
//
// There is real input for this and it needs no network. The kept histories hold 7,984 stack traces
// from strangers' CI runs, in V8, Python, JVM and - the one that caught this - Firefox syntax,
// which prints `name@location` rather than `at name (location)`.
//
// Two numbers, re-derived rather than quoted from a commit message:
//   - how many traces yield a frame at all, and how many of the rest genuinely contain no frame
//   - how many frames are claimed as the project's own code while not naming a file
//
// The second must be zero. Before Phase 114 it was 114.
//
// Usage: node eval/incident-frames.ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { framesFromStack } from '../engine/incident/incident.ts';

/** A line that names code at a line number, in any syntax a real runner prints. */
const NAMES_CODE = [
  /^\s*at\s+\S/, // V8, JVM, C#
  /^\s*File\s+"[^"]+",\s+line\s+\d+/, // Python
  /^[^\s@]*@\S+:\d+:\d+$/, // Firefox, Safari
  /^\s*\S+\.rb:\d+:in\b/, // Ruby
  /^\s*\S+\.go:\d+(\s|$)/, // Go
];

const DATA = resolve('data/real');
const datasets = existsSync(DATA) ? readdirSync(DATA).filter((d) => existsSync(join(DATA, d, 'triage.jsonl'))) : [];

let withText = 0;
let parsed = 0;
let haveOwn = 0;
let frames = 0;
const missed: string[] = [];
const claimedNotAFile: string[] = [];

for (const dataset of datasets) {
  for (const line of readFileSync(join(DATA, dataset, 'triage.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const stack = (JSON.parse(line) as { errorStack?: string }).errorStack ?? '';
    if (!stack.trim()) continue;
    withText += 1;
    const read = framesFromStack(stack);
    frames += read.length;
    if (read.length > 0) parsed += 1;
    if (read.some((f) => f.ours)) haveOwn += 1;

    // A trace that parsed to nothing is only a miss if it does contain a frame.
    if (read.length === 0) {
      const looksLikeOne = stack.split('\n').find((l) => NAMES_CODE.some((re) => re.test(l)));
      if (looksLikeOne && missed.length < 10) missed.push(`  ${dataset}: ${looksLikeOne.trim().slice(0, 140)}`);
    }

    // The claim that matters: this is your code, write a test against it.
    for (const f of read) {
      if (!f.ours) continue;
      const isAFile = /[\\/]/.test(f.file) || /\.[a-z0-9]{1,10}$/i.test(f.file);
      if (!isAFile && claimedNotAFile.length < 10) claimedNotAFile.push(`  ${dataset}: claimed "${f.file}" as your code`);
    }
  }
}

const pct = (n: number): string => (withText === 0 ? 'n/a' : `${((n / withText) * 100).toFixed(1)}%`);

console.log('');
console.log('# Can incident read a real stack trace?');
console.log('');
console.log(`Read from ${datasets.length} kept histories: ${withText} stack traces, ${frames} frames.`);
console.log('');
console.log(`  parsed into at least one frame   ${parsed} (${pct(parsed)})`);
console.log(`  of those, one is your own code   ${haveOwn} (${pct(haveOwn)})`);
console.log(`  parsed into nothing              ${withText - parsed} (${pct(withText - parsed)})`);
console.log('');

if (missed.length > 0) {
  console.log('## Traces that name code and were read as naming none');
  console.log('');
  for (const m of missed) console.log(m);
  console.log('');
}
if (claimedNotAFile.length > 0) {
  console.log('## Frames claimed as your code that do not name a file');
  console.log('');
  for (const c of claimedNotAFile) console.log(c);
  console.log('');
  process.exit(1);
}
if (missed.length > 0) process.exit(1);

console.log('Every trace that names code was read as naming it, and nothing that is not a file was');
console.log('offered as somewhere to write a test. The traces that parsed into nothing contain no');
console.log('frame to parse: they are runner banners and assertion diffs.');
