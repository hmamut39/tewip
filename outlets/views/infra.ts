// Infrastructure view for senior DevOps / SRE: environment failures of the run grouped by the
// failing dependency, with retry recovery and one grouped alert instead of N pages.
import { errorShape, truncate } from '../../engine/signature.ts';
import type { TriageItem } from '../items.ts';
import { clean, itemBlock, sourceNote, type View } from '../view.ts';

export interface EnvGroup {
  signature: string;
  hosts: string[];
  items: TriageItem[];
  recovered: number;
}

/** What broke, as specific as the evidence allows: the network signal, else the error shape. */
export function signatureOf(i: TriageItem): string {
  const net = i.diagnosis.evidence.find((e) => e.source === 'env-network')?.data as { kind?: string; match?: string } | undefined;
  if (net?.match) return `${net.kind ?? 'network'}: ${truncate(net.match, 60)}`;
  return truncate(errorShape(i.errorHead), 80) || 'environment failure (no error text)';
}

export function groupEnv(items: TriageItem[]): EnvGroup[] {
  const groups = new Map<string, TriageItem[]>();
  for (const i of items.filter((x) => x.diagnosis.category === 'ENV')) groups.set(signatureOf(i), [...(groups.get(signatureOf(i)) ?? []), i]);
  return [...groups.entries()]
    .map(([signature, xs]) => ({
      signature,
      items: xs,
      recovered: xs.filter((x) => x.recoveredOnRetry).length,
      hosts: [...new Set(xs.flatMap((x) => [x.errorHead, ...x.evidence].join(' ').match(/https?:\/\/[^\s/'"]+/g) ?? []))].slice(0, 3),
    }))
    .sort((a, b) => b.items.length - a.items.length);
}

export function infraView(items: TriageItem[], runId: string, dataset: string): View {
  const groups = groupEnv(items);
  const env = groups.flatMap((g) => g.items);
  const alert = [
    `[triage-agent] run ${runId}: ${env.length} test failure(s) caused by the test environment, not by code.`,
    ...groups.map((g) => `- ${clean(g.signature)}: ${g.items.length} test(s), ${g.recovered} recovered on retry${g.hosts.length ? ` (hosts: ${g.hosts.join(', ')})` : ''}`),
    'Test code was not changed. Next: re-run the affected tests once; if they fail again, investigate the dependency above.',
  ];

  const markdown = [
    `# Infrastructure view: run ${runId}`,
    '',
    env.length === 0 ? 'No environment failures in this run.' : `${env.length} of ${items.length} failing test(s) are environment problems, in ${groups.length} group(s).`,
    '',
    sourceNote(dataset),
    '',
    ...(env.length === 0 ? [] : ['## One grouped alert (send this instead of one page per test)', '', '```text', ...alert, '```', '']),
    ...groups.flatMap((g) => [
      `## ${clean(g.signature)}: ${g.items.length} test(s), ${g.recovered} recovered on retry`,
      '',
      ...g.items.map((i) => itemBlock(i, [`Recovered on retry: ${i.recoveredOnRetry ? 'yes' : 'no'}`])),
      '',
    ]),
  ].join('\n');

  return { id: 'infra', role: 'devops', title: `Infrastructure view for run ${runId}`, scope: 'run', items: env, markdown };
}
