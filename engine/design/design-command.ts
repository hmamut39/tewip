// `tewip design <figma link or saved frame.json> --url <page>`
//
// Reads the design, reads the running page, and says where they disagree. No model is called: both
// sides are read as facts, so the answer is the same every time and the run costs nothing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readPages } from '../quality/grounding.ts';
import { Figma, figmaHelp, figmaTokenFromEnv, parseFigmaUrl, topFrames, type FigmaNode } from './figma.ts';
import { frameChecks, type DesignCheck } from './frame.ts';
import { compareDesign, renderDrift, type Drift } from './drift.ts';
import { loadVerdicts, saidByAPerson, verdictFor } from '../learn/verdicts.ts';

export interface DesignCommand {
  /** A Figma link, or a path to a saved Figma node JSON. */
  design: string;
  /** The running page to compare against. Without it, the checks are printed and nothing compared. */
  url?: string;
  root: string;
  /** Which frame, when the design has several. */
  frame?: string;
  out?: string;
  max?: number;
}

/** A saved Figma response, in any of the shapes Figma's API returns. */
function fromFile(path: string): { node: FigmaNode; name: string } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  const node: FigmaNode | undefined = raw.document ?? (raw.nodes ? (Object.values(raw.nodes)[0] as any)?.document : undefined) ?? (raw.type ? (raw as FigmaNode) : undefined);
  if (!node) throw new Error(`${path} is not a Figma node or file response (expected a "document", "nodes" or a node with a "type")`);
  return { node, name: raw.name ?? node.name ?? basename(path) };
}

/** The frame to check: the one asked for, the only one there is, or the first with a note. */
function pickFrame(node: FigmaNode, wanted?: string): { frame: FigmaNode; note: string | null } {
  const frames = topFrames(node);
  if (frames.length === 0) return { frame: node, note: null };
  if (wanted) {
    const found = frames.find((f) => f.name.toLowerCase().includes(wanted.toLowerCase()));
    if (!found) throw new Error(`no frame named like "${wanted}". The design has: ${frames.map((f) => f.name).join(', ')}`);
    return { frame: found, note: null };
  }
  const others = frames.slice(1).map((f) => f.name);
  return { frame: frames[0], note: others.length ? `Checked the frame "${frames[0].name}". Also in this design: ${others.slice(0, 8).join(', ')}${others.length > 8 ? ', ...' : ''} (--frame "<name>").` : null };
}

function renderChecks(checks: DesignCheck[], design: string): string {
  const lines = [`Design: ${design}`, '', `${checks.length} check(s) read from the design:`, ''];
  for (const c of checks) lines.push(`  ${c.kind === 'role' ? `${c.role} "${c.name}"` : `text "${c.name}"`}\n    in the design: ${c.from}`);
  lines.push('', 'Add --url http://localhost:3000/page to compare these against the running page.');
  return lines.join('\n');
}

export async function runDesign(cmd: DesignCommand): Promise<Drift[]> {
  const local = existsSync(cmd.design);
  let source: { node: FigmaNode; name: string };
  if (local) {
    source = fromFile(cmd.design);
  } else {
    const target = parseFigmaUrl(cmd.design);
    if (!target) throw new Error(`not a Figma link or a saved frame file: ${cmd.design}`);
    const token = figmaTokenFromEnv();
    if (!token) throw new Error(figmaHelp());
    const got = await new Figma(token).frame(target);
    source = { node: got.node, name: got.fileName };
  }

  const { frame, note } = pickFrame(source.node, cmd.frame);
  const design = `${source.name}${frame.name && frame.name !== source.name ? ` / ${frame.name}` : ''}`;
  const checks = frameChecks(frame, cmd.max ?? 60);
  if (checks.length === 0) throw new Error(`no checkable words or controls in ${design}. Tewip reads text layers and layer names like "Button" or "Text Field"; a frame of images says nothing it can verify.`);

  if (!cmd.url) {
    console.log(renderChecks(checks, design));
    if (note) console.log(`\n${note}`);
    return [];
  }

  const { pages, note: pageNote } = await readPages([cmd.url], cmd.root, 40_000);
  if (pages.length === 0) {
    console.log(renderChecks(checks, design));
    console.log(`\nThe page was not read, so nothing was compared: ${pageNote ?? 'unknown reason'}`);
    return [];
  }

  const found = compareDesign(checks, pages[0].aria);
  // A difference a person has already looked at and accepted is not reported again as a surprise.
  const corrections = loadVerdicts(cmd.root);
  const settled: string[] = [];
  const drifts = found.map((d) => {
    const key = `${d.check.role ?? d.check.kind} ${d.check.name}`.trim();
    const said = verdictFor('design', key, corrections) ?? verdictFor('design', d.check.name, corrections);
    if (!said || said.verdict !== 'not-a-difference') return d;
    settled.push(`${key}: ${saidByAPerson(said)}`);
    return { ...d, verdict: 'met' as const };
  });
  const alreadySettled = settled.length
    ? ['', `${settled.length} difference(s) your team has already settled, so they are not reported:`, ...settled.map((s) => `  - ${s}`)].join('\n')
    : '';
  const report = [renderDrift(drifts, design, cmd.url), alreadySettled].filter(Boolean).join('\n');
  console.log(report);
  if (note) console.log(`\n${note}`);
  if (cmd.out) {
    writeFileSync(cmd.out, cmd.out.endsWith('.json') ? JSON.stringify({ design, url: cmd.url, drifts }, null, 2) : report, 'utf8');
    console.log(`\nWritten to ${cmd.out}`);
  }
  return drifts;
}
