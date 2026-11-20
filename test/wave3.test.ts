import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyze, applyEdits, auditLockfile, emitDiff, sarif } from '../src/index.js';

test('SARIF hashes ignore layout and distinguish AST and enclosing declarations', t => {
  const root = mkdtempSync(join(tmpdir(), 'patchforge-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'entry.ts');
  function scan(text: string) {
    writeFileSync(file, text);
    const findings = analyze([file]);
    assert.equal(findings.length, 1);
    return sarif(findings, root).runs[0].results[0];
  }
  const original = scan('function report() { fs.readFile(req.body); }');
  const shifted = scan('\n/** Reports a file */\nfunction report( ) {\n fs . readFile( /* label */ req . body ) ;\n}');
  assert.notEqual(original.locations[0].physicalLocation.region.startLine,
    shifted.locations[0].physicalLocation.region.startLine);
  assert.deepEqual(original.partialFingerprints, shifted.partialFingerprints);
  for (const text of ['function report() { fs.readFile(req.query); }', 'function other() { fs.readFile(req.body); }']) {
    assert.notDeepEqual(original.partialFingerprints, scan(text).partialFingerprints);
  }
});

test('unified diff applies with Git and preserves a missing final newline', t => {
  const root = mkdtempSync(join(tmpdir(), 'patchforge-diff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'sample file.ts');
  const input = 'const sample = false;\n\nexport { sample };';
  const edits = [
    { start: 0, end: 0, replacement: '// fixture\n' },
    { start: input.indexOf('false'), end: input.indexOf('false') + 5, replacement: 'true' },
    { start: input.length, end: input.length, replacement: '\n' },
  ];
  writeFileSync(file, input);
  const patch = emitDiff(file, input, edits, root);
  assert.match(patch, /^--- a\/sample file\.ts/m);
  execFileSync('git', ['apply', '-'], { cwd: root, input: patch });
  assert.equal(readFileSync(file, 'utf8'), applyEdits(input, edits));
  assert.equal(emitDiff(file, input, [], root), '');
});

test('lockfile findings point to package entries and require explicit registry trust', () => {
  const path = 'corpus/clean/lock-internal-registry/package-lock.json';
  assert.deepEqual(auditLockfile(path, { internalScopes: { '@company': ['packages.example.test'] } }), []);
  const findings = auditLockfile(path, { internalScopes: { '@company': ['another.example.test'] } });
  assert.deepEqual(findings.map(finding => finding.ruleId), ['PF203']);
  const [finding] = findings;
  assert.match(readFileSync(path, 'utf8').slice(finding.sink.start, finding.sink.end), /node_modules\/@company\/widget/);
});

test('CLI emits a diff that applies multiple repairs in the same source file', t => {
  const root = mkdtempSync(join(tmpdir(), 'patchforge-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(process.cwd(), 'src/cli.ts');
  const tsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const input = 'fs.readFile(req.body);\nfs.readFile(req.query);\n';
  const file = join(root, 'entry.ts');
  writeFileSync(file, input);
  writeFileSync(join(root, 'repair.json'), JSON.stringify({ guardsModule: './guards.js', baseDirectory: '/reports' }));
  const patch = execFileSync(process.execPath, [tsx, cli, '--emit-diff', '--repair-config', 'repair.json', 'entry.ts'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(readFileSync(file, 'utf8'), input);
  execFileSync('git', ['apply', '-'], { cwd: root, input: patch });
  const repaired = readFileSync(file, 'utf8');
  assert.match(repaired, /fs\.readFile\(__patchforge0\("\/reports", req\.body\)\)/);
  assert.match(repaired, /fs\.readFile\(__patchforge1\("\/reports", req\.query\)\)/);
});
