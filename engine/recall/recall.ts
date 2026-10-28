// Phase 17: has this happened here before, and what did we decide?
//
// The industry answer in 2026 is to embed everything into a vector database and ask a model. That
// would work, and it would quietly cost more per answer than Tewip's entire diagnosis pipeline,
// which answers three quarters of failures for nothing at all. So the rule that made the diagnosis
// layer cheap - rules before models - becomes retrieval before generation here: search Tewip's own
// history with no model and no network, measure how good that is on real data, and only reach for
// embeddings if the measurement says lexical search is not enough.
//
// Tewip has one advantage no general tool has. It already stores, for this project, every failure
// it has seen, what it decided, which rule decided it, and every time a person disagreed. The
// question worth answering is not "what does the internet say about this error" but "what did WE
// conclude last time", and that question has a citable answer.
import type { TriageRecord } from '../../reporters/types.ts';
import type { Correction } from '../corrections.ts';
import { errorShape } from '../signature.ts';
import { oneRowPerFailure, oneRowPerProblem, type Grouped } from './same.ts';

export interface Memory {
  testId: string;
  /** What Tewip decided, or what a person decided instead. */
  category: string;
  /** rules, llm, or a person's name when they corrected it. */
  decidedBy: string;
  when: string;
  runId: string;
  /** The error as it was, trimmed for reading. */
  error: string;
  /**
   * The whole error, for matching. Indexing the trimmed one was a real bug: pytest puts a long
   * absolute path first, so on a real project every one of the 220 characters was the path and the
   * words that mattered - "fixture", "benchmark" - were never indexed at all. Searching found
   * nothing in a history made entirely of that error.
   */
  full?: string;
  /**
   * How many records this memory folds: a failing test that was retried twice is kept three times
   * by the reporter, and counting those as three pieces of history inflated every number recall
   * printed. See `oneRowPerFailure`.
   */
  attempts?: number;
  /** Set when a person overruled Tewip here: the most valuable memory of all. */
  correctedBy?: string;
  correctionReason?: string;
}

export interface Recalled extends Memory {
  /** 0 to 1. What it means is in `why`, which is what a person actually reads. */
  score: number;
  why: string;
}

/** Words worth matching on: rare, specific, not the furniture of every stack trace. */
const COMMON = new Set([
  'error','failed','failure','test','expected','received','actual','value','object','null','undefined','true','false','none','with','from','this','that','have','been','were','when','then','there','which','while','after','before','timeout','waiting','call','log','line','file','at','in','on','of','to','for','and','the','a','an','is','it','was','not','no','yes',
]);

const words = (text: string): string[] =>
  (errorShape(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !COMMON.has(w));

/**
 * How rare each word is across the history: a word in every failure tells you nothing.
 *
 * `unseen` is the weight for a word the history has never contained, and getting it wrong was a
 * real bug with a sharp edge. The fallback used to be 1 - the *lowest* weight in the scheme, the
 * one given to a word in every single failure. A word in no failure at all is the rarest word
 * there is, so this scored it as the most common, which inverts the one signal that matters when
 * the question is about something new.
 *
 * Asked "the VAT column on the quarterly invoice PDF is rounded down", a question with nothing to
 * do with the project, recall answered "5 earlier problem(s) in this project's history look like
 * this one". Measured on gutenberg's 596 kept failures: of the seven words that survive the stop
 * list, five appear in none of them, "column" appears in 4 (weight 6.00) and "down" in 7 (5.44).
 * Weighting the five unknown words 1 apiece puts the denominator at 16.45, so a failure sharing
 * nothing but the word "column" scores 0.365 and clears the 0.15 bar comfortably. Weighting them
 * log(2N)+1 = 8.08 puts it at 51.87, and the same failure scores 0.116 and is rejected.
 *
 * A word in zero documents is weighted as if it were in half of one, which is the standard
 * treatment and also the honest one: unknown words are what make a question new here.
 */
function rarity(all: string[][]): { weight: Map<string, number>; unseen: number } {
  const seen = new Map<string, number>();
  for (const doc of all) for (const w of new Set(doc)) seen.set(w, (seen.get(w) ?? 0) + 1);
  const total = Math.max(all.length, 1);
  const weight = new Map<string, number>();
  for (const [w, n] of seen) weight.set(w, Math.log(total / n) + 1);
  return { weight, unseen: Math.log(total / 0.5) + 1 };
}

/** Everything Tewip has kept about this project, as memories that can be cited. */
export function memories(records: TriageRecord[], corrections: Correction[] = []): Memory[] {
  const byShape = new Map<string, Correction>();
  for (const c of corrections) byShape.set(`${c.testId}::${c.errorShape}`, c);
  const out: Memory[] = [];
  for (const record of records) {
    const diagnosis = record.diagnosis as { category?: string; source?: string } | undefined;
    if (!diagnosis?.category) continue;
    const correction = byShape.get(`${record.testId}::${errorShape(record.errorMessage)}`);
    out.push({
      testId: record.testId,
      category: correction?.category ?? diagnosis.category,
      decidedBy: correction ? `${correction.by} (a person)` : String(diagnosis.source ?? 'unknown'),
      when: record.timestamp,
      runId: record.runId,
      error: (record.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 220),
      full: (record.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 4000),
      ...(correction ? { correctedBy: correction.by, correctionReason: correction.reason } : {}),
    });
  }
  return oneRowPerFailure(out);
}

export interface RecallOptions {
  /** Only memories of this test, when the question is about one test. */
  testId?: string;
  limit?: number;
}

/**
 * The memories that answer a question, most useful first.
 *
 * Three things decide the order, and each is stated in `why` so a person can disagree with it: the
 * same error shape is the strongest signal there is, the same test is next, and shared rare words
 * carry the rest. A memory a person corrected is lifted above one only Tewip decided, because what
 * the team concluded outranks what the tool concluded.
 */
export function recall(question: string, all: Memory[], { testId, limit = 5 }: RecallOptions = {}): Grouped[] {
  if (all.length === 0) return [];
  const docs = all.map((m) => words(`${m.testId} ${m.full ?? m.error}`));
  const { weight, unseen } = rarity(docs);
  const asked = new Set(words(question));
  const askedShape = errorShape(question);

  const scored = all.map((memory, i) => {
    const shared = docs[i].filter((w) => asked.has(w));
    // Shared words are in `docs` by definition, so they are always in the map. The asked words
    // need not be, and those are exactly the ones that say this question is new here.
    const mass = [...new Set(shared)].reduce((sum, w) => sum + (weight.get(w) ?? unseen), 0);
    const possible = [...asked].reduce((sum, w) => sum + (weight.get(w) ?? unseen), 0) || 1;
    let score = Math.min(mass / possible, 1);
    const reasons: string[] = [];
    if (askedShape && errorShape(memory.full ?? memory.error) === askedShape) {
      score = Math.max(score, 0.95);
      reasons.push('the same error, word for word once the changing parts are removed');
    } else if (shared.length > 0) {
      reasons.push(`shares ${[...new Set(shared)].slice(0, 4).join(', ')}`);
    }
    if (testId && memory.testId === testId) {
      score = Math.min(score + 0.25, 1);
      reasons.push('the same test');
    }
    if (memory.correctedBy) {
      score = Math.min(score + 0.1, 1);
      reasons.push(`${memory.correctedBy} corrected this one`);
    }
    return { ...memory, score, sameTest: Boolean(testId && memory.testId === testId), why: reasons.join('; ') || 'nothing in common but the project' };
  });

  // Two memories can both reach the ceiling - an identical error recorded twice does - so the
  // ordering needs a tie-break of its own. When the question is about one test, that test's own
  // history comes first; otherwise the most recent, because the project changes underneath you.
  //
  // Grouping happens before the limit and not after, which is the whole point of it: when one
  // recurring problem owned four of the five slots, cutting first and grouping second would have
  // produced a single row and thrown the other history away instead of showing it.
  const ordered = scored
    .filter((m) => m.score > 0.15)
    .sort((a, b) => b.score - a.score || Number(b.sameTest) - Number(a.sameTest) || (b.when > a.when ? 1 : -1))
    .map(({ sameTest, ...rest }) => rest);
  return oneRowPerProblem(ordered).slice(0, limit);
}

/** What a person reads. Every line names the run it came from, so nothing has to be believed. */
/**
 * What a person reads.
 *
 * `searched` is not decoration. "Nothing in this project's history resembles it" is only an answer
 * if something was actually compared against, and on a real 1,305-failure history this said exactly
 * that while the searchable set was **empty** - see `recallReport`. The number belongs in the report
 * body rather than only on stderr, because an MCP client and a `> file` both keep the body and throw
 * stderr away, which is precisely where a reader would have caught it.
 */
export function renderRecall(question: string, found: Grouped[], searched?: number): string {
  const lines = [`# What this project already knows`, '', `Asked: ${question.replace(/\s+/g, ' ').slice(0, 160)}`, ''];
  if (found.length === 0) {
    const against = searched === undefined ? 'this project\'s history' : `the ${searched} diagnosed failure(s) kept here`;
    lines.push(
      `Nothing in ${against} resembles it. That is an answer, not a failure: it means`,
      'this is new here, and there is no earlier decision to follow.',
    );
    return lines.join('\n');
  }
  const corrected = found.filter((f) => f.correctedBy);
  const runs = found.reduce((sum, f) => sum + f.occurrences, 0);
  // The headline counts problems, not records. Saying "5 earlier failure(s)" of what turned out to
  // be one test retried three times in one run was the bug this report was built to stop making.
  const spread = runs > found.length ? `, across ${runs} run(s)` : '';
  lines.push(
    `${found.length} earlier problem(s) in this project's history look like this one${spread}.${corrected.length > 0 ? ` ${corrected.length} a person judged themselves.` : ''}`,
    '',
  );
  for (const memory of found) {
    lines.push(`- **${memory.category}** — ${memory.testId}`);
    lines.push(`  - Decided by ${memory.decidedBy}${memory.when ? ` on ${memory.when.slice(0, 10)}` : ''}, run \`${memory.runId}\``);
    if (memory.occurrences > 1) {
      const span = memory.firstSeen && memory.lastSeen ? `, ${memory.firstSeen.slice(0, 10)} to ${memory.lastSeen.slice(0, 10)}` : '';
      lines.push(`  - Seen in ${memory.occurrences} separate run(s)${span}`);
    }
    if ((memory.attempts ?? 1) > memory.occurrences) {
      lines.push(`  - Failed ${memory.attempts} time(s) in those run(s), retries counted`);
    }
    if (memory.disagreed) {
      // "We did not agree" would be a claim about people. Most of these decisions are the rule
      // engine's, and when it gave the same failure two different categories in two runs that is
      // worth saying plainly without dressing it up as a human disagreement.
      lines.push(`  - **The earlier decisions do not agree:** ${memory.disagreed}. There is no single earlier conclusion to follow here.`);
    }
    if (memory.correctionReason) lines.push(`  - They said: ${memory.correctionReason}`);
    lines.push(`  - Why it matched: ${memory.why}`);
    lines.push(`  - The error then: ${memory.error.slice(0, 140)}`);
  }
  lines.push('', 'No model was called to answer this, and nothing above is a guess: each line is a record kept from a real run of this project.');
  return lines.join('\n');
}
