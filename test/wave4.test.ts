import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyze, applyEdits, synthesize } from '../src/index.js';

test('async tuple and event traces cross module boundaries', () => {
  const [tuple] = analyze(['corpus/variant/async-all-index/main.ts']);
  assert.equal(tuple.ruleId, 'PF002');
  assert(tuple.trace.some(point => point.file.endsWith('helper.ts') && point.message === 'Resolve Promise.all element'));
  assert(tuple.trace.some(point => point.message === 'Await promise'));
  const [event] = analyze(['corpus/variant/events-imported-listener/main.ts']);
  assert.equal(event.ruleId, 'PF002');
  assert(event.sink.file.endsWith('helper.ts'));
  assert(event.trace.some(point => point.file.endsWith('main.ts') && point.message === 'Emit label'));
});

test('Server Action CLI diff keeps the directive and fetch options and leaves inputs untouched', t => {
  const root = mkdtempSync(join(tmpdir(), 'patchforge-action-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync('corpus/positive/actions-async-url', root, { recursive: true });
  cpSync('src/patcher/guards.ts', join(root, 'guards.ts'));
  const input = readFileSync(join(root, 'main.ts'), 'utf8');
  const config = { guardsModule: './guards.js', allowedHosts: ['1.1.1.1'] };
  writeFileSync(join(root, 'repair.json'), JSON.stringify(config));
  const cli = join(process.cwd(), 'src/cli.ts');
  const tsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const patch = execFileSync(process.execPath, [tsx, cli, '--emit-diff', '--repair-config', 'repair.json', 'main.ts'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(readFileSync(join(root, 'main.ts'), 'utf8'), input);
  execFileSync('git', ['apply', '-'], { cwd: root, input: patch });
  const repaired = readFileSync(join(root, 'main.ts'), 'utf8');
  assert.match(repaired, /^'use server';\nimport/);
  assert.match(repaired, /typeof url !== "string"/);
  assert.match(repaired, /fetch\(__patchforge0\(target, \["1\.1\.1\.1"\]\), \{ \.\.\.\{ method: 'HEAD' \}, redirect: "error" \}\)/);
  assert.deepEqual(analyze([join(root, 'main.ts')]), []);
});

test('FormData template preserves an inline Server Action directive', () => {
  const path = 'corpus/variant/actions-inline-form/main.ts';
  const source = readFileSync(path, 'utf8');
  const [finding] = analyze([path]);
  assert.equal(finding.ruleId, 'PF007');
  const result = applyEdits(source, synthesize(source, finding, { guardsModule: './guards.js' }));
  assert.match(result, /'use server';\s+if \(!\(data instanceof globalThis\.FormData\)\)/);
});
