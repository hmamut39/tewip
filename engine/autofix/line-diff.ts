// A real line diff, so that what a reviewer reads and what the size rule counts are the same thing.
//
// Tewip used to measure a change by the span from the first differing line to the last, and to
// print that whole span as the patch. In a measurement against real bug fixes that called a
// two-line fix in two places a "56-line rewrite", and printed 90 lines for a change that moved one
// block. Both numbers were wrong in the same way, so both are computed from this diff now.

export type Op = { kind: ' ' | '-' | '+'; line: string };

/** The common lines at the start and end, which no diff needs to look at. */
function trim(a: string[], b: string[]): { head: number; tail: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, tail };
}

/** How many cells of the table below are affordable; beyond this the middle is shown as one block. */
const MAX_CELLS = 4_000_000;

/**
 * Line-by-line difference of two texts. The common start and end are matched first, and the rest is
 * aligned with a longest-common-subsequence table - exact, and small enough here because only the
 * part that really differs reaches it.
 */
export function lineDiff(before: string, after: string): Op[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const { head, tail } = trim(a, b);
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops: Op[] = a.slice(0, head).map((line) => ({ kind: ' ' as const, line }));
  if (midA.length * midB.length > MAX_CELLS) {
    // Too big to align exactly; saying so plainly beats pretending.
    ops.push(...midA.map((line) => ({ kind: '-' as const, line })), ...midB.map((line) => ({ kind: '+' as const, line })));
  } else {
    ops.push(...align(midA, midB));
  }
  ops.push(...a.slice(a.length - tail).map((line) => ({ kind: ' ' as const, line })));
  return ops;
}

function align(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: '-', line: a[i++] });
    } else {
      ops.push({ kind: '+', line: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] });
  while (j < m) ops.push({ kind: '+', line: b[j++] });
  return ops;
}

/** The lines a change really adds or removes. */
export function countChanged(ops: Op[]): number {
  return ops.filter((op) => op.kind !== ' ').length;
}

/** A unified diff, with the usual three lines of context around each hunk. */
export function renderDiff(file: string, ops: Op[], context = 3): string {
  const interesting = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (interesting.length === 0) return '';
  const hunks: Array<{ from: number; to: number }> = [];
  for (const index of interesting) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = hunks.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else hunks.push({ from, to });
  }

  const lines = [`--- a/${file}`, `+++ b/${file}`];
  for (const hunk of hunks) {
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < hunk.from; k++) {
      if (ops[k].kind !== '+') oldLine++;
      if (ops[k].kind !== '-') newLine++;
    }
    const slice = ops.slice(hunk.from, hunk.to + 1);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    lines.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const op of slice) lines.push(`${op.kind}${op.line}`);
  }
  return lines.join('\n');
}
