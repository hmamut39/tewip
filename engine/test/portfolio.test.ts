// Phase 136: one page for many repositories, and the dash that is not a zero.
//
// Every other command answers about one checkout. A head of engineering has forty, and the
// question is "which of these should somebody look at first". The usual answer to that is a
// server, a dashboard and an agent on every machine; the checks here are already local, already
// rules-only and already free, so the page is just a loop.
//
// A table invites skimming, which makes one rule matter more here than anywhere else: a check
// that could not run prints a dash and a reason, never a 0. At forty rows, a zero meaning
// "nothing installed" and a zero meaning "nothing wrong" are indistinguishable, and the first one
// is the one that gets somebody hurt.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkoutsUnder, examine } from '../portfolio/portfolio-command.ts';
import { CHECKS, renderPortfolio, worstFirst, type RepoRow } from '../portfolio/portfolio.ts';

const NL = String.fromCharCode(10);
const row = (name: string, cells: RepoRow['cells']): RepoRow => ({ name, path: `/x/${name}`, cells, seconds: 0 });

function workspace(repos: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-portfolio-'));
  for (const [repo, files] of Object.entries(repos)) {
    for (const [path, body] of Object.entries(files)) {
      const full = join(root, repo, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body, 'utf8');
    }
  }
  return root;
}

describe('the page across repositories', () => {
  it('never prints a zero for a check that could not run', () => {
    // Every check gets a cell on purpose. The first version left five of the seven undefined,
    // so the row was full of dashes from the "no cell at all" branch and the assertion passed
    // with the ran/not-ran distinction deleted outright.
    const cells: RepoRow['cells'] = {};
    for (const c of CHECKS) cells[c] = { ran: true, count: 0, detail: '' };
    cells.containers = { ran: false, why: 'no Dockerfile or compose file here' };
    const page = renderPortfolio([row('web', cells)], ['nothing']);
    const line = page.split(NL).find((l) => l.startsWith('| web')) ?? '';
    assert.match(line, /0/, 'the check that ran shows its count');
    assert.match(line, /—/, 'the one that did not shows a dash');
    assert.match(page, /A dash is not a zero/);
    assert.match(page, /no Dockerfile or compose file here/, 'and the reason is on the page, not only in a tooltip nobody has');
  });

  it('puts the repositories with the most to look at first', () => {
    const quiet = row('quiet', { secrets: { ran: true, count: 0, detail: '' } });
    const loud = row('loud', { secrets: { ran: true, count: 9, detail: '' } });
    assert.deepEqual(worstFirst([quiet, loud]).map((r) => r.name), ['loud', 'quiet']);
  });

  it('does not let a check that could not run count as a good score', () => {
    // A repository where nothing ran must not sort above one with findings by looking clean.
    const blank = row('blank', { secrets: { ran: false, why: 'x' }, containers: { ran: false, why: 'x' } });
    const some = row('some', { secrets: { ran: true, count: 2, detail: '' } });
    assert.deepEqual(worstFirst([blank, some]).map((r) => r.name), ['some', 'blank']);
  });

  it('says what the columns count, because seven one-word headings are seven guesses', () => {
    const page = renderPortfolio([row('a', {})], ['nothing']);
    assert.match(page, /## What the columns count/);
    assert.match(page, /credentials that need somebody to act now/);
  });

  it('says what the page is not', () => {
    const page = renderPortfolio([row('a', {})], ['a judgement about which repository matters most']);
    assert.match(page, /## What this page is not/);
    assert.match(page, /re-derivable/);
  });
});

describe('finding and reading the checkouts', () => {
  it('finds the folders that look like a project, and ignores the rest', () => {
    const root = workspace({ api: { 'package.json': '{"name":"api"}' }, notes: { 'readme.txt': 'hello' } });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    assert.deepEqual(checkoutsUnder(root).map((p) => p.split(/[\\/]/).pop()), ['api']);
  });

  it('reads a repository without letting one missing thing take the page down', () => {
    // No Dockerfile, no migrations, no markup: those are dashes, and `secrets` still answers.
    const root = workspace({ api: { 'package.json': '{"name":"api"}', 'src/a.ts': 'export const a = 1;' + NL } });
    const seen = examine(join(root, 'api'), true);
    assert.equal(seen.cells.secrets.ran, true);
    assert.equal(seen.cells.containers.ran, false);
    assert.equal(seen.cells.migrations.ran, false);
    assert.equal(seen.cells['hollow tests'].ran, false, '--quick skips it, and says so rather than printing 0');
  });

  it('counts a real injection, so the column is not decorative', () => {
    const root = workspace({
      api: {
        'package.json': '{"name":"api"}',
        'src/h.js': 'app.get("/u", (req, res) => { db.query("SELECT * FROM u WHERE id = " + req.query.id); });' + NL,
      },
    });
    const cell = examine(join(root, 'api'), true).cells.injection;
    assert.equal(cell.ran, true);
    assert.equal((cell as { count: number }).count, 1);
  });
});
