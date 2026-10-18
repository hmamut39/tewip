// A scanner that could not run is not a scanner that found nothing.
//
// That sentence was already written in deps.ts, above `ScanOutcome`, after `npm audit` answered
// {"error":{"code":"ENOLOCK"}} with exit 0 and Tewip reported "Checked: npm audit. 0 need someone
// now" about a project declaring a vulnerable package. The type was built to carry the difference.
//
// It was never applied to the two scanners beside it. `pipAudit` and `osvScan` both ended
// `catch { return []; }`, and the caller pushed the tool onto `ran` *before* calling it. Reproduced
// on a project pinning requests==2.19.1 and flask==0.12.2, both long known vulnerable, with a
// pip-audit installed and failing to resolve its index:
//
//   Checked: secrets in the working tree, pip-audit.
//   0 need someone now - 0 real but not reachable - 0 noise.
//
// The exit code is deliberately not a failure signal: pip-audit and npm audit both exit non-zero
// exactly when they have found something.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { osvFindings, pipFindings, scanOutcome, type DepFinding } from '../secure/deps.ts';

const pip = (out: string, err = '') => scanOutcome('pip-audit', out, err, { key: 'dependencies', orArray: true }, pipFindings);
const osv = (out: string, err = '') => scanOutcome('osv-scanner', out, err, { key: 'results' }, osvFindings);

const PIP_REAL = JSON.stringify({
  dependencies: [
    { name: 'requests', version: '2.19.1', vulns: [{ id: 'GHSA-x84v-xcm2-53pg', fix_versions: ['2.20.0'], description: 'Requests before 2.20.0 sends an Authorization header on redirect.' }] },
    { name: 'flask', version: '0.12.2', vulns: [{ id: 'PYSEC-2019-179', fix_versions: ['0.12.3'], description: 'Flask before 1.0 is affected by unexpected memory usage.' }] },
  ],
});

describe('a scanner that did not produce a report', () => {
  it('reports a problem when it printed nothing at all', () => {
    const outcome = pip('');
    assert.equal(outcome.findings.length, 0);
    assert.match(outcome.problem ?? '', /pip-audit did not return a report/);
  });

  it('reports a problem, and quotes it, when it printed an error instead of JSON', () => {
    const outcome = pip('ERROR: Failed to resolve dependencies: connection refused');
    assert.match(outcome.problem ?? '', /connection refused/);
  });

  it('prefers what the tool said on stderr', () => {
    const outcome = pip('', 'pip-audit: error: unrecognized arguments');
    assert.match(outcome.problem ?? '', /unrecognized arguments/);
  });

  it('reports a problem when the JSON is not a scan report', () => {
    const outcome = pip(JSON.stringify({ usage: 'pip-audit [-h]' }));
    assert.match(outcome.problem ?? '', /not a scan report/);
  });

  it('does not take a bare array from osv-scanner as an empty scan', () => {
    // pip-audit prints its list unwrapped in older versions, so an array is a real report there and
    // nowhere else. Accepting one everywhere would let a stray array pass for a clean result.
    assert.match(osv('[]').problem ?? '', /not a scan report/);
    assert.equal(pip('[]').problem, null);
  });
});

describe('a scanner that did its job', () => {
  it('keeps every finding, with the version that fixes it', () => {
    const outcome = pip(PIP_REAL);
    assert.equal(outcome.problem, null);
    assert.deepEqual(
      outcome.findings.map((f: DepFinding) => `${f.package}@${f.version} ${f.id} fix:${f.fixedIn}`),
      ['requests@2.19.1 GHSA-x84v-xcm2-53pg fix:2.20.0', 'flask@0.12.2 PYSEC-2019-179 fix:0.12.3'],
    );
  });

  it('counts a genuinely empty result as a clean scan, not a failure', () => {
    assert.deepEqual(pip(JSON.stringify({ dependencies: [] })), { findings: [], problem: null });
    assert.deepEqual(osv(JSON.stringify({ results: [] })), { findings: [], problem: null });
  });

  it('reads an osv-scanner report', () => {
    const report = { results: [{ packages: [{ package: { name: 'golang.org/x/net', version: 'v0.7.0' }, vulnerabilities: [{ id: 'GO-2023-1495', summary: 'HTTP/2 rapid reset', database_specific: { severity: 'HIGH' } }] }] }] };
    const outcome = osv(JSON.stringify(report));
    assert.equal(outcome.problem, null);
    assert.equal(outcome.findings.length, 1);
    assert.equal(outcome.findings[0].id, 'GO-2023-1495');
    assert.equal(outcome.findings[0].severity, 'high');
    assert.equal(outcome.findings[0].source, 'osv-scanner');
  });

  it('claims no fixed version when the scanner named none', () => {
    // osv-scanner's output says neither which version fixes a vulnerability nor whether the project
    // declares the package, so neither may be claimed.
    const outcome = osv(JSON.stringify({ results: [{ packages: [{ package: { name: 'x', version: '1' }, vulnerabilities: [{ id: 'A' }] }] }] }));
    assert.equal(outcome.findings[0].fixedIn, '');
    assert.equal(outcome.findings[0].fixExists, false);
    assert.equal(outcome.findings[0].direct, false);
  });
});
