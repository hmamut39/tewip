// Phase 11: the design against the page. What matters here is restraint again - Tewip must only
// claim what it can read on both sides, must not invent roles from layer names that say nothing,
// and must call a renamed button renamed rather than missing.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseFigmaUrl, topFrames, type FigmaNode } from '../design/figma.ts';
import { frameChecks, impliedLandmark, impliedRole } from '../design/frame.ts';
import { compareDesign, pageElements } from '../design/drift.ts';
import { runDesign } from '../design/design-command.ts';

const text = (id: string, name: string, characters: string): FigmaNode => ({ id, name, type: 'TEXT', characters });

/** A frame shaped the way Figma really returns one: components as instances, text inside them. */
const FRAME: FigmaNode = {
  id: '1:2',
  name: 'Sign in',
  type: 'FRAME',
  children: [
    { id: '1:3', name: 'Heading/H1', type: 'FRAME', children: [text('1:4', 'Title', 'Welcome back')] },
    { id: '1:5', name: 'Text Field/Default', type: 'INSTANCE', children: [text('1:6', 'Label', 'Email address'), text('1:7', 'Placeholder', 'you@example.com')] },
    { id: '1:8', name: 'Button/Primary/Large', type: 'INSTANCE', children: [text('1:9', 'Label', 'Sign in')] },
    { id: '1:10', name: 'Link', type: 'INSTANCE', children: [text('1:11', 'Label', 'Forgot your password?')] },
    { id: '1:12', name: 'Body', type: 'TEXT', characters: 'By signing in you agree to the terms.' },
    { id: '1:13', name: 'Divider', type: 'RECTANGLE' },
    { id: '1:14', name: 'Hidden note', type: 'TEXT', characters: 'Not shipped yet', visible: false },
    { id: '1:15', name: 'Spacer', type: 'TEXT', characters: '  ' },
  ],
};

describe('reading a design', () => {
  it('takes the file key and frame from any Figma link', () => {
    assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbCdEf123456/Shop?node-id=12-34&t=x'), { key: 'AbCdEf123456', nodeId: '12:34' });
    assert.deepEqual(parseFigmaUrl('https://www.figma.com/file/AbCdEf123456/Shop'), { key: 'AbCdEf123456', nodeId: undefined });
    assert.equal(parseFigmaUrl('https://example.com/design/x'), null);
  });

  it('reads a role only from layer names that say what a thing is', () => {
    assert.equal(impliedRole('Button/Primary'), 'button');
    assert.equal(impliedRole('Text Field'), 'textbox');
    assert.equal(impliedRole('H2'), 'heading');
    assert.equal(impliedRole('Frame 41'), null, 'a default Figma name says nothing');
    assert.equal(impliedRole('Card'), null, 'a card is not an ARIA role');
  });

  it('turns a frame into checks, and leaves hidden and empty layers out', () => {
    const checks = frameChecks(FRAME);
    const roles = checks.filter((c) => c.kind === 'role').map((c) => `${c.role} "${c.name}"`);
    assert.deepEqual(roles, ['heading "Welcome back"', 'textbox "Email address"', 'button "Sign in"', 'link "Forgot your password?"']);
    const texts = checks.filter((c) => c.kind === 'text').map((c) => c.name);
    assert.deepEqual(texts, ['By signing in you agree to the terms.'], 'a control label is not also checked on its own');
    assert.ok(!JSON.stringify(checks).includes('Not shipped yet'), 'a layer hidden in the design is not a requirement');
    const field = checks.find((c) => c.name === 'Email address');
    assert.match(field?.from ?? '', /Sign in \/ Text Field/, 'a check says where in the design it came from');
  });

  // These three come from real Figma files, where the reader got them wrong before.
  it('reads the names real files use, and does not read roles into names that only look like one', () => {
    assert.equal(impliedRole('Button__Active'), 'button', 'a variant suffix is still a button');
    assert.equal(impliedRole('Button/Type=Primary'), 'button');
    assert.equal(impliedRole('CTA Button'), 'button');
    assert.equal(impliedLandmark('Footer Section'), 'contentinfo');
    assert.equal(impliedLandmark('Section Header'), null, 'the header of a section is not the page banner');
    assert.equal(impliedLandmark('Hero'), null);
  });

  it('does not turn a paragraph into a link because its text style is called "Link inline"', () => {
    const frame: FigmaNode = {
      id: '3:0', name: 'Post', type: 'FRAME', children: [
        { id: '3:1', name: 'Link inline', type: 'TEXT', characters: 'Meritocracy is a fantasy, and inheritance should go with it.' },
        { id: '3:2', name: 'Link', type: 'TEXT', characters: 'Read more' },
      ],
    };
    const checks = frameChecks(frame);
    assert.equal(checks.find((c) => c.name.startsWith('Meritocracy'))?.kind, 'text', 'a sentence is words, not a control name');
    assert.equal(checks.find((c) => c.name === 'Read more')?.role, 'link');
  });

  it('asks for the regions a design names, and only the ones a loaded page really shows', () => {
    const frame: FigmaNode = {
      id: '4:0', name: 'Home', type: 'FRAME', children: [
        { id: '4:1', name: 'Navbar', type: 'FRAME', children: [text('4:2', 'Item', 'Pricing')] },
        { id: '4:3', name: 'Modal', type: 'FRAME', children: [text('4:4', 'Item', 'Are you sure?')] },
      ],
    };
    const landmarks = frameChecks(frame).filter((c) => c.kind === 'landmark').map((c) => c.role);
    assert.deepEqual(landmarks, ['navigation'], 'a modal is drawn in the design but hidden in the page');
  });

  it('finds the frames in a whole file', () => {
    const file: FigmaNode = { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Page 1', type: 'CANVAS', children: [FRAME, { id: '2:0', name: 'Sign up', type: 'FRAME', children: [] }] }] };
    assert.deepEqual(topFrames(file).map((f) => f.name), ['Sign in', 'Sign up']);
  });
});

const ARIA = [
  '- heading "Welcome back" [level=1]',
  '- textbox "Email address"',
  '- button "Log in"',
  '- text: By signing in you agree to the terms.',
  '- paragraph: Need help?',
].join('\n');

describe('design against the page', () => {
  it('reads the roles and words out of an aria snapshot', () => {
    const { elements, text: words } = pageElements(ARIA);
    assert.deepEqual(elements.slice(0, 3), [{ role: 'heading', name: 'Welcome back' }, { role: 'textbox', name: 'Email address' }, { role: 'button', name: 'Log in' }]);
    assert.match(words, /By signing in you agree to the terms\./);
  });

  it('says what matches, what was renamed, and what is not there', () => {
    const drifts = compareDesign(frameChecks(FRAME), ARIA);
    const by = (name: string) => drifts.find((d) => d.check.name === name);
    assert.equal(by('Email address')?.verdict, 'met');
    assert.equal(by('Welcome back')?.verdict, 'met');
    assert.equal(by('By signing in you agree to the terms.')?.verdict, 'met');
    const button = by('Sign in');
    assert.equal(button?.verdict, 'renamed', 'the same button with different words is drift, not a missing button');
    assert.equal(button?.found, 'button "Log in"');
    assert.equal(by('Forgot your password?')?.verdict, 'missing');
  });

  it('notices when the design drew a control and the page only has words', () => {
    const drifts = compareDesign([{ kind: 'role', role: 'button', name: 'Continue', from: 'Frame / Button' }], '- text: Continue');
    assert.equal(drifts[0].verdict, 'role');
    assert.match(drifts[0].found ?? '', /Continue/);
  });
});

describe('regions', () => {
  it('is met when the page marks the region up, and missing when it does not', () => {
    const check = { kind: 'landmark' as const, role: 'navigation', name: '', from: 'Home / Navbar' };
    const snapshot = (region: string) => [`- ${region}:`, '  - link "Pricing"'].join('\n');
    assert.equal(compareDesign([check], snapshot('navigation'))[0].verdict, 'met');
    assert.equal(compareDesign([check], snapshot('list'))[0].verdict, 'missing');
  });
});

describe('the design command', () => {
  it('reads a saved frame and lists its checks when there is no page to compare', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tewip-design-')), 'frame.json');
    writeFileSync(file, JSON.stringify({ name: 'Shop', nodes: { '1:2': { document: FRAME } } }), 'utf8');
    const lines: string[] = [];
    const log = console.log;
    console.log = (l: string) => lines.push(l);
    try {
      await runDesign({ design: file, root: process.cwd() });
    } finally {
      console.log = log;
    }
    const out = lines.join('\n');
    assert.match(out, /button "Sign in"/);
    assert.match(out, /Add --url/);
  });

  it('refuses a frame it can read nothing from rather than reporting nothing wrong', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tewip-design-')), 'empty.json');
    writeFileSync(file, JSON.stringify({ name: 'Art', document: { id: '9:9', name: 'Art', type: 'FRAME', children: [{ id: '9:10', name: 'Image', type: 'RECTANGLE' }] } }), 'utf8');
    await assert.rejects(() => runDesign({ design: file, root: process.cwd() }), /no checkable words or controls/);
  });
});
