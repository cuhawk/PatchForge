import fc, { type Arbitrary } from 'fast-check';
import ts from 'typescript';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { applyEdits, type Edit } from '../patcher/index.js';

type Workspace = Readonly<Record<string, string>>;

export interface Verification<Input> {
  files: Workspace;
  target: string;
  baseline(workspace: Workspace): 'pass' | 'fail';
  benign(workspace: Workspace): boolean;
  propose(workspace: Workspace): readonly Edit[];
  regressions: readonly Input[];
  blocks(workspace: Workspace, input: Input): boolean;
  samples: Arbitrary<Input>;
  observe(workspace: Workspace, input: Input): unknown;
  compilerOptions?: ts.CompilerOptions;
}

export type Verdict =
  | { status: 'REFUSED_NON_REPRODUCING_CASE'; stage: 1 }
  | { status: 'FAILED'; stage: number; message: string }
  | { status: 'VERIFIED'; stage: 6; edits: readonly Edit[] };

function compile(files: Workspace, options: ts.CompilerOptions = {}) {
  const settings = { ...options, noEmit: true };
  const inputs = new Map(Object.entries(files).map(([path, source]) => [resolve(path), source]));
  const host = ts.createCompilerHost(settings);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  host.readFile = file => inputs.get(resolve(file)) ?? read(file);
  host.fileExists = file => inputs.has(resolve(file)) || exists(file);
  host.directoryExists = dir => [...inputs.keys()].some(file => file.startsWith(resolve(dir) + '/')) ||
    Boolean(directoryExists?.(dir));
  const originalSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, fresh) => {
    const text = inputs.get(resolve(file));
    return text === undefined ? originalSource(file, languageVersion, onError, fresh) :
      ts.createSourceFile(file, text, languageVersion, true);
  };
  return ts.getPreEmitDiagnostics(ts.createProgram([...inputs.keys()], settings, host));
}

/** Callbacks run as trusted code. Workspace source is only type-checked by this harness. */
export function verify<Input>(test: Verification<Input>): Verdict {
  const original = Object.freeze({ ...test.files });
  let stage = 1;
  const fail = (message: string): Verdict => ({ status: 'FAILED', stage, message });
  try {
    const baseline = test.baseline(original);
    if (baseline === 'pass') return { status: 'REFUSED_NON_REPRODUCING_CASE', stage: 1 };
    if (baseline !== 'fail') return fail('Baseline did not return a valid outcome');
    stage = 2;
    if (!test.benign(original)) return fail('Baseline benign checks failed');
    stage = 3;
    if (!Object.hasOwn(original, test.target)) return fail('Repair target is missing');
    const edits = test.propose(original);
    if (!edits.length) return fail('No applicable repair');
    const repaired = Object.freeze({ ...original, [test.target]: applyEdits(original[test.target], edits) });
    const diagnostics = compile(repaired, test.compilerOptions);
    if (diagnostics.length) return fail(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'));
    stage = 4;
    if (test.baseline(repaired) !== 'pass') return fail('Repair did not satisfy the regression contract');
    stage = 5;
    if (!test.regressions.length || !test.regressions.every(input => test.blocks(repaired, input))) {
      return fail('Regression input checks failed');
    }
    stage = 6;
    if (!test.benign(repaired)) return fail('Repaired benign checks failed');
    fc.assert(fc.property(test.samples, input =>
      isDeepStrictEqual(test.observe(original, structuredClone(input)), test.observe(repaired, structuredClone(input)))), { seed: 42, numRuns: 100 });
    return { status: 'VERIFIED', stage: 6, edits };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
