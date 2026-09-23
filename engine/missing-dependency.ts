// A test that could not even be loaded.
//
// Found by running a stranger's suite: `pytest` on the humanize library here produced six entries
// reading "ImportError while importing test module", because a test dependency was not installed.
// Tewip answered UNKNOWN six times, which is the least useful thing it can say about the single
// most common environment failure there is - the install step did not run, or the lockfile and the
// image disagree.
//
// The distinction that keeps this honest is which module is missing. A third-party package the
// project never wrote is the environment's problem. A module belonging to the project itself is
// not: a rename that missed a caller, or an import of something that was deleted, is a real bug,
// and the same is true of a file that fails to parse. Those are left alone.
import type { Rule } from './rules.ts';
import { truncate } from './signature.ts';

/** The module name each runner prints when it cannot load something. */
const PATTERNS: Array<{ language: string; pattern: RegExp }> = [
  { language: 'Python', pattern: /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/ },
  { language: 'Node', pattern: /Cannot find module ['"]([^'"]+)['"]/ },
  { language: 'Node', pattern: /ERR_MODULE_NOT_FOUND[^'"]*['"]([^'"]+)['"]/ },
  { language: 'Java', pattern: /(?:NoClassDefFoundError|ClassNotFoundException):\s*([\w.$]+)/ },
  { language: 'Ruby', pattern: /cannot load such file --\s*(\S+)/ },
  { language: 'Go', pattern: /cannot find package ['"]([^'"]+)['"]/ },
  { language: '.NET', pattern: /Could not load file or assembly ['"]([^'",]+)/ },
  { language: 'PHP', pattern: /Failed opening required ['"]([^'"]+)['"]|Class ['"]([^'"]+)['"] not found/ },
];

// `ImportError: cannot import name 'x'` is deliberately not here. It usually means the code asked
// for something that does not exist - a rename that missed a caller - which is a real bug, and only
// sometimes a version mismatch. "No module named" says plainly that nothing could be found.

/** A module that is part of this project rather than something it depends on. */
const LOOKS_INTERNAL = /^\.|^(?:src|tests?|app|lib|internal|pkg|main)\b|_test$|\.spec$|\.test$/i;
/** The file could be found but not understood, which is a mistake in the code, not the machine. */
const A_CODE_ERROR = /\b(?:SyntaxError|IndentationError|TabError|TypeError|NameError|AttributeError|error TS\d+|Unexpected token)\b/;

/**
 * pytest reports a missing plugin as a missing fixture, which on its own is ambiguous: a typo in a
 * fixture name reads exactly the same. What separates them is how many tests it hits. A typo breaks
 * the one test that made it; an uninstalled plugin breaks every test that asks for its fixture.
 *
 * Found on humanize's real suite, where 15 tests failed with "fixture 'benchmark' not found". The
 * model answered those 15 identical failures with 13 ENV and 2 TEST_DATA - the same input getting
 * different answers, which is worse than either answer, and exactly what a rule is for.
 */
const MISSING_FIXTURE = /fixture ['"]([^'"]+)['"] not found/;
export const FIXTURE_SHARED_BY = 3;

export const fixtureMissing = (errorMessage: string): string | null => MISSING_FIXTURE.exec(errorMessage)?.[1] ?? null;

export interface MissingDependency {
  language: string;
  module: string;
}

export function missingDependency(errorMessage: string): MissingDependency | null {
  if (A_CODE_ERROR.test(errorMessage)) return null;
  for (const { language, pattern } of PATTERNS) {
    const found = pattern.exec(errorMessage);
    const module = found?.slice(1).find(Boolean);
    if (!module) continue;
    if (LOOKS_INTERNAL.test(module)) return null;
    return { language, module };
  }
  return null;
}

/**
 * Nothing about the test ran, so nothing about the test or the code has been shown. The suite needs
 * a dependency the machine does not have.
 */
export const envMissingDependency: Rule = {
  id: 'env-missing-dependency',
  evaluate({ record, run }) {
    const fixture = fixtureMissing(record.errorMessage);
    if (fixture) {
      const sharing = run.failures.filter((f) => fixtureMissing(f.errorMessage) === fixture).length;
      if (sharing < FIXTURE_SHARED_BY) return null; // one test only: a typo is as likely, so say nothing
      return {
        category: 'ENV',
        confidence: 0.85,
        evidence: [
          {
            source: 'env-missing-dependency',
            message: `${sharing} tests in this run all need the fixture "${truncate(fixture, 40)}" and none can find it: the plugin that provides it is not installed, so no test code ran`,
            data: { fixture, sharing },
          },
        ],
      };
    }

    const found = missingDependency(record.errorMessage);
    if (!found) return null;
    // When the whole run failed this way, the install step is the obvious suspect and there is
    // nothing test-specific left to doubt.
    const wholeRun = run.failures.length >= 3 && run.failures.every((f) => missingDependency(f.errorMessage) !== null);
    return {
      category: 'ENV',
      confidence: wholeRun ? 0.92 : 0.85,
      evidence: [
        {
          source: 'env-missing-dependency',
          message: wholeRun
            ? `every failure in this run is a module that could not be loaded (${found.language}: "${truncate(found.module, 60)}"): the dependencies were not installed, so no test code ran`
            : `the test could not be loaded because ${found.language} could not find "${truncate(found.module, 60)}": a dependency is missing, so nothing about the test itself has been shown`,
          data: { ...found, wholeRun },
        },
      ],
    };
  },
};
