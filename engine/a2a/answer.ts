// Phase 34: turning another agent's message into one of Tewip's verdicts.
//
// The interesting decision here is what to do when the message is vague, and the answer is the same
// one the rest of this project gives: ask rather than guess. A2A has a state for exactly that -
// TASK_STATE_INPUT_REQUIRED - so a caller who says "check my code" gets back a question naming the
// skills Tewip has, not a guess at which of eight things they meant. Guessing would make Tewip
// occasionally run a twenty-minute job nobody asked for, and occasionally answer the wrong question
// confidently, which is the failure this whole product exists to avoid.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ANSWERABLE, skillById, type AgentSkill } from './card.ts';

/** A message as A2A defines it: role is ROLE_USER or ROLE_AGENT, and a part holds exactly one of these. */
export interface A2AMessage {
  messageId?: unknown;
  role?: unknown;
  parts?: unknown;
  metadata?: unknown;
}

export type Choice =
  | { kind: 'skill'; skill: AgentSkill & { verb: string }; text: string }
  | { kind: 'ask'; why: string }
  | { kind: 'unknown'; asked: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The words in a message, from its text parts. A2A puts the text directly on the part. */
export function textOf(message: A2AMessage): string {
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .map((p) => (p && typeof p === 'object' ? str((p as Record<string, unknown>).text) : ''))
    .filter((t) => t !== '')
    .join(' ')
    .trim();
}

/** A skill named outright, either in the message metadata or in a data part. */
function namedSkill(message: A2AMessage): string {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const fromMeta = str(meta.skillId ?? meta.skill);
  if (fromMeta !== '') return fromMeta;
  if (!Array.isArray(message.parts)) return '';
  for (const part of message.parts) {
    if (!part || typeof part !== 'object') continue;
    const data = (part as Record<string, unknown>).data;
    if (data && typeof data === 'object') {
      const named = str((data as Record<string, unknown>).skillId ?? (data as Record<string, unknown>).skill);
      if (named !== '') return named;
    }
  }
  return '';
}

/** How well a skill matches some words: its own tags and name, scored by how specific the word is. */
function scoreOf(skill: AgentSkill & { verb: string }, words: string[]): number {
  const haystack = `${skill.id} ${skill.verb} ${skill.name} ${skill.tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (word.length < 4) continue;
    if (haystack.includes(word)) score += word.length >= 7 ? 2 : 1;
  }
  return score;
}

/**
 * Which skill a message is asking for.
 *
 * An id given outright always wins, because a calling agent that read the card should be taken at
 * its word. Otherwise the words are matched, and a tie or a blank is a question rather than a coin
 * toss: two skills scoring the same means Tewip genuinely does not know which was meant.
 */
export function chooseSkill(message: A2AMessage): Choice {
  const asked = textOf(message);
  const named = namedSkill(message);
  if (named !== '') {
    const skill = skillById(named);
    if (skill) return { kind: 'skill', skill, text: asked };
    return { kind: 'unknown', asked: named };
  }

  const words = asked.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = ANSWERABLE.map((skill) => ({ skill, score: scoreOf(skill, words) })).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score === 0) {
    return { kind: 'ask', why: 'nothing in that message names one of the things Tewip answers' };
  }
  if (next && next.score === best.score) {
    return { kind: 'ask', why: `that could be "${best.skill.name}" or "${next.skill.name}", and Tewip will not pick for you` };
  }
  return { kind: 'skill', skill: best.skill, text: asked };
}

/** The question Tewip asks back when it will not guess, listing what it can actually answer. */
export function askWhich(why: string): string {
  const list = ANSWERABLE.map((s) => `- \`${s.id}\` — ${s.name}`).join('\n');
  return [
    `Tewip will not guess which question you are asking: ${why}.`,
    '',
    'Send the skill id in the message metadata as `skillId`, or say which of these you want:',
    '',
    list,
  ].join('\n');
}

export function cliEntry(): string | null {
  const here = import.meta.dirname;
  for (const candidate of [join(here, '..', '..', 'cli', 'tewip.ts'), join(here, '..', '..', 'cli', 'tewip.js')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface Answered {
  text: string;
  failed: boolean;
}

/**
 * Runs the verb and returns what it printed.
 *
 * The command line is the gate every one of these verdicts already goes through, so A2A reuses it
 * rather than reaching into the engine: one code path means a verdict delivered to an agent cannot
 * quietly differ from the same verdict delivered to a person.
 */
export function runSkill(root: string, skill: AgentSkill & { verb: string }, args: string[], timeoutMs = 10 * 60_000): Answered {
  const entry = cliEntry();
  if (entry === null) return { text: 'Tewip could not find its own command line, so it cannot answer.', failed: true };
  const ran = spawnSync(process.execPath, [entry, skill.verb, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (ran.error) return { text: `Tewip could not run \`${skill.verb}\`: ${ran.error.message}`, failed: true };
  const out = `${ran.stdout ?? ''}${ran.stderr ? `\n${ran.stderr}` : ''}`.trim();
  // A non-zero exit is how the gating verbs report a real problem, so it is an answer rather than a
  // failure. Only an empty answer means something actually went wrong.
  return { text: out === '' ? `\`${skill.verb}\` produced no output.` : out, failed: out === '' };
}
