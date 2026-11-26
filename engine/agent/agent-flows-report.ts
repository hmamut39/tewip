// The four flow sections of the agent report: what reaches the model, whose credential the agent
// acts with, what is kept where it will be read back, and who can reach the agent.
//
// Split out of agent-command.ts in Phase 224, when ASI03 took that file past this project's
// 300-line rule. They belong together: each is a flow found in one function body, each says what
// it cannot see, and each names the OWASP risk it is about.
import type { PromptFlow } from './prompt-flow.ts';
import type { IdentityFlow } from './identity-flow.ts';
import type { MemoryFlow } from './memory-flow.ts';
import type { AgentDoor } from './agent-door.ts';

export function flowSections(injections: PromptFlow[], borrowed: IdentityFlow[], poisoned: MemoryFlow[], doors: AgentDoor[]): string[] {
  const lines: string[] = [];
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
      const goals = injections.filter((i) => i.goal);
      if (goals.length > 0) {
        lines.push(
          `**${goals.length} of them reach the system prompt**, which is a larger claim than the rest of this section. ` +
            'Text in a user turn can produce a wrong answer. Text in the system prompt rewrites what the agent is *for*, ' +
            'for every turn after it and for whoever is talking to it next, and the model cannot tell that instruction ' +
            'from the one you wrote because both arrive in the same place with the same standing. OWASP calls this ASI01, ' +
            'Agent Goal Hijack, and puts it first.',
          '',
        );
      }
      for (const i of injections.slice(0, 20)) {
        lines.push(`- ${i.file}:${i.line} — ${i.origin}, in by ${i.through}${i.goal ? ' — **into the system prompt**' : ''}${i.withTools ? ' — **and this function has tools**' : ''}`);
        lines.push(`  \`${i.evidence}\``);
      }
      if (injections.length > 20) lines.push(`…and ${injections.length - 20} more`);
      lines.push('');
    }

    if (borrowed.length > 0) {
      lines.push(
        '## The agent acting with somebody else\u2019s credential',
        '',
        `${borrowed.length} place(s) where the credential this process was handed is sent onward to something it calls. ` +
          'The Model Context Protocol authorization spec puts this one in writing: a server **"MUST NOT pass through the ' +
          'token it received from the MCP client"**. The service on the other end sees a credential belonging to a person ' +
          'and cannot tell that a model chose the request, so every scope that person has becomes a scope the agent has - ' +
          'which is the blast radius OWASP ASI03 is about.',
        '',
      );
      for (const b of borrowed.slice(0, 20)) {
        lines.push(`- ${b.file}:${b.line} \u2014 ${b.origin}, ${b.through}`);
        lines.push(`  \`${b.onward}\``);
      }
      if (borrowed.length > 20) lines.push(`\u2026and ${borrowed.length - 20} more`);
      lines.push(
        '',
        'The credential the spec asks for instead is one this process owns, from its environment or its own ' +
          'authorization server. What this does **not** check is the other half of ASI03: whether the agent\u2019s own ' +
          'permissions are wider than its task needs. That lives in an IAM policy or an OAuth client registration rather ' +
          'than in this source, so it is not something this check can see.',
        '',
      );
    }

    if (poisoned.length > 0) {
      lines.push(
        '## Text somebody else wrote, kept where it will be read back',
        '',
        `${poisoned.length} place(s) where outside text is written to a store that outlives the request. ` +
          'This is the longer-lived version of the section above, and the worse one. A prompt injected once is ' +
          'wrong once; text written into a store is retrieved again, for this user and for others, and arrives ' +
          'carrying the authority of something the agent itself remembered rather than of a web page.',
        '',
      );
      for (const p of poisoned.slice(0, 20)) {
        lines.push(`- ${p.file}:${p.line} — ${p.origin}, ${p.through}, into \`${p.store}\``);
        lines.push(`  \`${p.evidence}\``);
      }
      if (poisoned.length > 20) lines.push(`…and ${poisoned.length - 20} more`);
      lines.push(
        '',
        'What this does **not** say is whether that store is ever read back into a prompt. It is read in a ' +
          'later request, by code this check does not follow, so the finding is that the door exists rather ' +
          'than that somebody walked through it.',
        '',
      );
    }

    if (doors.length > 0) {
      lines.push(
        '## An agent interface somebody else can reach',
        '',
        `${doors.length} file(s) serve an agent protocol and bind beyond this machine. This is a fact read from the ` +
          'source, not a finding against it: Tewip cannot see the ingress, the service mesh or the security group ' +
          'that may well be doing the authentication, and binding to every interface inside a container with a ' +
          'gateway in front of it is correct. What it can say is where the door is.',
        '',
      );
      for (const d of doors.slice(0, 20)) {
        lines.push(`- ${d.file}:${d.line} — serves \`${d.door}\`, binds \`${d.binding}\``);
        lines.push(d.auth ? `  Something in this file checks a caller: \`${d.auth}\`` : '  **Nothing in this file checks who is calling.** The check may be elsewhere; this says only that it is not here.');
      }
      if (doors.length > 20) lines.push(`…and ${doors.length - 20} more`);
      lines.push('');
    }
  return lines;
}
