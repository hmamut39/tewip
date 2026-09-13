// Plain ASCII table for terminal output, shared by the CLI scripts.
export function renderTable(headers: string[], rows: string[][], rightAligned: Set<number> = new Set()): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (cells: string[]) =>
    '| ' + cells.map((c, i) => (rightAligned.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(' | ') + ' |';
  return [line, fmt(headers), line, ...rows.map(fmt), line].join('\n');
}
