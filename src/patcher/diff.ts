import { structuredPatch, formatPatch } from 'diff';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { applyEdits, type Edit } from './index.js';

export function emitDiff(file: string, input: string, edits: readonly Edit[], root = process.cwd()): string {
  const output = applyEdits(input, edits);
  if (output === input) return '';
  const path = relative(root, resolve(file)).split(sep).join('/');
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('../') || /[\r\n\t]/.test(path)) {
    throw new Error('Diff requires a file within the working directory with no line breaks or tabs in its path');
  }
  const patch = structuredPatch('a/' + path, 'b/' + path, input, output);
  return formatPatch(patch, { includeFileHeaders: true, includeIndex: false, includeUnderline: false });
}
