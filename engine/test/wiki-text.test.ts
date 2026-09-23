// Reading a ticket from Jira Server or Data Center, which is what most companies run and what the
// public Apache and Jenkins trackers use. Every shape below is copied from a real ticket in a
// corpus of 150 of them; before this code, 75 of those 150 descriptions came out full of markup
// and only 11 of 61 acceptance-criteria sections were found.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criteriaSection, wikiToText } from '../work/wiki-text.ts';
import { readIssue } from '../work/jira.ts';

const NL = String.fromCharCode(10);
const lines = (...l: string[]) => l.join(NL);

describe('reading wiki markup', () => {
  it('keeps the words and drops the markup', () => {
    const markup = lines(
      'h2. Problem',
      'The sink *fails fast* by default, see [FLINK-40277|https://issues.apache.org/jira/browse/FLINK-40277].',
      'Reported by [~someone] in {{HttpSinkConfigFactory}}.',
      '{code:java}',
      'builder.setProperty("retry", "3");',
      '{code}',
    );
    const text = wikiToText(markup);
    assert.match(text, /## Problem/);
    assert.match(text, /The sink fails fast by default/);
    assert.match(text, /FLINK-40277 \(https/);
    assert.match(text, /@someone in HttpSinkConfigFactory/);
    assert.match(text, /builder\.setProperty\("retry", "3"\);/);
    assert.ok(!/\{code|h2\.|\[~/.test(text), 'no markup is left for a reader to trip over');
  });

  it('keeps a heading a heading, even though a numbered list also starts with #', () => {
    const text = wikiToText(lines('h3. Acceptance criteria', '# First thing', '# Second thing'));
    assert.match(text, /^### Acceptance criteria$/m, 'this was turned into a bullet before');
    assert.match(text, /^- First thing$/m);
  });

  it('reads tables and quotes as lines of words', () => {
    const text = wikiToText(lines('||Option||Default||', '|retry|3|', '{quote}', 'It should not kill the job.', '{quote}'));
    assert.match(text, /Option \| Default/);
    assert.match(text, /retry \| 3/);
    assert.match(text, /It should not kill the job\./);
  });
});

describe('finding the acceptance criteria a person wrote', () => {
  const ticket = (heading: string) => wikiToText(lines('h2. Background', 'Some context about the change.', heading, '# The API accepts the new option', '# The old option still works', 'h2. Out of scope', 'Ranking changes'));

  it('finds them under every heading real tickets use', () => {
    for (const heading of ['h2. Acceptance Criteria', 'h3. Acceptance criteria', 'h1. +*Acceptance criteria*+', 'h3. Suggested acceptance criteria', 'h2. Definition of Done']) {
      const found = criteriaSection(ticket(heading));
      assert.match(found, /The API accepts the new option/, `not found under "${heading}"`);
      assert.ok(!found.includes('Ranking changes'), 'the next section is not part of the criteria');
      assert.ok(!found.includes('Some context'), 'what came before is not part of the criteria');
    }
  });

  it('says nothing when the author wrote no criteria', () => {
    assert.equal(criteriaSection(wikiToText(lines('h2. Background', 'Just a description.'))), '');
    assert.equal(criteriaSection(wikiToText(lines('h2. Acceptance criteria', 'TBD'))), '', 'a heading with nothing under it is not criteria');
  });
});

describe('a whole ticket, from either kind of Jira', () => {
  it('reads Server and Data Center, where the description is one string of markup', () => {
    const issue = readIssue({
      key: 'FLINK-1',
      fields: {
        summary: 'Add typed configuration',
        description: lines('h2. Problem', 'String keys are easy to miss.', 'h2. Acceptance criteria', '# Typed options exist', '# Old keys still work'),
        issuetype: { name: 'Improvement' },
        status: { name: 'Open' },
        labels: ['pull-request-available'],
      },
    });
    assert.equal(issue.summary, 'Add typed configuration');
    assert.match(issue.description, /String keys are easy to miss\./);
    assert.match(issue.acceptanceCriteria, /Typed options exist/);
    assert.deepEqual(issue.labels, ['pull-request-available']);
  });

  it('still reads Cloud, where the description is a document tree', () => {
    const issue = readIssue({
      key: 'PROJ-2',
      fields: {
        summary: 'Search the library',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A reader searches the library.' }] }] },
        issuetype: { name: 'Story' },
        status: { name: 'To Do' },
      },
    });
    assert.match(issue.description, /A reader searches the library\./);
  });
});
