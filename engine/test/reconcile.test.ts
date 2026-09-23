// Two checks that contradict each other in the same report.
//
// Scanning a real Express server that served its own directory, Tewip said both of these at once:
// the web check called the served .env critical, "its settings and keys are public"; the secret
// scan called a credential inside that same file low, "git does not track .env, so this never left
// the machine". A reader has to notice the contradiction and work out which to believe.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconcile } from '../secure/reconcile.ts';
import type { SecurityItem } from '../secure/triage.ts';

const servedEnv = (): SecurityItem => ({
  kind: 'web',
  verdict: 'real-risk',
  title: 'the .env file is served, so its settings and keys are public',
  why: 'GET http://127.0.0.1:3211/.env answered 200 with the file\'s real contents',
  next: 'stop serving /.env',
  severity: 'critical',
  where: 'http://127.0.0.1:3211/.env',
  source: 'tewip baseline web check',
});

const secretInEnv = (over: Partial<SecurityItem> = {}): SecurityItem => ({
  kind: 'secret',
  verdict: 'not-reachable',
  title: 'a database URL with a password in it in .env:1',
  why: 'git does not track .env, so this never left the machine: DATABASE_URL=po............',
  next: 'keep it that way: make sure .env stays in .gitignore',
  severity: 'low',
  where: '.env:1',
  source: 'tewip secret scan',
  ...over,
});

describe('when one check changes what another means', () => {
  it('stops calling a credential unreachable when the application serves the file it is in', () => {
    const [, secret] = reconcile([servedEnv(), secretInEnv()]);
    assert.equal(secret.verdict, 'real-risk');
    assert.equal(secret.severity, 'critical');
    assert.match(secret.why, /serves \/\.env to anyone who asks/);
    assert.match(secret.next, /rotate it now/);
  });

  it('leaves everything alone when nothing is being served', () => {
    const items = [secretInEnv()];
    assert.deepEqual(reconcile(items), items);
  });

  it('leaves a secret in some other file alone', () => {
    const [, other] = reconcile([servedEnv(), secretInEnv({ where: 'src/config.ts:4', title: 'a token in src/config.ts:4' })]);
    assert.equal(other.verdict, 'not-reachable', 'only the file that is actually served changes');
  });

  it('never overrules a person who already accepted it', () => {
    const [, accepted] = reconcile([servedEnv(), secretInEnv({ verdict: 'accepted' })]);
    assert.equal(accepted.verdict, 'accepted');
  });
});
