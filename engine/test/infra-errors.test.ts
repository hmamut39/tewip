// Failures caused by the machinery, not the code. Each message below is real, from a public issue.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { infraSignal } from '../infra-errors.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { diagnose } from '../engine.ts';
import { HistoryIndex } from '../history.ts';

function run(errorMessage: string) {
  const record: TriageRecord = {
    schemaVersion: 1, testId: 'OrderServiceIT > places an order', file: 'OrderServiceIT.java', status: 'failed',
    errorMessage, errorStack: errorMessage, duration: 100, retry: 0, attachments: [], runId: 'r1', gitSha: '', timestamp: '2026-01-01T00:00:00Z',
  };
  const index = new HistoryIndex([record], [{ schemaVersion: 1, runId: 'r1', gitSha: '', startedAt: record.timestamp, finishedAt: record.timestamp, status: 'failed', attempts: { [record.testId]: 1 } }]);
  return diagnose({ record, history: index.historyAsOf(record.testId, 'r1'), run: index.runContext('r1'), loadSnapshot: () => null });
}

const CASES: Array<[string, string, string]> = [
  ['a container never started', 'Caused by: org.testcontainers.containers.ContainerLaunchException: Timed out waiting for container port to open (localhost ports: [32768] should be listening)', 'container-start'],
  ['the image could not be pulled', 'ImagePullBackOff (Back-off pulling image "gcr.io/kubebuilder/kube-rbac-proxy:v0.15.0": ErrImagePull)', 'image-pull'],
  ['Docker Hub refused the pull', 'toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating', 'image-pull'],
  ['it was killed for memory', 'the pod autoscaler is in state : terminated : Reason:Reason: OOMKilled - exit code: 137', 'out-of-memory'],
  ['the disk filled up', 'Warning FailedScheduling default-scheduler 0/1 nodes are available: 1 node(s) had disk pressure.', 'no-disk'],
  ['the port was taken', 'docker: Error response from daemon: driver failed programming external connectivity on endpoint loving_shockley: Bind for 0.0.0.0:9000 failed: port is already allocated', 'port-taken'],
  ['a name would not resolve', 'Error: Post "https://gateway.example.com/v1/login": dial tcp: lookup gateway.example.com: no such host', 'name-lookup'],
  ['the docker daemon was missing', 'java.lang.IllegalStateException: Could not find a valid Docker environment. Please see logs and check configuration', 'container-start'],
];

describe('failures caused by the machinery, not the code', () => {
  for (const [what, message, kind] of CASES) {
    it(`${what}, and calls it the environment`, () => {
      assert.equal(infraSignal(message)?.kind, kind);
      const d = run(message);
      assert.equal(d.category, 'ENV');
      assert.equal(d.ruleId, 'env-infra');
    });
  }

  it('says nothing about an ordinary assertion or a real bug', () => {
    assert.equal(infraSignal("expected 'Hello' to equal 'Hi'"), null);
    assert.equal(infraSignal('AssertionError: the cart total was 3, want 4'), null);
    assert.equal(infraSignal('Error: the image could not be loaded in the gallery component'), null);
  });
});
