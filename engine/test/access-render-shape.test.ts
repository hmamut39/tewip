// Written by `tewip incident` from a real stack trace, and kept because it was red for the reason
// production was.
//
// The crash: `TypeError: Cannot read properties of undefined (reading 'length')` at
// `engine/access/render.ts:129`, from a caller that passed a browser run without an `advice` list.
// `renderAccess` is exported and the MCP tool calls it too, so a missing list throwing instead of
// meaning "none" is a real gap - it was hit twice in one hour during Phase 68. This test is the
// `incident` command's own output, renamed and left in place; the only edit is this comment.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderAccess } from '../access/render.ts';

describe('renderAccess production incident regression', () => {
  it('renders a browser-only result when the run did not include advice findings', () => {
    const productionShapedResult = {
      barriers: [],
      questions: [],
      accepted: [],
      filesRead: 0,
      browser: {
        tool: 'axe',
        pages: ['https://example.test/'],
        barriers: [],
        questions: [],
        superseded: [],
        rulesRun: new Set<string>(),
      },
    } as any;

    const report = renderAccess(productionShapedResult, 'https://example.test/');

    assert.match(report, /over 1 rendered page/);
  });
});
