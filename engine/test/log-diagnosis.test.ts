// A CI job that dies before any test runs leaves no report - only its log. Tewip must answer from
// that log instead of saying nothing, which is what a team sees as an unexplained red X.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnoseLog, renderLogDiagnosis } from '../import/log.ts';

const line = (...lines: string[]) => lines.join('\n');

describe('a job that died before the tests', () => {
  it('names the infrastructure cause and where it was seen', () => {
    const log = line('2026-09-22T10:00:01.1Z ##[group]Run docker compose up -d', 'Pulling db (postgres:18)...', 'Error response from daemon: toomanyrequests: You have reached your pull rate limit.', '##[error]Process completed with exit code 1');
    const found = diagnoseLog(log)!;
    assert.equal(found.meaning, 'a container image could not be pulled');
    assert.equal(found.line, 3);
    assert.equal(found.source, 'infrastructure');
    const text = renderLogDiagnosis(found, 'the "test" job log');
    assert.match(text, /this is the environment, not a test and not the change/);
    assert.match(text, /the "test" job log:3/);
  });

  it('reads the failures of the job itself, which no test reader covers', () => {
    assert.match(diagnoseLog('The runner has received a shutdown signal. Cancelling...')!.meaning, /cancelled or the runner was shut down/);
    assert.match(diagnoseLog('##[error]The job running on runner GitHub Actions 9 has exceeded the maximum execution time of 360 minutes.')!.meaning, /past its time limit/);
    assert.match(diagnoseLog('##[error]Process completed with exit code 137')!.meaning, /killed for using too much memory/);
    assert.match(diagnoseLog('npm ERR! network request to https://registry.npmjs.org/react failed, reason: ECONNRESET')!.meaning, /package registry could not be reached/);
  });

  it('prefers the infrastructure reason over the connection that followed from it', () => {
    const log = line('Creating service container postgres', 'Error: Timed out waiting for container port to open (localhost ports: [5432] should be listening)', 'psql: error: connection to server failed: Connection refused');
    assert.equal(diagnoseLog(log)!.meaning, 'a container the test needs never started');
  });

  it('says plainly when the log names nothing it recognises, instead of inventing a cause', () => {
    const found = diagnoseLog(line('Running 42 tests', 'All good so far', '##[error]Process completed with exit code 1'));
    assert.equal(found, null);
    assert.match(renderLogDiagnosis(found, 'the job log'), /nothing in the job log names a cause Tewip recognises/i);
  });
});
