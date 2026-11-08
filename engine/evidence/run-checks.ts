// Running the checks: in parallel when the machine allows it, in this thread when it does not.
//
// The pack took 63 seconds on n8n, and its own per-check timings said why: `agent` was 37.9 of 66,
// more than the other eight added together. Nine independent file readers in one thread is nine
// waits in a row for no reason, so they go into a small pool, longest job first.
//
// The serial path is not a leftover. A worker can fail to start - a sandbox with threads disabled,
// a restricted runner, a Node built without worker support - and an evidence pack that refuses to
// exist because it could not parallelise would be a worse tool than the slow one it replaced. So a
// pool that cannot be built is not an error: it is a reason to do the work here and say how long it
// took. Both paths run the same list from checks.ts.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { CHECK_RUNNERS, SLOWEST_FIRST, type CheckJob, type CheckName } from './checks.ts';
import type { WorkerReply, WorkerRequest } from './check-worker.ts';

export interface Ran {
  check: CheckName;
  result?: unknown;
  refused?: string;
  seconds: number;
}

export interface RunOptions {
  job: CheckJob;
  /** Which checks to run; the rest are left to the caller to mark as skipped. */
  only: CheckName[];
  /** Force the single-threaded path, for a measurement or a test that wants it. */
  serial?: boolean;
}

/** What actually happened, so the pack can say whether it ran in parallel and on how many threads. */
export interface RunResult {
  ran: Ran[];
  threads: number;
  /** Why it fell back to one thread, when it did. */
  fellBackBecause?: string;
}

function serially(opts: RunOptions): Ran[] {
  return opts.only.map((check) => {
    const began = Date.now();
    const took = () => Number(((Date.now() - began) / 1000).toFixed(1));
    try {
      return { check, result: CHECK_RUNNERS[check](opts.job), seconds: took() };
    } catch (error) {
      return { check, refused: error instanceof Error ? error.message : String(error), seconds: took() };
    }
  });
}

/**
 * How many threads to use.
 *
 * One fewer than the machine has, because the main thread is doing the dispatching and a pool that
 * oversubscribes a four-core laptop spends its winnings on context switches. Never more than there
 * are jobs, and never more than four: beyond that these checks are waiting on the disk, not on a
 * core, and another thread only adds another copy of the engine to load.
 */
export const threadsFor = (jobs: number): number => Math.max(1, Math.min(jobs, 4, availableParallelism() - 1));

export async function runChecks(opts: RunOptions): Promise<RunResult> {
  const order = SLOWEST_FIRST.filter((c) => opts.only.includes(c));
  // Anything the caller asked for that the order does not name still has to run, or adding a check
  // to checks.ts and forgetting the order would silently drop it.
  const queue = [...order, ...opts.only.filter((c) => !order.includes(c))];
  if (opts.serial || queue.length <= 1) return { ran: serially({ ...opts, only: queue }), threads: 1 };

  const threads = threadsFor(queue.length);
  const workers: Worker[] = [];
  try {
    const url = new URL('./check-worker.ts', import.meta.url);
    const done: Ran[] = [];
    let next = 0;

    await new Promise<void>((resolve, reject) => {
      let live = 0;
      const give = (worker: Worker) => {
        if (next >= queue.length) {
          void worker.terminate();
          live -= 1;
          if (live === 0) resolve();
          return;
        }
        const check = queue[next];
        next += 1;
        worker.postMessage({ id: next, check, job: opts.job } satisfies WorkerRequest);
      };
      for (let i = 0; i < threads; i += 1) {
        const worker = new Worker(url);
        workers.push(worker);
        live += 1;
        worker.on('message', (reply: WorkerReply) => {
          done.push({ check: reply.check, result: reply.result, refused: reply.refused, seconds: reply.seconds });
          give(worker);
        });
        // A worker that dies mid-job is a refusal with a reason, not a missing section.
        worker.on('error', (error) => reject(error));
        worker.on('exit', (code) => {
          if (code !== 0 && next < queue.length) reject(new Error(`a check worker exited with code ${code}`));
        });
        give(worker);
      }
    });
    return { ran: done, threads };
  } catch (error) {
    // Falling back rather than failing: see the note at the top of this file.
    return {
      ran: serially({ ...opts, only: queue }),
      threads: 1,
      fellBackBecause: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const worker of workers) void worker.terminate();
  }
}
