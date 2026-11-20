import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import ts from 'typescript';
import { analyze, applyEdits, auditInstallHooks, sarif, synthesize, verify } from '../src/index.js';

test('traces a re-exported async helper into a static-only sink and emits a minimal repair', t => {
  const root = mkdtempSync(join(tmpdir(), 'patchforge-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'helper.ts'), 'export async function select<T>(value: T) { return value; }');
  writeFileSync(join(root, 'exports.ts'), 'export { select as route } from "./helper.js";');
  const entry = join(root, 'entry.ts');
  const input = `import { route } from './exports.js';
import { readFile as read } from 'node:fs';
export async function demo(req: { body: { label: string } }) {
  const { label } = await route(req.body);
  return read(label, () => undefined);
}`;
  writeFileSync(entry, input);
  const findings = analyze([entry]);
  assert.deepEqual(findings.map(finding => finding.ruleId), ['PF002']);
  assert(findings[0].trace.some(point => point.message === 'Await promise'));
  assert(findings[0].trace.some(point => point.file.endsWith('helper.ts')));
  const report = sarif(findings, root);
  assert.equal(report.version, '2.1.0');
  const result = report.runs[0].results[0];
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'entry.ts');
  assert(result.codeFlows[0].threadFlows[0].locations.length > 3);
  const edits = synthesize(input, findings[0], { baseDirectory: '/reports', guardsModule: './guards.js' });
  assert.equal(edits.length, 2);
  const repaired = applyEdits(input, edits);
  assert.match(repaired, /read\(__patchforge0\("\/reports", label\), \(\) => undefined\)/);
  assert.equal(readFileSync(entry, 'utf8'), input);
});

test('audits referenced lifecycle files statically', () => {
  const findings = auditInstallHooks('corpus/positive/hook-environment/package.json');
  assert.deepEqual(findings.map(finding => finding.ruleId), ['PF103']);
  assert(findings[0].sink.file.endsWith('fixture.js'));
});

const file = 'in-memory.ts';
const original = 'export const ready = false;';

test('refuses a passing baseline before proposing edits', () => {
  const verdict = verify({
    files: { [file]: original }, target: file,
    baseline: () => 'pass',
    benign: () => assert.fail('Unexpected benign check'),
    propose: () => assert.fail('Unexpected edit generation'),
    regressions: [], blocks: () => false, samples: fc.integer(), observe: () => 0,
  });
  assert.deepEqual(verdict, { status: 'REFUSED_NON_REPRODUCING_CASE', stage: 1 });
});

test('verifies a benign contract and rejects property differences', () => {
  const input = {
    files: { [file]: original }, target: file,
    baseline: (workspace: Readonly<Record<string, string>>) => workspace[file].includes('true') ? 'pass' as const : 'fail' as const,
    benign: () => true,
    propose: () => [{ start: original.indexOf('false'), end: original.indexOf('false') + 5, replacement: 'true' }],
    regressions: [-1, 0], blocks: () => true, samples: fc.integer(),
    compilerOptions: { types: [], skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  };
  assert.equal(verify({ ...input, observe: (_, sample) => sample }).status, 'VERIFIED');
  const different = verify({ ...input, observe: (workspace, sample) => workspace[file] === original ? sample : sample + 1 });
  assert.equal(different.status, 'FAILED');
  assert.equal(different.stage, 6);
});
