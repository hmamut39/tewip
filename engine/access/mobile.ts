// Accessibility barriers in a mobile screen, read from SwiftUI and Jetpack Compose source.
//
// Every accessibility tool worth having points at a rendered page. A phone app has no page to
// point at without a simulator, a device farm or a build, so in practice nobody checks the mobile
// half - and the mobile half is where the two barriers that matter most are invisible by design.
//
// A fixed text size and a missing label both look perfect on the reviewer's screen. They only
// appear when somebody turns their font size up, or turns VoiceOver on, which nobody does before
// shipping. That is exactly the shape of thing worth reading out of source: certain from the text,
// and otherwise found by the person it hurts.
//
// Narrow on purpose. Colour contrast, focus order, whether a label's words are any good, whether a
// control is reachable by switch control - none of those can be decided here, and they are listed
// as not checked rather than guessed at.
import type { Finding } from './checks.ts';

const NL = String.fromCharCode(10);

export const MOBILE = /\.(?:swift|kt)$/i;

/** Apple's minimum is 44pt, Google's is 48dp. A control smaller than that is hard to hit. */
const MIN_TAP = { swift: 44, kotlin: 48 };

/** Placeholder text that is a label in form only. */
const PLACEHOLDER = /^(?:|\s*|icon|image|picture|photo|img|button|todo|tbd|placeholder|null|none|n\/a|\.\.\.)$/i;

const lineOf = (text: string, index: number): number => text.slice(0, index).split(NL).length;
const shown = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 90);

/**
 * The call's own arguments, up to the matching bracket.
 *
 * Needed because a modifier that supplies the label sits *after* the call it labels -
 * `Image("x").accessibilityLabel("A cat")` - so a check on the call alone would accuse every
 * labelled image in the file.
 */
function callAndModifiers(text: string, from: number): string {
  let depth = 0;
  let i = text.indexOf('(', from);
  if (i === -1) return text.slice(from, from + 120);
  for (; i < text.length && i < from + 2000; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // Then the chained modifiers that follow, which is where SwiftUI puts accessibility.
  let end = i + 1;
  while (end < text.length && end < from + 4000) {
    const rest = text.slice(end);
    const chained = /^\s*\.\s*\w+\s*\(/.exec(rest);
    if (!chained) break;
    let d = 0;
    let j = end + rest.indexOf('(');
    for (; j < text.length; j += 1) {
      if (text[j] === '(') d += 1;
      else if (text[j] === ')') {
        d -= 1;
        if (d === 0) break;
      }
    }
    end = j + 1;
  }
  return text.slice(from, end);
}

/**
 * What a chained modifier is attached to.
 *
 * SwiftUI puts each modifier on its own line under the thing it modifies, so the owner is the
 * first line above that does not itself begin with a dot. Needed because `.font(.system(size:))`
 * means two different things depending on what it hangs off: a text size on a `Text`, and a glyph
 * size on an `Image`.
 */
function chainOwner(text: string, at: number): string {
  const before = text.slice(0, at).split(NL);
  for (let i = before.length - 1; i >= 0 && i > before.length - 8; i -= 1) {
    const line = before[i].trim();
    if (line === '' || line.startsWith('.')) continue;
    return line;
  }
  return '';
}

function swiftUI(file: string, text: string): Finding[] {
  const out: Finding[] = [];

  // An image with no label and nothing saying it is decoration.
  for (const m of text.matchAll(/\bImage\s*\(/g)) {
    const at = m.index ?? 0;
    const whole = callAndModifiers(text, at);
    // `Image(decorative:)` is the documented way to say this conveys nothing. So is hiding it.
    if (/\bdecorative\s*:/.test(whole) || /accessibilityHidden\s*\(\s*true\s*\)/.test(whole)) continue;
    if (/accessibilityLabel\s*\(/.test(whole) || /accessibilityElement\s*\(/.test(whole)) continue;
    // An SF Symbol carries a name VoiceOver can read; an asset name is a file name.
    const symbol = /\bImage\s*\(\s*systemName\s*:/.test(whole);
    out.push({
      rule: symbol ? 'mobile-image-label' : 'mobile-image-label',
      confidence: symbol ? 'ask-a-person' : 'barrier',
      file,
      line: lineOf(text, at),
      element: shown(whole),
      why: symbol
        ? 'an SF Symbol with no accessibilityLabel: VoiceOver falls back to the symbol name, which is a developer name, not a description'
        : 'no accessibilityLabel, and nothing marks it as decoration',
      next: symbol
        ? 'add .accessibilityLabel("…") saying what it conveys here, or .accessibilityHidden(true) if the text beside it already says it'
        : 'add .accessibilityLabel("…"), or use Image(decorative:) if it conveys nothing',
    });
  }

  // A text size that ignores the reader's font setting.
  for (const m of text.matchAll(/\.\s*font\s*\(\s*\.\s*system\s*\(\s*size\s*:\s*(\d+)/g)) {
    const at = m.index ?? 0;
    const whole = callAndModifiers(text, at);
    // `relativeTo:` opts the fixed size back into Dynamic Type, which is the documented fix.
    if (/relativeTo\s*:/.test(whole)) continue;
    // On an Image, `.font(.system(size:))` sets the size of an SF Symbol, not of any text. isowords
    // has `Image(systemName: "xmark.circle.fill").font(.system(size: 24))`, and calling that text
    // that will not grow is a confident wrong answer about a glyph.
    if (/\bImage\s*\(/.test(chainOwner(text, at))) continue;
    out.push({
      rule: 'mobile-text-not-scalable',
      confidence: 'barrier',
      file,
      line: lineOf(text, at),
      element: shown(m[0]),
      why: `a fixed ${m[1]}pt size, so this text does not grow when the reader turns their font size up`,
      next: 'use a semantic font like .font(.body), or .font(.system(size: 14, relativeTo: .body))',
    });
  }

  // A tap target declared smaller than a finger.
  for (const m of text.matchAll(/\.\s*frame\s*\(\s*width\s*:\s*(\d+)\s*,\s*height\s*:\s*(\d+)/g)) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w >= MIN_TAP.swift && h >= MIN_TAP.swift) continue;
    const at = m.index ?? 0;
    // Only when it is actually tappable: a small decorative frame is nobody's problem.
    const around = text.slice(Math.max(0, at - 400), at + 400);
    if (!/\bButton\s*\(|onTapGesture|\.\s*tapGesture|NavigationLink|\bToggle\s*\(/.test(around)) continue;
    out.push({
      rule: 'mobile-tap-target',
      confidence: 'ask-a-person',
      file,
      line: lineOf(text, at),
      element: shown(m[0]),
      why: `a tappable area declared ${w}x${h}pt, under the 44pt Apple asks for - unless padding around it makes the hit area bigger, which this cannot see`,
      next: 'give it .frame(minWidth: 44, minHeight: 44), or enough padding to reach 44pt',
    });
  }
  return out;
}

function compose(file: string, text: string): Finding[] {
  const out: Finding[] = [];

  // Compose makes contentDescription compulsory, so the failure is what gets passed to it.
  for (const m of text.matchAll(/\b(?:Image|Icon)\s*\([^)]{0,400}?contentDescription\s*=\s*(null|"([^"]*)")/g)) {
    const at = m.index ?? 0;
    const whole = m[0];
    const isNull = m[1] === 'null';
    const value = m[2] ?? '';
    // `null` is the documented way to say an image is decorative, and inside a labelled button it
    // is right. On its own it is the commonest way an icon ends up with no name at all.
    const around = text.slice(Math.max(0, at - 300), at + 300);
    const insideClickable = /\b(?:IconButton|Button|Clickable|clickable)\b/.test(around);
    if (isNull && !insideClickable) continue;
    if (!isNull && !PLACEHOLDER.test(value)) continue;
    out.push({
      rule: 'mobile-image-label',
      confidence: isNull ? 'barrier' : 'barrier',
      file,
      line: lineOf(text, at),
      element: shown(whole),
      why: isNull
        ? 'contentDescription = null inside something tappable: TalkBack announces a button with no name'
        : `contentDescription is ${value === '' ? 'empty' : `"${value}"`}, which names nothing`,
      next: 'give contentDescription the words a person needs, or keep null only when a text label beside it already says it',
    });
  }

  // dp for a text size is always wrong: dp ignores the font scale, sp honours it.
  for (const m of text.matchAll(/\bfontSize\s*=\s*(\d+)\s*\.\s*dp\b/g)) {
    const at = m.index ?? 0;
    out.push({
      rule: 'mobile-text-not-scalable',
      confidence: 'barrier',
      file,
      line: lineOf(text, at),
      element: shown(m[0]),
      why: `a text size in dp, which ignores the reader's font-size setting entirely. sp is the unit that honours it`,
      next: `use ${m[1]}.sp instead of ${m[1]}.dp`,
    });
  }

  // Something made tappable without being told it is a control.
  // `clickable\s*[({]` and not `clickable\s*\(`: Kotlin's trailing lambda means the commonest form
  // by far is `Modifier.clickable { open() }`, with a brace. Written with the paren alone this
  // matched the form almost nobody uses and stayed silent on the one everybody does.
  for (const m of text.matchAll(/\b(Box|Row|Column|Text|Surface|Spacer)\s*\(\s*[^)]{0,300}?Modifier\s*[^)]{0,300}?\.\s*clickable\s*[({]/g)) {
    const at = m.index ?? 0;
    const whole = callAndModifiers(text, at);
    // `semantics\s*[({]` for the same reason as `clickable` above, and this one was caught by
    // accusing Google's own JetNews sample of the exact thing it exists to demonstrate: its Row has
    // `.semantics { customActions = listOf(CustomAccessibilityAction(...)) }`, with a brace, and a
    // pattern wanting a paren walked straight past it. A check that reports the reference
    // implementation as a barrier is not a strict check, it is a broken one.
    if (/\bsemantics\s*[({]|\brole\s*=\s*Role\.|\bRole\.\w+|\bonClickLabel\s*=/.test(whole)) continue;
    out.push({
      rule: 'mobile-control-unnamed',
      confidence: 'ask-a-person',
      file,
      line: lineOf(text, at),
      element: shown(m[0]),
      why: `a ${m[1]} made clickable with no role and no semantics, so TalkBack does not announce it as a control`,
      next: 'pass Modifier.clickable(onClickLabel = "…", role = Role.Button), or use a Button',
    });
  }
  return out;
}

export function mobileBarriers(file: string, text: string): Finding[] {
  return /\.swift$/i.test(file) ? swiftUI(file, text) : compose(file, text);
}
