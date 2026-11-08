// The document: a frame around the four sections, a summary nobody has to read nine pages for,
// and the two sections that keep it honest - what each claim is worth, and what it does not cover.
//
// There is no overall verdict here, and that is deliberate. A pack that printed PASS would be worth
// exactly as much as the weakest check inside it, and a reader would stop at the word. What it
// prints instead is a count of what was established, a count of what was not, and the list of
// things waiting on a person - which is the decision an IT department is actually making.
import { confidenceSection } from './confidence.ts';
import type { Evidence, Part } from './gather.ts';
import { whatItMayDo, whatShips, whatWouldBreak, whoApproved } from './sections.ts';

const NL = String.fromCharCode(10);

/** Every check in the pack, in the order the document asks about them. */
export const CHECKS: Array<{ key: keyof Evidence; label: string; command: string }> = [
  { key: 'ships', label: 'dependencies and their licences', command: 'sbom' },
  { key: 'image', label: 'what the container image installs', command: 'sbom' },
  { key: 'agent', label: 'what a model is allowed to do', command: 'agent' },
  { key: 'infra', label: 'what the infrastructure permits', command: 'infra' },
  { key: 'access', label: 'who can use the interface', command: 'access' },
  { key: 'schema', label: 'what a database migration does', command: 'schema' },
  { key: 'contracts', label: 'whether a published interface broke', command: 'contract' },
  { key: 'secrets', label: 'committed credentials', command: 'secure' },
  { key: 'approvals', label: 'who ran what', command: 'audit' },
];

const partOf = (e: Evidence, key: keyof Evidence): Part<unknown> => e[key] as Part<unknown>;

/** What this pack is about, and the refusal to pretend when it cannot say. */
function subject(e: Evidence): string[] {
  const { subject: s } = e;
  const lines = s.noGit
    ? [`**This pack names no commit**: ${s.noGit}. It describes the files as they were on disk at ${e.at}, and nothing more.`, '']
    : [`Commit: \`${s.commit}\``, ''];
  // Said on both paths, not only when a commit was found. A repository with no commits yet still
  // has a root, and a pack about a folder inside one that did not say so read as a pack about
  // everything under that root.
  if (s.partOf) {
    lines.push(
      `This folder is **part of a larger repository** rooted at \`${s.partOf}\`${s.noGit ? '' : ', so the commit above is that repository’s'}. ` +
        'Everything else in this pack was read from this folder alone, and nothing here describes the rest of that repository.',
      '',
    );
  }
  if (s.noGit) return lines;
  if (s.dirty.length > 0) {
    // The pack is signed. A signature over "this describes commit abc123" while the tree held
    // uncommitted changes makes a false statement portable, which is worse than no document.
    lines.push(
      `**The working tree was not clean when this ran**, so this pack does **not** describe commit \`${(s.commit ?? '').slice(0, 12)}\` as published. ` +
        `${s.dirty.length} file(s) differed from it, beginning with ${s.dirty.slice(0, 3).map((f) => `\`${f}\``).join(', ')}. ` +
        'Commit or stash them and run this again for a pack that describes a commit somebody else can check out.',
      '',
    );
  }
  return lines;
}

/** The count a reader starts from: how much of this document established anything. */
function summary(e: Evidence): string[] {
  const established = CHECKS.filter((c) => partOf(e, c.key).result !== undefined);
  const refused = CHECKS.filter((c) => partOf(e, c.key).refused !== undefined);
  const lines = [
    '## In one page',
    '',
    `${established.length} of ${CHECKS.length} checks established an answer${refused.length > 0 ? `; ${refused.length} did not` : ''}. ` +
      'There is no overall pass or fail here: a single word would be worth no more than the weakest check behind it, and a reader would stop at the word.',
    '',
  ];
  if (refused.length > 0) {
    lines.push('**These established nothing, and no section below should be read as a clean result for them:**', '');
    for (const c of refused) lines.push(`- ${c.label} (\`tewip ${c.command}\`) — ${partOf(e, c.key).refused}`);
    lines.push('');
  }
  lines.push(`Each check that ran names, in its own section, what it did not look at. Every number in the confidence table was measured against a list somebody else published.`, '');
  return lines;
}

/**
 * The closing section, and the one that decides whether this document is worth anything.
 *
 * A pack that lists nine clean checks and stops is an argument that the software is fine. It is not
 * that, and cannot be: nine deterministic file readers do not add up to an assurance. So the limits
 * are stated in the pack itself rather than left for somebody to discover, and they are stated last
 * where a reader who skims one section will still meet them.
 */
function limits(e: Evidence): string[] {
  const lines = ['## What this pack does not cover', ''];
  const notChecked = new Set<string>();
  const shipped = e.ships.result;
  for (const why of shipped?.notRead ?? []) notChecked.add(why);
  for (const why of e.infra.result?.notChecked ?? []) notChecked.add(why);
  if (e.access.result) {
    notChecked.add('contrast, focus order, and whether alt text is any good: these need a rendered page, and `tewip access --report <axe.json>` settles them');
  }
  if (e.agent.result) {
    notChecked.add('whether a guard found in this project stands in front of any particular tool: that is a property of the running graph, not of the files');
  }
  if (e.image.result && e.image.result.dockerfiles > 0) {
    notChecked.add('the contents of the base image itself, which needs the built image rather than the Dockerfile');
  }
  lines.push(
    'Every check here reads files. None of them runs the software, and no model was called for any claim in this document.',
    'That is the source of its reliability and the boundary of its reach: nine deterministic file readers do not add up to an assurance that the software is fit for anything.',
    '',
    'Specifically not covered:',
    '',
    ...[...notChecked].map((w) => `- ${w}`),
    '- whether the tests are any good, which `tewip vouch` measures separately by breaking the code and seeing whether they notice',
    '- anything no file records: a decision taken in a meeting, an approval given verbally, a control enforced by a platform rather than a manifest',
    '- every language, framework and file format not listed as read above. A check that cannot read a file reports that it could not; it never reports it as clean',
    '',
    'None of the above is a finding of nothing. They are the questions this document does not answer.',
    '',
  );
  return lines;
}

export function renderEvidence(e: Evidence): string {
  const ran = CHECKS.filter((c) => partOf(e, c.key).result !== undefined).map((c) => c.command);
  return [
    `# Evidence pack: ${e.project}`,
    '',
    ...subject(e),
    `Produced by Tewip ${e.version} (rules engine ${e.engine}) at ${e.at}, in ${e.seconds}s, by running every check once over \`${e.root}\`.`,
    '',
    'This answers four questions about one repository: what ships, what it is allowed to do, what breaks if it ships, and who approved it — ',
    'together with how much each answer is worth. Nothing in it was written by a model.',
    '',
    ...summary(e),
    ...whatShips(e),
    ...whatItMayDo(e),
    ...whatWouldBreak(e),
    ...whoApproved(e),
    ...confidenceSection([...new Set(ran)]),
    ...limits(e),
  ].join(NL);
}
