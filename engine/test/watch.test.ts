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
    // The examples stay; what changed is that they are now labelled as examples rather than read
    // as this project's commands, which is how a Rust project came to be told to configure pytest.
    const said = howToWriteAReport(project({ 'README.md': 'nothing here' }));
    assert.match(said, /did not recognise the runner here/);
    assert.match(said, /pytest --junitxml=report\.xml/);
  });

  it('always says plainly that it could not read a report', () => {
    for (const root of [project({ 'README.md': 'x' }), project({ 'pytest.ini': '[pytest]\n', 'tests/test_a.py': 'def test_a():\n    pass\n' })]) {
      assert.match(howToWriteAReport(root), /The tests failed but wrote no report Tewip can read/);
    }
  });
});

describe('runners Tewip reads but cannot run', () => {
  // `detectFrameworks` exists to *run* a suite, so it names only runners Tewip can drive. The advice
  // above read from it alone, so a language Tewip reads reports for but cannot run fell through to
  // a generic list - which is how BurntSushi/ripgrep, a Rust project, was told to configure pytest,
  // jest or dotnet. That is the exact advice the comment on this function calls the kind that gets
  // a tool closed, and Phase 81 only fixed it for the runners that were detectable.
  it('names cargo-nextest for a Rust project', () => {
    const root = project({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/lib.rs': 'pub fn x() {}\n' });
    const said = howToWriteAReport(root);
    assert.match(said, /cargo nextest run/);
    assert.doesNotMatch(said, /pytest|jest|dotnet/, 'a Rust project must not be told to configure pytest');
  });

  it('names PHPUnit for a Composer project', () => {
    const root = project({ 'composer.json': '{"name":"x/y"}', 'src/X.php': '<?php class X {}\n' });
    const said = howToWriteAReport(root);
    assert.match(said, /phpunit --log-junit/);
    assert.doesNotMatch(said, /pytest|jest/);
  });

  it('names RSpec for a Bundler project, and says what it needs', () => {
    const root = project({ Gemfile: "source 'https://rubygems.org'\n", 'lib/x.rb': 'class X; end\n' });
    const said = howToWriteAReport(root);
    assert.match(said, /bundle exec rspec/);
    assert.match(said, /rspec_junit_formatter/, 'the gem it needs is part of the instruction');
  });

  it('says it did not recognise the runner, rather than naming three it guessed', () => {
    // The old fallback read as advice for this project. It was a list of examples, and now says so.
    const root = project({ 'main.c': 'int main(void) { return 0; }\n' });
    const said = howToWriteAReport(root);
    assert.match(said, /did not recognise the runner here/);
    assert.match(said, /for example/, 'the examples stay, labelled as examples');
  });

  it('still prefers the runner it can actually drive', () => {
    // A project with both a package.json suite and a Cargo.toml gets the one Tewip can run first.
    const root = project({
      'package.json': '{"name":"x","devDependencies":{"jest":"29.0.0"}}',
      'Cargo.toml': '[package]\nname = "x"\n',
      'tests/x.test.js': 'test("x", () => {});\n',
    });
    const said = howToWriteAReport(root);
    assert.match(said, /jest/);
    assert.match(said, /cargo nextest/, 'both are named, because the project has both');
    assert.ok(said.indexOf('jest') < said.indexOf('cargo nextest'), 'the runner Tewip can drive comes first');
  });
});
