// The .NET report formats: Visual Studio's own TRX, and NUnit 3's XML.
//
// Both say the same things as a JUnit report in different words, so they are read into the same `Case`
// shape and the rest of the pipeline never learns the difference. Split out of junit.ts to keep that
// file inside this project's 300-line rule; nothing else changed.
import { PASSED, failure, type Case } from './case.ts';
import { descendants, type XmlElement } from './xml.ts';

/** "00:00:01.2340000" -> 1234 ms. */
const trxDuration = (d: string | undefined) => {
  const m = d?.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  return m ? Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) : 0;
};

/** .NET's native TRX report (dotnet test --logger trx). */
export function trxCases(root: XmlElement): Case[] {
  const methods = new Map<string, { className: string; name: string }>();
  for (const unit of descendants(root, 'UnitTest')) {
    const method = unit.children.find((c) => c.name === 'TestMethod');
    if (unit.attrs.id && method) methods.set(unit.attrs.id, { className: method.attrs.className ?? '', name: method.attrs.name ?? '' });
  }
  return descendants(root, 'UnitTestResult')
    .filter((r) => r.attrs.outcome !== 'NotExecuted')
    .map((r) => {
      const method = methods.get(r.attrs.testId ?? '');
      const testId = method?.className ? `${method.className} > ${method.name}` : (r.attrs.testName ?? '').trim();
      const info = descendants(r, 'ErrorInfo')[0];
      const text = (name: string) => info?.children.find((c) => c.name === name)?.text ?? '';
      const failed = r.attrs.outcome === 'Failed' || r.attrs.outcome === 'Error' || r.attrs.outcome === 'Timeout';
      return {
        testId,
        file: method?.className ?? testId,
        duration: trxDuration(r.attrs.duration),
        attempts: [failed ? failure(text('Message'), text('StackTrace')) : PASSED],
      };
    });
}

/**
 * NUnit 3's own result file (`nunit3-console --result=x.xml`), whose root is <test-run>. NUnit does
 * not write JUnit XML at all - its console offers only the nunit3 and nunit2 formats - so a .NET
 * team on NUnit has nothing else to hand Tewip.
 */
export function nunitCases(root: XmlElement): Case[] {
  return descendants(root, 'test-case')
    .filter((t) => t.attrs.result !== 'Skipped' && t.attrs.result !== 'Inconclusive')
    .map((t) => {
      const failureEl = t.children.find((c) => c.name === 'failure');
      const child = (parent: XmlElement | undefined, name: string) => parent?.children.find((c) => c.name === name)?.text ?? '';
      const testId = (t.attrs.fullname ?? '').trim() || [t.attrs.classname, t.attrs.methodname ?? t.attrs.name].filter(Boolean).join(' > ');
      const seconds = Number(t.attrs.duration);
      return {
        testId,
        file: (t.attrs.classname ?? '').trim(),
        duration: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
        attempts: [t.attrs.result === 'Failed' ? failure(child(failureEl, 'message'), child(failureEl, 'stack-trace')) : PASSED],
      };
    });
}

// .jtl is JMeter's, and a k6 summary is JSON; both are read below.
