// Can `spec` tell a real quote from a plausible one, on real code?
//
// `spec` writes an epic and its stories, and the rule it is held to is that anything it says the
// system *already does* must be quoted from a file Tewip read. `quoteHolds` is what enforces that:
// a claim whose quote does not check out is demoted to an open question. So `quoteHolds` is the
// only thing standing between a reader and a confident sentence about code that does not exist.
//
// It has been wrong before. It used to collect a quote's "distinctive parts" and require each to
// appear somewhere in the file in any order, and three fabrications got through - the worst being
// `const rate = Math.min(percent, 20) / 100;` offered as proof of a 20% discount cap, against a
// file that says 100. `20` is two characters, below the `{3,}` floor, so the one token carrying
// the whole meaning was the one token never compared.
//
// It was fixed to require a contiguous match, and then never measured on real code. This measures
// it, against the corpus: every repository is a stranger's real source in a real language.
//
//   recall    - a line copied verbatim out of a real file must be accepted.
//   precision - a line a model could plausibly produce, that the file does not contain, must be
//               rejected. The mutations below are the ways a model misquotes: one digit changed,
//               one identifier swapped, two real lines welded together, real words reordered.
//
// A single false accept here is a fabrication with a citation, so the bar is zero.
//
// Usage: node eval/spec-quotes.ts   (needs the corpus: npm run corpus)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { quoteHolds } from '../engine/spec/spec.ts';

const CACHE = process.env.TEWIP_CORPUS ?? join(process.env.TEMP ?? '/tmp', 'tewip-corpus');
const CODE = /\.(ts|tsx|js|jsx|py|rb|go|java|cs|php|sql)$/i;
const SKIP = /[\\/](?:node_modules|\.git|dist|build|vendor|target|__pycache__)[\\/]/;

/** A sample of real source files, breadth first so the languages stay mixed. */
function sourceFiles(root: string, want: number): string[] {
  const found: string[] = [];
  const queue = [root];
  while (queue.length > 0 && found.length < want) {
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (SKIP.test(`${path}/`)) continue;
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) queue.push(path);
      else if (CODE.test(name) && info.size > 200 && info.size < 400_000) found.push(path);
      if (found.length >= want) break;
    }
  }
  return found;
}

/** Exactly the normalisation `quoteHolds` applies, so this script asks the same question it does. */
const squash = (text: string): string => text.replace(/["'`]/g, '"').replace(/\s+/g, ' ').trim();

/** Lines worth quoting: long enough to be distinctive, not a comment or a brace. */
const quotable = (content: string): string[] =>
  content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 25 && l.length <= 160 && !/^(\/\/|#|\*|<!--)/.test(l));

/** The ways a model misquotes a line it is looking straight at. */
function fabrications(line: string, others: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  // One digit changed. The failure that started this: 20 became 100 and nothing noticed.
  const digit = line.replace(/\d+/, (n) => String(Number(n) + 7));
  if (digit !== line) out.push(['a number changed', digit]);
  // One identifier swapped for another that is also in the file.
  const words: string[] = line.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? [];
  const theirWords: string[] = others.join(' ').match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? [];
  const elsewhere = theirWords.filter((w) => !words.includes(w));
  const mine = words[0];
  const theirs = elsewhere[0];
  if (mine && theirs) out.push(['an identifier swapped', line.replace(mine, theirs)]);
  // Two real lines welded into one the file has never contained.
  const other = others[0];
  if (other) out.push(['two real lines welded', `${line.slice(0, Math.floor(line.length / 2))}${other.slice(0, 40)}`]);
  // Real words of the line, in an order the file has never had.
  const parts = line.split(/\s+/);
  if (parts.length > 3) out.push(['the words reordered', [...parts].reverse().join(' ')]);
  return out;
}

const repos = existsSync(CACHE) ? readdirSync(CACHE).filter((d) => statSync(join(CACHE, d)).isDirectory()) : [];
if (repos.length === 0) {
  console.log(`\nNo corpus at ${CACHE}. Run \`npm run corpus\` first; this measures against real repositories, not fixtures.`);
  process.exit(2);
}

let realQuotes = 0;
let accepted = 0;
let fabricated = 0;
let falselyAccepted = 0;
const byKind = new Map<string, { tried: number; passed: number }>();
const offenders: string[] = [];
const missed: string[] = [];

for (const repo of repos) {
  for (const path of sourceFiles(join(CACHE, repo), 12)) {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const name = path.replace(/\\/g, '/').split('/').slice(-2).join('/');
    const sources = [{ file: name, content }];
    const lines = quotable(content);
    if (lines.length < 4) continue;

    for (const line of lines.slice(0, 6)) {
      realQuotes += 1;
      if (quoteHolds(`${name}: ${line}`, sources)) accepted += 1;
      else if (missed.length < 8) missed.push(`  ${repo}/${name}: ${line.slice(0, 110)}`);

      // A quote is compared against the file with whitespace squashed, so a newline reads as a
      // space and a quote may legitimately span two lines. That means "is this text in the file?"
      // has to be asked the same way `quoteHolds` asks it - the first version of this script asked
      // it of the raw content and so counted two accepts as fabrications that were nothing of the
      // kind. `from datetime import datetime` followed by `from factory import (` really does
      // contain "datetime import datetime from", and accepting it is correct, if inelegant.
      //
      // Worth knowing rather than fixing: a quote may therefore be two halves of two statements
      // that read as one. No model has been seen to produce such a thing, and forbidding it would
      // reject every honest two-line quote, so the behaviour stands and is written down here.
      for (const [kind, fake] of fabrications(line, lines.filter((l) => l !== line).slice(0, 3))) {
        if (fake === line || squash(content).includes(squash(fake))) continue; // the file does have it
        fabricated += 1;
        const tally = byKind.get(kind) ?? { tried: 0, passed: 0 };
        tally.tried += 1;
        if (quoteHolds(`${name}: ${fake}`, sources)) {
          tally.passed += 1;
          falselyAccepted += 1;
          if (offenders.length < 8) offenders.push(`  ${repo}/${name} [${kind}]: ${fake.slice(0, 110)}`);
        }
        byKind.set(kind, tally);
      }
    }
  }
}

const pct = (n: number, of: number): string => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

console.log('');
console.log('# Can spec tell a real quote from a plausible one?');
console.log('');
console.log(`Read from ${repos.length} real repositories in ${CACHE}.`);
console.log('');
console.log(`  real lines quoted      ${realQuotes}`);
console.log(`    accepted             ${accepted} (${pct(accepted, realQuotes)})`);
console.log(`  fabrications tried     ${fabricated}`);
console.log(`    wrongly accepted     ${falselyAccepted} (${pct(falselyAccepted, fabricated)})`);
console.log('');
console.log('  by the way a quote goes wrong:');
for (const [kind, { tried, passed }] of byKind) {
  console.log(`    ${kind.padEnd(24)} ${String(tried).padStart(5)} tried, ${passed} got through`);
}
console.log('');

if (missed.length > 0) {
  console.log('## Real lines it would not accept (a story loses its evidence)');
  console.log('');
  for (const m of missed) console.log(m);
  console.log('');
}
if (offenders.length > 0) {
  console.log('## Fabrications it accepted - each one is a false claim with a citation');
  console.log('');
  for (const o of offenders) console.log(o);
  console.log('');
}
if (falselyAccepted > 0 || accepted < realQuotes) process.exit(1);

console.log('Every real line was accepted and every fabrication refused. A claim that cannot be');
console.log('quoted becomes an open question, which is where an unverifiable claim belongs.');
