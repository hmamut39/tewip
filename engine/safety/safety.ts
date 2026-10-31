// What Tewip may do to your code, what it will never do, and how you can check that I am not
// simply saying so.
//
// This is the page an IT department reads before letting an agent near a repository, and the
// reason it exists is that every other agent's version of it is a marketing promise. A list of
// reassurances is worth nothing: the reader cannot verify one of them, and the author cannot be
// held to any.
//
// So no promise here is written as prose alone. Each names the test that enforces it, and the
// card is rendered by **reading those tests off disk**. A promise whose test has been deleted or
// renamed is not quietly dropped and not quietly kept - it is printed as no longer enforced, in
// the card, where a reader will see it. The card can therefore embarrass this project, which is
// the only kind of safety document worth publishing.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Promised {
  /** What Tewip will or will not do, in one line a non-engineer can read. */
  claim: string;
  /** Why it matters - the failure this prevents. */
  because: string;
  /** The test file, relative to the repository root. */
  file: string;
  /** The exact `it(...)` title that enforces the claim. */
  test: string;
}

export interface Checked extends Promised {
  /** True when that test is really there. */
  enforced: boolean;
}

/**
 * The promises, each tied to a test that already exists.
 *
 * Nothing goes in this list that is not already enforced somewhere. The temptation is to write
 * the promise first and the test later; that produces exactly the unverifiable document this
 * file was written against.
 */
export const PROMISES: readonly Promised[] = [
  {
    claim: 'Tewip never keeps a change to your code that it has not proved.',
    because: 'An unverified edit left in a working tree is indistinguishable from one a person made deliberately.',
    file: 'engine/test/code-fix.test.ts',
    test: 'keeps a change only when the test passes and the suite still passes, and puts the file back',
  },
  {
    claim: 'A fix is thrown away if it breaks a test that was passing.',
    because: 'Making one test green by breaking another is the cheapest way for an agent to look successful.',
    file: 'engine/test/fix-gate.integration.test.ts',
    test: 'puts the file back exactly as it was when the test does not pass',
  },
  {
    claim: 'If the verifier itself crashes, your file is still put back.',
    because: 'The failure path is where an agent abandons a half-finished edit, and nobody tests it.',
    file: 'engine/test/autofix.test.ts',
    test: 'puts the file back and lets the error through',
  },
  {
    claim: 'Tewip does not write outside the folder it was pointed at.',
    because: 'An agent that can reach the rest of the disk is a different risk from one that cannot.',
    file: 'engine/test/autofix.test.ts',
    test: 'never edits a file outside the sandbox',
  },
  {
    claim: 'A file Tewip breaks on purpose comes back byte for byte, line endings and all.',
    because: 'Proving a test suite means editing source nobody asked Tewip to touch; the restoration has to be exact, not merely close.',
    file: 'engine/test/prove.integration.test.ts',
    test: 'puts the file back byte for byte, line endings and all',
  },
  {
    claim: 'A credential Tewip finds is located, never quoted.',
    because: 'A security report that prints the secret has copied it into your CI logs, your tracker and your chat.',
    file: 'engine/test/secure.test.ts',
    test: 'never prints the value, in the finding or anywhere else',
  },
  {
    claim: 'What Tewip could not decide is recorded as a refusal, not dropped.',
    because: 'A tool that quietly omits what it could not judge reads as more certain than it is.',
    file: 'engine/test/attest.test.ts',
    test: 'records an undecided failure as a refusal, never as a claim',
  },
  {
    claim: 'A report that checked nothing says so rather than reading as clean.',
    because: 'Silence and a clean bill of health look identical, and only one of them is true.',
    file: 'engine/test/attest.test.ts',
    test: 'doubts its own silence when nothing is recorded as unchecked',
  },
  {
    claim: 'Tewip keeps the model\'s answer out of the record when it breaks the contract.',
    because: 'An answer that does not fit the shape asked for is a guess, and a guess recorded as a diagnosis is worse than no diagnosis.',
    file: 'engine/test/llm.test.ts',
    test: 'keeps UNKNOWN when the model answers outside the contract',
  },
];

/** Reads each promise's test off disk. A promise nobody enforces is reported, never hidden. */
export function checkPromises(root: string, promises: readonly Promised[] = PROMISES): Checked[] {
  const cache = new Map<string, string>();
  const read = (file: string): string => {
    if (!cache.has(file)) {
      const path = resolve(root, file);
      cache.set(file, existsSync(path) ? readFileSync(path, 'utf8') : '');
    }
    return cache.get(file) ?? '';
  };
  // The title is matched inside `it(` so a sentence that merely appears in a comment does not
  // count as a test. That mistake would make the card self-congratulating on prose alone, which
  // is the exact failure it exists to avoid.
  return promises.map((p) => ({ ...p, enforced: read(p.file).includes(`it('${p.test}'`) || read(p.file).includes(`it("${p.test}"`) }));
}
