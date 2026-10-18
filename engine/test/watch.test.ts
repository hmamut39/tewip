// Phase 81: `tewip watch` runs the suite when a file changes and explains each failure as it
// happens. Field-tested on a real project with a real bug planted in it.
//
// The loop works: the suite failed, and once a report existed the failure was explained correctly -
// REAL_BUG with the real assertion quoted, "26 !== 25", the line named, and the confidence honestly
// below the bar so it asks for a person. What did not work was the step in between. The tests had
// failed with a perfectly clear error and the answer was:
//
//     The tests failed but wrote no report Tewip can read. Make the runner write JUnit XML (for
//     example: pytest --junitxml=report.xml, jest --reporters=jest-junit, dotnet test --logger trx).
//
// Three examples, none of them the runner failing in front of it - `node --test`, Node's own built-in
// runner. Telling somebody to configure jest when they are not using jest is the kind of advice that
// gets a tool closed, and the frameworks a project has are already detectable.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { howToWriteAReport } from '../watch/watch-command.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-watch-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content, 'utf8');
  }
  return root;
}

describe('what to change so the next run can be explained', () => {
  it('names the command for the runner this project actually has', () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test tests/*.test.js' } }),
      'tests/cart.test.js': 'import { it } from "node:test";\nit("adds", () => {});\n',
    });
    const said = howToWriteAReport(root);
    assert.match(said, /For the runner this project has/);
    assert.match(said, /node --test --test-reporter=junit --test-reporter-destination=report\.xml/);
  });

  it('does not offer a runner the project is not using', () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test tests/*.test.js' } }),
      'tests/cart.test.js': 'import { it } from "node:test";\nit("adds", () => {});\n',
    });
    const said = howToWriteAReport(root);
    assert.doesNotMatch(said, /jest-junit/, 'jest is not installed here');
    assert.doesNotMatch(said, /dotnet test/, 'this is not a .NET project');
  });

  it('names the pytest command in a Python project', () => {
    const root = project({ 'pytest.ini': '[pytest]\n', 'tests/test_cart.py': 'def test_adds():\n    assert True\n' });
    const said = howToWriteAReport(root);
    assert.match(said, /pytest --junitxml=report\.xml/);
  });

  it('falls back to examples only when it recognises nothing', () => {
    // An empty folder has no runner to name, and silence would be worse than a general example.
    const said = howToWriteAReport(project({ 'README.md': 'nothing here' }));
    assert.match(said, /Make the runner write JUnit XML/);
    assert.match(said, /pytest --junitxml=report\.xml/);
  });

  it('always says plainly that it could not read a report', () => {
    for (const root of [project({ 'README.md': 'x' }), project({ 'pytest.ini': '[pytest]\n', 'tests/test_a.py': 'def test_a():\n    pass\n' })]) {
      assert.match(howToWriteAReport(root), /The tests failed but wrote no report Tewip can read/);
    }
  });
});
