// A scanner that could not run is not a scanner that found nothing.
//
// Both cases here are real, found by running `tewip secure` on real projects. A project with no
// lockfile and a project pointed at a registry that would not answer each produced "Checked: npm
// audit. 0 need someone now" - on a project that declared three packages with published
// advisories. A clean bill of health that was never earned is worse than no report at all, and it
// is the one thing this command promises never to do.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { auditDependencies, npmAudit } from '../secure/deps.ts';

const project = (packageJson: object): string => {
  const root = mkdtempSync(join(tmpdir(), 'tewip-audit-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson), 'utf8');
  return root;
};

describe('an audit that could not run', () => {
  it('says so instead of reporting nothing found, when there is no lockfile', () => {
    // npm answers {"error":{"code":"ENOLOCK",...}} and exits 0.
    const root = project({ name: 'nolock', version: '1.0.0', dependencies: { lodash: '4.17.15' } });
    const outcome = npmAudit(root);
    assert.deepEqual(outcome.findings, []);
    assert.ok(outcome.problem, 'the refusal is reported, not swallowed');
    assert.match(outcome.problem!, /lockfile/i);

    const audit = auditDependencies(root);
    assert.ok(!audit.ran.includes('npm audit'), 'it must not be listed among the checks that ran');
    assert.ok(audit.missing.some((m) => /npm audit could not run/.test(m)), 'and a reader is told why');
  });

  it('says so when the registry will not answer', () => {
    // A different shape: the error fields are empty and the reason is in `message`. Reading the
    // summary with ?? kept an empty string, so this passed for a clean audit.
    const root = project({ name: 'unreachable', version: '1.0.0', dependencies: { lodash: '4.17.15' } });
    // The lockfile must actually name a package, or npm has nothing to look up and never reaches
    // the registry at all - which is a clean audit, correctly.
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'unreachable',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'unreachable', version: '1.0.0', dependencies: { lodash: '4.17.15' } },
          'node_modules/lodash': { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz', integrity: 'sha512-8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKmRS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A==' },
        },
      }),
      'utf8',
    );
    writeFileSync(join(root, '.npmrc'), 'registry=http://127.0.0.1:9/\nfetch-retries=0\n', 'utf8');
    const outcome = npmAudit(root);
    assert.deepEqual(outcome.findings, []);
    assert.ok(outcome.problem, `a registry that refuses the connection is not a clean audit: ${JSON.stringify(outcome)}`);
  });

  it('lists npm audit as checked when it really ran', () => {
    const root = project({ name: 'clean', version: '1.0.0' });
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'clean', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'clean', version: '1.0.0' } } }), 'utf8');
    const audit = auditDependencies(root);
    assert.ok(audit.ran.includes('npm audit'), `a project with a lockfile and no dependencies audits cleanly: ${JSON.stringify(audit)}`);
    assert.deepEqual(audit.findings, []);
  });
});
