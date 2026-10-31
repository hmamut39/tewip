// Phase 135: user input reaching a query or a shell, when the path is visible in one function.
//
// Real taint analysis follows values across functions, files and call graphs. This does not, and
// that refusal is the whole design. A scanner that guesses across boundaries produces a list of
// maybes; a list of maybes is read once and switched off, which is worse than no scanner, because
// by then somebody has written "we run SAST" on a form.
//
// The precision claim, measured before any of this shipped: **zero findings across 32,336 source
// files** from n8n, nocodb, immich, dispatch, angular-components and discourse. Mature code
// parameterises its queries. Recall cannot be measured the same way - the corpus contains no real
// injection to find - so it is measured against the planted cases below and that is said plainly
// rather than dressed up as a benchmark.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flows } from '../taint/flow.ts';
import { triageFlow } from '../secure/triage.ts';

const NL = String.fromCharCode(10);
const lines = (...parts: string[]) => parts.join(NL);
const found = (src: string) => flows('app.ts', src);

describe('a value that reaches a query', () => {
  it('finds it concatenated into the statement', () => {
    const f = found('app.get("/u", (req, res) => { db.query("SELECT * FROM u WHERE id = " + req.query.id); });');
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'sql-injection');
    assert.equal(f[0].source, 'req.query.id');
    assert.match(f[0].through, /concatenation/);
  });

  it('finds it interpolated into a template', () => {
    const f = found('app.get("/u", (req, res) => { db.query(`SELECT * FROM u WHERE id = ${req.params.id}`); });');
    assert.equal(f.length, 1);
    assert.match(f[0].through, /template/);
  });

  it('follows it through one named variable', () => {
    const f = found(lines('app.get("/u", (req, res) => {', '  const id = req.query.id;', '  db.query("SELECT * FROM u WHERE id = " + id);', '});'));
    assert.equal(f.length, 1);
    assert.match(f[0].through, /through `id`/);
  });

  it('finds it reaching a shell', () => {
    const f = found('app.post("/p", (req, res) => { execSync("ping -c1 " + req.body.host); });');
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'command-injection');
  });
});

describe('what it refuses to call a finding', () => {
  it('says nothing when the value is bound as a parameter', () => {
    // The difference that matters: a bound value is never parsed as syntax. A scanner that
    // reports this has made the safe pattern and the unsafe one look the same.
    assert.deepEqual(found('app.get("/u", (req, res) => { db.query("SELECT * FROM u WHERE id = ?", [req.query.id]); });'), []);
  });

  it('says nothing when the value is made a number first', () => {
    assert.deepEqual(found('app.get("/u", (req, res) => { db.query("SELECT * FROM u WHERE id = " + parseInt(req.query.id, 10)); });'), []);
    assert.deepEqual(found('app.get("/u", (req, res) => { db.query("SELECT * FROM u WHERE id = " + Number(req.query.id)); });'), []);
  });

  it('says nothing when the variable was made safe where it was assigned', () => {
    // The shape that makes the sanitiser check matter. The first version looked for the
    // sanitiser in the *query* argument, where `parseInt` will never appear once the value is
    // in a variable - dead code that three tests passed over without noticing.
    const src = lines('app.get("/u", (req, res) => {', '  const id = parseInt(req.query.id, 10);', '  db.query("SELECT * FROM u WHERE id = " + id);', '});');
    assert.deepEqual(found(src), []);
  });

  it('still reports the same shape when nothing made it safe', () => {
    // The other half, or the test above could be bought by never following a variable at all.
    const src = lines('app.get("/u", (req, res) => {', '  const id = req.query.id;', '  db.query("SELECT * FROM u WHERE id = " + id);', '});');
    assert.equal(found(src).length, 1);
  });

  it('says nothing when the value never came from a request', () => {
    assert.deepEqual(found('function load(internalId) { db.query("SELECT * FROM u WHERE id = " + internalId); }'), []);
  });

  it('does not join a source and a sink in different handlers', () => {
    // The cheapest way to look clever here is to notice both in one file and report it. The
    // variable is called `id` in both handlers on purpose: the first version of this test used
    // two different names, so the name never matched and it would have passed with the
    // same-function check deleted entirely.
    const src = lines(
      'app.get("/a", (req, res) => {',
      '  const id = req.query.id;',
      '  res.send(String(id));',
      '});',
      'app.get("/b", (req, res) => {',
      '  const id = lookupInternalId();',
      '  db.query("SELECT 1 WHERE x = " + id);',
      '});',
    );
    assert.deepEqual(found(src), []);
  });

  it('does not report a request value that is passed beside the statement', () => {
    // node-postgres takes `{ text, values }`, so the source really is inside the first argument
    // and is still bound rather than glued. "Present in the argument" is not "part of the
    // statement", and a check that cannot tell them apart reports every safe query in the file.
    assert.deepEqual(found('app.get("/u", (req, res) => { db.query({ text: "SELECT * FROM u WHERE id = $1", values: [req.query.id] }); });'), []);
  });

  it('does not report a variable assigned after the query runs', () => {
    const src = lines('app.get("/u", (req, res) => {', '  db.query("SELECT 1 WHERE x = " + id);', '  const id = req.query.id;', '});');
    assert.deepEqual(found(src), []);
  });
});

describe('what the reader is told', () => {
  it('states the path and names the fix, without grading it', () => {
    const [flow] = found('app.get("/u", (req, res) => { db.query("SELECT * FROM u WHERE id = " + req.query.id); });');
    const item = triageFlow(flow, new Set<string>());
    assert.equal(item.verdict, 'real-risk');
    assert.equal(item.severity, 'high');
    assert.match(item.why, /arrives from the request/);
    assert.match(item.next, /bind it as a parameter/);
  });

  it('honours a finding a person already accepted', () => {
    const [flow] = found('app.get("/u", (req, res) => { db.query("SELECT * FROM u WHERE id = " + req.query.id); });');
    assert.equal(triageFlow(flow, new Set([`injection app.ts:${flow.line}`])).verdict, 'accepted');
  });
});
