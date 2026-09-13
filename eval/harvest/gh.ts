// Thin wrapper around the GitHub CLI for read-only calls against public repositories.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const WINDOWS_GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const GH = process.env.GH_PATH || (existsSync(WINDOWS_GH) ? WINDOWS_GH : 'gh');

/** Runs `gh <args>` and resolves with stdout; async so several calls can run at once. */
export function ghRaw(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(GH, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`)),
    );
  });
}

export async function ghApi<T>(path: string): Promise<T> {
  return JSON.parse((await ghRaw(['api', path])).toString('utf8')) as T;
}

export const downloadArtifact = (repo: string, artifactId: number) => ghRaw(['api', `repos/${repo}/actions/artifacts/${artifactId}/zip`]);
