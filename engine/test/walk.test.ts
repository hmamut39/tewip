// Phase 138: the walker followed symlinks, and only Linux ever said so.
//
// `scanSourceFiles` used `stat`, which follows a symlink, so a link to a directory looked like a
// directory and was walked. immich has one: `fastlane/metadata` points at
// `../mobile/android/fastlane/metadata`, inside the same repository. Following it read 77 files a
// second time under a path they do not have, so `secrets` reported 3,218 files read where there are
// 3,141, and a finding in one of them would have been reported twice at two different paths.
//
// It hid because the numbers were recorded on Windows, where git writes a symlink as a small text
// file - the right answer by accident. The corpus runs on Linux, and the moment a tag made it run,
// it disagreed. Two platforms disagreeing about a verified number is the corpus working.
//
// The double count is the visible half. The half that matters is that a link pointing out of the
// project would have Tewip reading files outside the directory it was handed, which it must not do
// whatever is on the other end.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scanSourceFiles } from '../walk.ts';

const NL = String.fromCharCode(10);

/** A symlink, or `null` when this machine will not make one (Windows without the privilege). */
function linked(at: string, to: string, type: 'dir' | 'file'): boolean {
  try {
    symlinkSync(to, at, type === 'dir' ? 'junction' : 'file');
    return true;
  } catch {
    return false;
  }
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-walk-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), `export const a = 1;${NL}`, 'utf8');
  writeFileSync(join(root, 'src', 'b.ts'), `export const b = 2;${NL}`, 'utf8');
  return root;
}

describe('the file walker', () => {
  it('reads each real file once', () => {
    assert.equal(scanSourceFiles(project()).total, 2);
  });

  it('does not read a file twice through a symlink to a directory inside the project', () => {
    // immich's case exactly: the link and its target are both inside the repository, so following
    // it does not escape anywhere - it just counts the same two files again under a second path.
    const root = project();
    if (!linked(join(root, 'mirror'), join(root, 'src'), 'dir')) return; // no symlink privilege here
    const scan = scanSourceFiles(root);
    assert.equal(scan.total, 2, 'the two files in src/, and not a third and fourth through mirror/');
    assert.ok(
      !scan.files.some((f) => f.includes('mirror')),
      'no file is reported under a path it does not really have',
    );
  });

  it('does not read outside the project through a symlink', () => {
    // The half that matters. Whatever is on the other end, Tewip reads the directory it was given.
    const root = project();
    const elsewhere = mkdtempSync(join(tmpdir(), 'tewip-outside-'));
    writeFileSync(join(elsewhere, 'secrets.ts'), `export const token = 'x';${NL}`, 'utf8');
    if (!linked(join(root, 'escape'), elsewhere, 'dir')) return;
    const scan = scanSourceFiles(root);
    assert.equal(scan.total, 2);
    assert.ok(!scan.files.some((f) => f.includes('secrets.ts')), 'a link out of the project is not followed');
  });

  it('still finds a real file that happens to sit beside a symlink', () => {
    // The fix must not cost a file: skipping links is not skipping the directory they live in.
    //
    // The link half of this runs only where a *file* link can be made. On Windows that needs a
    // privilege this machine does not have (EPERM), while a directory junction - which is what the
    // two tests above use, and what actually reproduced the bug - needs none. Saying so beats an
    // assertion that passes because the thing it describes was never created.
    const root = project();
    const madeLink = linked(join(root, 'src', 'link.ts'), join(root, 'src', 'a.ts'), 'file');
    writeFileSync(join(root, 'src', 'c.ts'), `export const c = 3;${NL}`, 'utf8');
    const scan = scanSourceFiles(root);
    assert.ok(
      scan.files.some((f) => f.endsWith('c.ts')),
      'c.ts is read',
    );
    if (madeLink) assert.ok(!scan.files.some((f) => f.endsWith('link.ts')), 'and the link beside it is not');
  });
});
