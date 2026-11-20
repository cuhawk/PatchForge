import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import { analyze, auditInstallHooks, verify } from '../src/index.js';

interface Case {
  group: 'positive' | 'variant' | 'clean';
  path: string;
  expected: string[];
  audit: boolean;
}

const cases = JSON.parse(readFileSync('corpus/manifest.json', 'utf8')) as Case[];
let tp = 0;
let fp = 0;
let fn = 0;
let cleanFp = 0;
let variants = 0;
let caught = 0;
const timings: number[] = [];

for (const fixture of cases) {
  const manifest = join(dirname(fixture.path), 'package.json');
  const start = performance.now();
  const findings = fixture.audit ? auditInstallHooks(manifest) : analyze([fixture.path]);
  const elapsed = performance.now() - start;
  const files = readdirSync(dirname(fixture.path)).filter(file =>
    statSync(join(dirname(fixture.path), file)).isFile());
  timings.push(elapsed / files.length);
  const remaining = [...fixture.expected];
  for (const { ruleId } of findings) {
    const index = remaining.indexOf(ruleId);
    if (index >= 0) {
      remaining.splice(index, 1);
      tp++;
    } else {
      fp++;
      if (fixture.group === 'clean') cleanFp++;
    }
  }
  fn += remaining.length;
  if (fixture.group === 'variant') {
    variants++;
    if (!remaining.length) caught++;
  }
}

const invalid = readdirSync('corpus/invalid-baseline').filter(file => file.endsWith('.ts'));
const refusals = invalid.filter(file => {
  const path = join('corpus/invalid-baseline', file);
  const verdict = verify({
    files: { [path]: readFileSync(path, 'utf8') }, target: path,
    baseline: workspace => analyze([path], { noLib: true }).length === 0 && workspace[path].includes('status') ? 'pass' : 'fail',
    benign: () => { throw new Error('Benign checks must not run for a refused case'); },
    propose: () => { throw new Error('Repair must not be generated for a refused case'); },
    regressions: [], blocks: () => false, samples: fc.string(), observe: () => undefined,
  });
  return verdict.status === 'REFUSED_NON_REPRODUCING_CASE';
}).length;

const sorted = timings.sort((a, b) => a - b);
const middle = Math.floor(sorted.length / 2);
const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
const percent = (numerator: number, denominator: number) => (100 * numerator / denominator).toFixed(2) + '%';

console.log(`| Metric | Observed |
| --- | ---: |
| Precision | ${percent(tp, tp + fp)} |
| Recall | ${percent(tp, tp + fn)} |
| FPs on clean corpus | ${cleanFp} |
| Variant catch rate | ${percent(caught, variants)} |
| Invalid-baseline refusals | ${refusals}/${invalid.length} |
| Median ms/file | ${median.toFixed(2)} |`);

if (cleanFp || refusals !== invalid.length) process.exitCode = 1;
