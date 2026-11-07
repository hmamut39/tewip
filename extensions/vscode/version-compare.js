// Comparing two Tewip versions. No `vscode` here on purpose: this is the part that can be tested.
//
// Split out of engine-version.js in Phase 61, because the thing that went wrong there was pure
// arithmetic on two numbers and nothing could reach it - the extension requires `vscode`, which
// only exists inside the editor, so the whole file was untestable and the whole extension untested.

/**
 * The minor version this build was written against. Only used when npm cannot be asked.
 *
 * Raised with the extension rather than on its own: the number is a claim about what this build
 * knows, and moving it without rebuilding would make the claim false. A test holds it within ten
 * minors of the shipped engine, which is what forces this to be looked at - it fired on 0.80.0
 * with the floor still at 69, and the extension had not been rebuilt since 0.76.0.
 */
const FLOOR = 80;

/** [major, minor] of a version string, or null when it does not look like one. */
function parts(version) {
  const found = /^(\d+)\.(\d+)/.exec(String(version).trim());
  return found ? [Number(found[1]), Number(found[2])] : null;
}

/**
 * Is `installed` an older release than `available`?
 *
 * Compared on major and minor only. A patch release of the engine does not change what the
 * extension can ask for, and warning about one would be a nag with nothing behind it.
 */
function isBehind(installed, available) {
  const a = parts(installed);
  const b = parts(available);
  if (!a || !b) return false;
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

module.exports = { FLOOR, parts, isBehind };
