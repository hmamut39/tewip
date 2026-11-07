// Phase 143: the accessibility of a phone screen, read from SwiftUI and Compose source.
//
// Every accessibility tool worth having points at a rendered page, and a phone app has no page to
// point at without a simulator or a device farm. So in practice nobody checks the mobile half -
// and the mobile half is where the two barriers that matter most are invisible by design. A fixed
// text size and a missing label both look perfect on the reviewer's screen; they appear only when
// somebody turns their font size up or turns VoiceOver on.
//
// The two most important tests here are the two that say *nothing*. Both came from running this
// against real apps and finding it wrong:
//
//   - isowords has `Image(systemName: "xmark.circle.fill").font(.system(size: 24))`, where `.font`
//     sets the size of a glyph and not of any text. Calling that unscalable text is a confident
//     wrong answer about something that is not text at all.
//   - Google's JetNews has a `Row` with `.semantics { customActions = ... }`, which is the correct
//     handling and the reason the sample exists. A pattern wanting `semantics(` walked past the
//     trailing-lambda form everybody actually writes, and accused the reference implementation of
//     the barrier it demonstrates fixing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mobileBarriers } from '../access/mobile.ts';

const NL = String.fromCharCode(10);
const swift = (...lines: string[]) => mobileBarriers('V.swift', lines.join(NL));
const kotlin = (...lines: string[]) => mobileBarriers('V.kt', lines.join(NL));
const rules = (found: ReturnType<typeof mobileBarriers>) => found.map((f) => f.rule).sort();

describe('SwiftUI', () => {
  it('names an image with no label and nothing calling it decoration', () => {
    const found = swift('Image("logo")');
    assert.deepEqual(rules(found), ['mobile-image-label']);
    assert.equal(found[0].confidence, 'barrier');
  });

  it('accepts the two ways of saying an image needs no name', () => {
    assert.deepEqual(swift('Image(decorative: "divider")'), []);
    assert.deepEqual(swift('Image("x").accessibilityHidden(true)'), []);
  });

  it('accepts a label written after the call, which is where SwiftUI puts it', () => {
    // Written across lines with other modifiers in between, which is how isowords and every real
    // SwiftUI file is written. The one-line form passed even with the modifier scan truncated to
    // forty characters, so it was guarding nothing: the label happened to still be inside the slice.
    assert.deepEqual(
      swift(
        'Image(uiImage: avatar)',
        '  .resizable()',
        '  .scaledToFill()',
        '  .clipShape(Circle())',
        '  .accessibilityLabel("Your profile picture")',
      ),
      [],
    );
  });

  it('leaves an SF Symbol to a person rather than calling it a barrier', () => {
    // VoiceOver reads the symbol name, which is a developer name and usually not a description -
    // but sometimes it is good enough, and that is a judgement.
    const found = swift('Image(systemName: "trash")');
    assert.equal(found[0].confidence, 'ask-a-person');
  });

  it('names a text size that ignores the reader’s font setting', () => {
    const found = swift('Text("Total")', '  .font(.system(size: 13))');
    assert.deepEqual(rules(found), ['mobile-text-not-scalable']);
    assert.match(found[0].next, /relativeTo/);
  });

  it('accepts relativeTo, which opts the fixed size back in', () => {
    assert.deepEqual(swift('Text("Sub")', '  .font(.system(size: 13, relativeTo: .body))'), []);
  });

  it('does not call the size of a glyph a text size', () => {
    // isowords, exactly. On an Image this sets the symbol size; there is no text here to resize.
    const found = swift('Image(systemName: "xmark.circle.fill")', '  .font(.system(size: 24))');
    assert.deepEqual(rules(found).filter((r) => r === 'mobile-text-not-scalable'), []);
  });

  it('asks about a tap target smaller than a finger, and only when it is tappable', () => {
    const tappable = swift('Button(action: remove) { Image(systemName: "xmark") }', '  .frame(width: 24, height: 24)');
    assert.ok(rules(tappable).includes('mobile-tap-target'));
    assert.equal(tappable.find((f) => f.rule === 'mobile-tap-target')?.confidence, 'ask-a-person', 'padding can make the hit area bigger, and this cannot see that');
    const decoration = swift('Rectangle().frame(width: 24, height: 24)');
    assert.deepEqual(rules(decoration), []);
  });
});

describe('Jetpack Compose', () => {
  it('names a null contentDescription on something tappable', () => {
    const found = kotlin('IconButton(onClick = { remove() }) { Icon(Icons.Default.Delete, contentDescription = null) }');
    assert.deepEqual(rules(found), ['mobile-image-label']);
    assert.match(found[0].why, /announces a button with no name/);
  });

  it('accepts null outside a control, which is how Compose spells decorative', () => {
    assert.deepEqual(kotlin('Image(painter = p, contentDescription = null)'), []);
  });

  it('names a description that names nothing', () => {
    assert.deepEqual(rules(kotlin('Image(painter = p, contentDescription = "image")')), ['mobile-image-label']);
    assert.deepEqual(rules(kotlin('Image(painter = p, contentDescription = "")')), ['mobile-image-label']);
    assert.deepEqual(kotlin('Icon(Icons.Default.Star, contentDescription = "Rated five stars")'), []);
  });

  it('names a text size in dp, which ignores the font scale entirely', () => {
    const found = kotlin('Text("Total", fontSize = 14.dp)');
    assert.deepEqual(rules(found), ['mobile-text-not-scalable']);
    assert.match(found[0].next, /14\.sp/);
    assert.deepEqual(kotlin('Text("Sub", fontSize = 14.sp)'), []);
  });

  it('asks about something made clickable with no role', () => {
    // The trailing lambda, which is the form almost everybody writes.
    const found = kotlin('Box(modifier = Modifier.clickable { open() }) { Text("Open") }');
    assert.deepEqual(rules(found), ['mobile-control-unnamed']);
    assert.equal(found[0].confidence, 'ask-a-person');
  });

  it('accepts semantics written as a trailing lambda', () => {
    // Google's JetNews, and the finding that proved this check wrong before it shipped.
    assert.deepEqual(
      kotlin(
        'Row(',
        '  modifier = Modifier',
        '    .clickable(onClick = { open() })',
        '    .semantics { customActions = listOf(CustomAccessibilityAction("Bookmark", { true })) },',
        ') { Text("x") }',
      ),
      [],
    );
  });

  it('accepts a role and an onClickLabel', () => {
    assert.deepEqual(kotlin('Box(modifier = Modifier.clickable(onClickLabel = "Open", role = Role.Button) { open() })'), []);
  });
});
