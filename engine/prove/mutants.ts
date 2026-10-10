// Phase 23: small, deliberate breakages of real code, to find out what the tests would not notice.
//
// `vouch` reads a test and says whether it *could* fail. This asks the harder question, and answers
// it by execution rather than by reading: break the code the test covers, run the test, and see. A
// change nobody notices is a hole in the suite that no coverage percentage will ever show, because
// the line was covered - it just was not checked.
//
// Three rules shape what may be changed, and all three exist to keep the answer trustworthy:
//
// 1. **Only code.** Strings and comments are skipped, reusing the same mask `vouch` uses. Changing a
//    word in a message is not a bug a test should be expected to catch.
// 2. **Nothing that can hang.** Loop headers are never touched. A flipped comparison in a `while`
//    condition does not fail a test, it runs forever, and a tool that hangs a developer's machine
//    gets uninstalled. This is the same lesson as the fork bomb in Phase 21, learned once.
// 3. **One change at a time**, always restored. A mutant is a question, not an edit.
import { textRanges } from '../vouch/tests-in.ts';

export interface Mutant {
  line: number;
  /** The line as it is. */
  was: string;
  /** The line with one thing changed. */
  now: string;
  /** What kind of mistake this imitates, in a reviewer's words. */
  kind: string;
}

/** A line that could loop: never touched, because a wrong comparison there hangs instead of failing. */
const COULD_LOOP = /\b(for|while|do|loop|repeat|until)\b\s*[({:]|\bfor\b.*\bin\b|\.\s*(forEach|map|filter|reduce|while)\s*\(/;

/** A line that only reports, logs or types: changing it says nothing about behaviour. */
const NOT_BEHAVIOUR = /^\s*(\/\/|#|\*|\/\*|@|import\b|from\b|export\s+(type|interface)\b|use\s|package\b|using\b|require\b|const\s+\w+\s*=\s*require)|console\s*\.|print\s*\(|println|log(ger)?\s*\.|process\.(stdout|stderr)|fmt\s*\.\s*Print/;

/**
 * The changes worth making, in the order they are worth making them. Each is a mistake a person or an
 * agent really makes: a boundary off by one, a condition inverted, an `and` that should be an `or`, a
 * sign the wrong way round, a flag returned the wrong way.
 */
const OPERATORS: Array<{ kind: string; find: RegExp; swap: (m: string) => string }> = [
  // Whitespace on both sides, which is what separates a comparison from a generic type. Without it,
  // `Array<{ id: string }>` was read as a comparison and mutated into `Array<={ … }>`: the file stopped
  // compiling, the whole suite failed to load, and the measurement counted a mutant nothing caught.
  // A codebase that writes `a<b` loses a few mutants; one that breaks its build loses the answer.
  { kind: 'a boundary moved by one', find: /(?<=\s)<=(?=\s)/, swap: () => '<' },
  { kind: 'a boundary moved by one', find: /(?<=\s)>=(?=\s)/, swap: () => '>' },
  { kind: 'a boundary moved by one', find: /(?<=\s)<(?=\s)/, swap: () => '<=' },
  { kind: 'a boundary moved by one', find: /(?<=\s)>(?=\s)/, swap: () => '>=' },
  { kind: 'a comparison inverted', find: /===/, swap: () => '!==' },
  { kind: 'a comparison inverted', find: /(?<![!=<>])==(?!=)/, swap: () => '!=' },
  { kind: 'a comparison inverted', find: /!==/, swap: () => '===' },
  { kind: 'a comparison inverted', find: /(?<![!=<>])!=(?!=)/, swap: () => '==' },
  { kind: 'an "and" that became an "or"', find: /&&/, swap: () => '||' },
  { kind: 'an "or" that became an "and"', find: /\|\|/, swap: () => '&&' },
  { kind: 'a condition inverted', find: /\bif\s*\(\s*!/, swap: (m) => m.replace('!', '') },
  { kind: 'a sign reversed', find: /(?<=[\w)\]]\s?)\+(?=\s?[\w(])/, swap: () => '-' },
  { kind: 'a sign reversed', find: /(?<=[\w)\]]\s?)-(?=\s?[\w(])/, swap: () => '+' },
  { kind: 'a returned flag flipped', find: /\breturn\s+true\b/, swap: () => 'return false' },
  { kind: 'a returned flag flipped', find: /\breturn\s+false\b/, swap: () => 'return true' },
  { kind: 'a returned value emptied', find: /\breturn\s+(?!null|undefined|None|nil|true|false|;|$)[\w.[\]]+\s*;?\s*$/, swap: (m) => (m.trimEnd().endsWith(';') ? 'return null;' : 'return null') },
];

/**
 * Is this position inside a regular expression literal?
 *
 * Only a rough reading, and it only decides what a change is *called*, never whether it is safe: a
 * slash that opens a pattern follows an operator, a bracket or a keyword, never a value, which is what
 * separates `/re/` from division.
 */
function inPattern(line: string, at: number): boolean {
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '/') {
      i += 1;
      continue;
    }
    const before = line.slice(0, i).trimEnd();
    const opens = before === '' || /[=(,:[!&|?{;]$|\b(return|typeof|case|of|in|and|or|not)$/.test(before);
    if (!opens) {
      i += 1;
      continue;
    }
    // Find the closing slash, ignoring one escaped by a backslash and one inside a character class.
    let cls = false;
    for (let j = i + 1; j < line.length; j += 1) {
      const ch = line[j];
      if (ch === String.fromCharCode(92)) {
        j += 1;
        continue;
      }
      if (ch === '[') cls = true;
      else if (ch === ']') cls = false;
      else if (ch === '/' && !cls) {
        if (at > i && at < j) return true;
        i = j + 1;
        break;
      }
      if (j === line.length - 1) return false; // never closed on this line
    }
    if (i < line.length && line[i] === '/') i += 1;
  }
  return false;
}

/**
 * The mutants worth trying for this file, spread over the file rather than taken from the top: five
 * changes to one function say much less about a suite than five changes in five places.
 */
export function mutantsFor(text: string, limit = 6): Mutant[] {
  const ranges = textRanges(text);
  const lines = text.split(String.fromCharCode(10));
  const offsets: number[] = [];
  let seen = 0;
  for (const line of lines) {
    offsets.push(seen);
    seen += line.length + 1;
  }

  const found: Mutant[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length < 3 || COULD_LOOP.test(line) || NOT_BEHAVIOUR.test(line)) continue;
    for (const operator of OPERATORS) {
      const hit = operator.find.exec(line);
      if (!hit) continue;
      const at = offsets[i] + (hit.index ?? 0);
      // Inside a string or a comment: not behaviour, and often not even syntax once changed.
      if (ranges.some(([from, to]) => at > from && at < to)) continue;
      const now = line.slice(0, hit.index) + operator.swap(hit[0]) + line.slice((hit.index ?? 0) + hit[0].length);
      if (now === line) continue;
      // A change inside a regular expression is worth making - loosening a pattern is exactly how one
      // silently stops matching what it was written for - but it is not a boundary or a comparison, and
      // calling it one makes an otherwise good finding look like a bug in the tool.
      const kind = inPattern(line, hit.index ?? 0) ? 'a pattern loosened' : operator.kind;
      found.push({ line: i + 1, was: line.trim(), now: now.trim(), kind });
      break; // one change per line keeps each answer about one thing
    }
  }
  return spread(found, limit);
}

/**
 * Takes at most `limit`, as far apart in the file as they can be. A suite that catches everything in
 * one function and nothing in the rest of the file should not look like a suite that catches
 * everything, and taking the first six mutants in order is how that happens.
 */
function spread(all: Mutant[], limit: number): Mutant[] {
  if (all.length <= limit) return all;
  const step = all.length / limit;
  return Array.from({ length: limit }, (unused, i) => all[Math.floor(i * step)]);
}

/** The file with this one mutant applied, ready to be written and then put back. */
export function applyMutant(text: string, mutant: Mutant): string {
  const lines = text.split(String.fromCharCode(10));
  const line = lines[mutant.line - 1];
  if (line === undefined || line.trim() !== mutant.was) throw new Error(`line ${mutant.line} is not what the mutant was made from, so nothing was written`);
  lines[mutant.line - 1] = line.replace(mutant.was, mutant.now);
  return lines.join(String.fromCharCode(10));
}
