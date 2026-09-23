// Quarantining a test is a one-line change to a test file - which is the only kind of file Tewip
// has ever been allowed to edit. It writes the line the project's own framework uses, with the
// reason and the evidence in a comment above it, so the next person to read it knows why it is
// there and when it should come back.
//
// It never touches application code here, never changes what a test asserts, and never removes a
// test. A quarantined test still exists; it just stops blocking everyone.
import type { FlakyTest } from './flaky.ts';

export interface Quarantine {
  /** The line to add, in the project's own framework. */
  line: string;
  /** The comment above it: why, and what has to be true to take it out. */
  comment: string[];
}

/** Which framework a test file belongs to, from its name and its contents. */
export function frameworkOf(file: string, source: string): 'playwright' | 'jest' | 'vitest' | 'mocha' | 'pytest' | 'junit' | 'dotnet' | 'go' | null {
  if (/\.py$/.test(file)) return 'pytest';
  if (/\.java$|\.kt$/.test(file)) return 'junit';
  if (/\.cs$/.test(file)) return 'dotnet';
  if (/_test\.go$/.test(file)) return 'go';
  if (/@playwright\/test|from ['"]playwright/.test(source)) return 'playwright';
  if (/from ['"]vitest['"]|\bvi\./.test(source)) return 'vitest';
  if (/@jest\/globals|jest\./.test(source)) return 'jest';
  if (/\brequire\(['"]mocha|describe\(/.test(source)) return 'mocha';
  return /\.[cm]?[jt]sx?$/.test(file) ? 'jest' : null;
}

const MARK: Record<string, (title: string) => string> = {
  playwright: (title) => `test.fixme(true, ${JSON.stringify(`quarantined by Tewip: ${title}`)});`,
  jest: () => 'test.skip',
  vitest: () => 'test.skip',
  mocha: () => 'it.skip',
  pytest: (title) => `@pytest.mark.skip(reason=${JSON.stringify(`quarantined by Tewip: ${title}`)})`,
  junit: (title) => `@Disabled(${JSON.stringify(`quarantined by Tewip: ${title}`)})`,
  dotnet: (title) => `[Fact(Skip = ${JSON.stringify(`quarantined by Tewip: ${title}`)})]`,
  go: () => 't.Skip("quarantined by Tewip")',
};

/** What to write, and the note that goes above it. */
export function quarantineFor(test: FlakyTest, framework: NonNullable<ReturnType<typeof frameworkOf>>): Quarantine {
  const rate = test.totalRuns > 0 ? `${test.failedRuns} of ${test.totalRuns} runs` : `${test.failedRuns} run(s)`;
  return {
    line: MARK[framework](test.title),
    comment: [
      `Quarantined by Tewip on ${new Date().toISOString().slice(0, 10)}: failed in ${rate}, ${Math.round(test.wastedMs / 60_000)} CI minute(s) lost.`,
      test.branches.length > 1 ? `It failed on ${test.branches.length} branches, so it is the test and not one change.` : '',
      'Take this line out when the cause is fixed. `tewip flaky` will say when it has stopped failing.',
    ].filter(Boolean),
  };
}

/**
 * The file with the test quarantined, or null when the test could not be found in it. Only the one
 * test named is touched; everything else in the file stays byte for byte as it was.
 */
export function applyQuarantine(source: string, test: FlakyTest, framework: NonNullable<ReturnType<typeof frameworkOf>>): string | null {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(nl);
  const quoted = test.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`^(\\s*)((?:async\\s+)?(?:export\\s+)?(?:test|it|def test_|public\\s+void|func\\s+Test)\\b[^\\n]*${quoted})`, 'i');
  const index = lines.findIndex((line) => declaration.test(line) || line.includes(`"${test.title}"`) || line.includes(`'${test.title}'`));
  if (index < 0) return null;
  if (lines.slice(Math.max(0, index - 4), index + 1).some((l) => /quarantined by tewip/i.test(l))) return source; // already done

  const indent = (lines[index].match(/^\s*/) ?? [''])[0];
  const { line, comment } = quarantineFor(test, framework);
  const commentMark = framework === 'pytest' ? '#' : '//';
  const note = comment.map((c) => `${indent}${commentMark} ${c}`);

  // Where the mark goes differs: an annotation sits above the test, a skip replaces the call.
  if (framework === 'jest' || framework === 'vitest' || framework === 'mocha') {
    const replaced = lines[index].replace(/\b(test|it)(\.\w+)?\(/, `${line}(`);
    if (replaced === lines[index]) return null;
    return [...lines.slice(0, index), ...note, replaced, ...lines.slice(index + 1)].join(nl);
  }
  if (framework === 'playwright') {
    // Playwright's fixme goes inside the test body, so the test still reports itself as skipped.
    const body = lines[index].includes('=>') ? index : -1;
    if (body < 0) return null;
    return [...lines.slice(0, index), ...note, lines[index], `${indent}  ${line}`, ...lines.slice(index + 1)].join(nl);
  }
  // pytest, JUnit, .NET: the annotation goes on its own line above the test.
  return [...lines.slice(0, index), ...note, `${indent}${line}`, ...lines.slice(index)].join(nl);
}
