// One worker, running whichever checks it is handed.
//
// Reused across jobs rather than spawned per check, because the cost of a worker here is not the
// thread, it is loading the engine into it: about four seconds. Nine workers would pay that nine
// times on a four-core machine. A worker takes jobs over its port until the pool closes it.
//
// Every failure is reported, never thrown. A worker that dies takes its job's answer with it, and
// the pack would then have a section with no result and no stated reason - which is the one thing
// the pack is built never to do.
import { parentPort } from 'node:worker_threads';
import { CHECK_RUNNERS, type CheckJob, type CheckName } from './checks.ts';

export interface WorkerRequest {
  id: number;
  check: CheckName;
  job: CheckJob;
}

export interface WorkerReply {
  id: number;
  check: CheckName;
  result?: unknown;
  refused?: string;
  seconds: number;
}

parentPort?.on('message', (request: WorkerRequest) => {
  const began = Date.now();
  const took = () => Number(((Date.now() - began) / 1000).toFixed(1));
  const run = CHECK_RUNNERS[request.check];
  if (!run) {
    parentPort?.postMessage({ id: request.id, check: request.check, refused: `there is no check called ${request.check}`, seconds: 0 } satisfies WorkerReply);
    return;
  }
  try {
    const result = run(request.job);
    parentPort?.postMessage({ id: request.id, check: request.check, result, seconds: took() } satisfies WorkerReply);
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      check: request.check,
      refused: error instanceof Error ? error.message : String(error),
      seconds: took(),
    } satisfies WorkerReply);
  }
});
