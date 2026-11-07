// `tewip agent`: what this agent is allowed to do, and what stands between it and the real world.
import { writeFileSync } from 'node:fs';


import { CAPABILITY_MEANS, FRAMEWORKS_READ, IRREVERSIBLE, trifectaIn, type AgentTool, type Capability, type Reach } from './tools.ts';
import { type PromptFlow } from './prompt-flow.ts';
import { configSection, type ConfigScan } from './claude-config.ts';
import { coverageSection, type EvalEvidence, type ToolCoverage } from './tool-tests.ts';
import { GUARD_MEANS, GUARD_PREVENTS, type Guard, type GuardKind } from './guards.ts';

import { scanAgent, type AgentScan } from './scan.ts';

export { scanAgent, type AgentScan };

export interface AgentCommand {
  root: string;
  out?: string;
  /** Exit non-zero when a tool that cannot be undone has nothing asking a person. */
  gate?: boolean;
}

const NL = String.fromCharCode(10);

const REACH_READS: Record<Reach, string> = {
  destructive: 'cannot be undone',
  deletes: 'deletes something',
  pays: 'moves money',
  sends: 'sends something out of the building',
  'runs-code': 'runs code or a shell command',
  writes: 'changes stored data',
  reads: 'reads only',
  'not-sure': '**not decided**',
};



export function renderAgent(scan: AgentScan, root: string): string {
  const { tools, injections, guards, filesRead, emptyBudget, config, coverage, evals } = scan;
  const lines = ['# What this agent is allowed to do', ''];

  if (tools.length === 0) {
    return [
      '# What this agent is allowed to do',
      '',
      ...configSection(config),
      `No tool definitions were found in ${filesRead} file(s).`,
      '',
      'That is a fact about what was looked for, not a finding that this agent has no tools. These',
      'are the shapes read here:',
      '',
      ...FRAMEWORKS_READ.map((f) => `- ${f}`),
      '',
      'An agent built another way, or one whose tools are assembled at run time from a registry, is',
      'invisible to this and is not reported as safe. Nothing here was sent anywhere; no model was',
      'called.',
    ].join(NL);
  }

  const kinds = new Set(guards.map((g) => g.kind));
  // A permission list is an allow-list, and a PreToolUse hook is enforced on every call - both are
  // the real thing rather than a pattern someone wrote in a prompt.
  if (config.hasAllowList) kinds.add('tool-allow-list');
  if (config.hasEnforcedHook) kinds.add('asks-a-person');
  const risky = tools.filter((t) => IRREVERSIBLE.includes(t.reach));
  const undecided = tools.filter((t) => t.reach === 'not-sure');

  lines.push(
    `${tools.length} tool(s) in ${filesRead} file(s) read locally. No model was called and nothing left this machine.`,
    '',
  );

  // The lethal trifecta leads when it is present, because it outranks everything else here: the
  // other findings are about what the agent may do by mistake, and this one is about what somebody
  // else can make it do on purpose.
  const trifecta = trifectaIn(tools);
  if (trifecta.complete) {
    lines.push(
      '> **This agent has all three legs of the lethal trifecta.**',
      '>',
      '> It can pull in text an outsider writes, it can read data that is not meant to leave, and it',
      '> can send data out - in one loop. Text the agent did not write can tell it to read the',
      '> private thing and post it somewhere, and every step of that is a tool it was given on',
      '> purpose. A system prompt is not a defence here: whoever writes the untrusted text writes the',
      '> other half of the prompt.',
      '',
    );
  }

  // The headline, because it is the sentence somebody has to act on.
  if (risky.length > 0 && !kinds.has('asks-a-person')) {
    lines.push(
      `**${risky.length} of them do something that cannot be undone, and nothing in this project stops to ask a person.**`,
      '',
    );
  } else if (risky.length > 0) {
    lines.push(
      `${risky.length} of them do something that cannot be undone. Something here does ask a person - whether it stands in front of these tools is below.`,
      '',
    );
  }

  lines.push('## The tools', '', '| tool | reaches | where |', '| --- | --- | --- |');
  for (const t of [...tools].sort((a, b) => rank(a.reach) - rank(b.reach) || a.name.localeCompare(b.name))) {
    lines.push(`| \`${t.name}\` | ${REACH_READS[t.reach]} | ${t.file}:${t.line} |`);
  }
  lines.push('');

  if (risky.length > 0) {
    lines.push('## The ones that cannot be taken back', '');
    for (const t of risky) {
      lines.push(`- \`${t.name}\` — ${REACH_READS[t.reach]}, because ${t.why}. ${t.file}:${t.line}`);
    }
    lines.push('');
  }

  if (undecided.length > 0) {
    lines.push(
      '## The ones this could not decide about',
      '',
      'Read these yourself. They are listed here rather than counted as harmless, which is the only',
      'honest thing to do with a tool whose name does not say what it touches.',
      '',
      ...undecided.map((t) => `- \`${t.name}\`${t.description ? ` — "${t.description.slice(0, 90)}"` : ''} — ${t.file}:${t.line}`),
      '',
    );
  }

  if (injections.length > 0) {
    const armed = injections.filter((i) => i.withTools);
    lines.push(
      '## Text somebody else wrote, glued into a prompt',
      '',
      armed.length > 0
        ? `${injections.length} place(s), and ${armed.length} of them in a function that also hands the model tools. A prompt has no parameter binding: once the text is in the string, the model cannot tell your instruction from theirs.`
        : `${injections.length} place(s). None is in a function that also hands the model tools, so the worst case here is a wrong answer rather than a tool call somebody else chose.`,
      '',
    );
    for (const i of injections.slice(0, 20)) {
      lines.push(`- ${i.file}:${i.line} — ${i.origin}, in by ${i.through}${i.withTools ? ' — **and this function has tools**' : ''}`);
      lines.push(`  \`${i.evidence}\``);
    }
    if (injections.length > 20) lines.push(`…and ${injections.length - 20} more`);
    lines.push('');
  }

  lines.push('## The lethal trifecta', '');
  if (trifecta.complete) {
    lines.push('All three legs are present. Breaking any one of them breaks the attack:', '');
  } else {
    const missing = (Object.keys(trifecta.legs) as Capability[]).filter((c) => trifecta.legs[c].length === 0);
    lines.push(
      `Not all three legs are here - nothing was found that ${missing.map((m) => CAPABILITY_MEANS[m]).join(', nor that ')}.`,
      '',
      'That is worth keeping true. Adding one tool is all it takes, and the tool that completes it is',
      'usually the harmless-looking one.',
      '',
    );
  }
  for (const capability of Object.keys(trifecta.legs) as Capability[]) {
    const legTools = trifecta.legs[capability];
    lines.push(
      `- **${capability}** (${CAPABILITY_MEANS[capability]}): ${
        legTools.length === 0 ? 'nothing found' : legTools.slice(0, 6).map((t) => `\`${t.name}\``).join(', ') + (legTools.length > 6 ? `, and ${legTools.length - 6} more` : '')
      }`,
    );
  }
  lines.push('');

  lines.push(...coverageSection(coverage, tools, evals));

  lines.push(...configSection(config));

  lines.push('## What stands between them and the real world', '');
  for (const kind of ['asks-a-person', 'dry-run', 'step-budget', 'tool-allow-list'] as GuardKind[]) {
    const found = guards.find((g) => g.kind === kind);
    lines.push(
      found
        ? `- **${kind}** — found at ${found.file}:${found.line}. ${GUARD_MEANS[kind]}.`
        : `- **${kind}** — nothing found anywhere in this project. Without it: ${GUARD_PREVENTS[kind]}.`,
    );
  }
  lines.push('');

  if (emptyBudget) {
    lines.push(
      '### A ceiling that is written down and set to nothing',
      '',
      `\`${emptyBudget.text}\` in ${emptyBudget.file}. A budget removed this way reads as deliberate, and a check`,
      'that only looked for the word would have called it a budget.',
      '',
    );
  }

  lines.push(
    '## What this does not check',
    '',
    '- **Whether a gate that exists stands in front of these tools.** Finding `interrupt()` in a',
    '  project means somebody wrote one, not that the refund tool is behind it. That is a question',
    '  about the graph at run time, and reading the source does not answer it.',
    '- **Whether the agent is ever given these tools.** A tool can be defined and never passed to a',
    '  model. This lists what exists, not what is wired up.',
    '- **What the model will actually do with them.** No prompt was judged and nothing was run.',
    '- **Untrusted text reaching a prompt through more than one step.** A value that passes through',
    '  two variables, another function or a different file is not followed, and is not reported.',
    '- **Tools assembled at run time**, from a registry, a plugin folder or a config file.',
    '- **Frameworks not in the list above.** Silence about a framework is silence, not approval.',
    '',
    'Every line here is re-derivable: run `tewip agent` in this directory and you get it back.',
    '',
  );
  return lines.join(NL);
}

const rank = (r: Reach): number => (IRREVERSIBLE.includes(r) ? 0 : r === 'not-sure' ? 1 : r === 'writes' ? 2 : 3);

export function runAgent(cmd: AgentCommand): { report: string; ungated: number } {
  const scan = scanAgent(cmd.root);
  const report = renderAgent(scan, cmd.root);
  if (cmd.out) writeFileSync(cmd.out, report, 'utf8');
  else console.log(report);
  const asksAPerson = scan.guards.some((g) => g.kind === 'asks-a-person');
  const ungated = asksAPerson ? 0 : scan.tools.filter((t) => IRREVERSIBLE.includes(t.reach)).length;
  // The gate fails on the trifecta whether or not a person is asked: an approval step in front of
  // one tool does not close a path that runs through three.
  if (cmd.gate && (ungated > 0 || trifectaIn(scan.tools).complete)) process.exitCode = 1;
  return { report, ungated };
}
