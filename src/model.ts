import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface Site {
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
}

export interface Finding {
  ruleId: string;
  sink: Site;
  trace: Site[];
  confidence: number;
}

export function site(node: ts.Node, message: string): Site {
  const file = node.getSourceFile();
  const start = node.getStart(file);
  const end = node.getEnd();
  const a = file.getLineAndCharacterOfPosition(start);
  const b = file.getLineAndCharacterOfPosition(end);
  return { file: file.fileName, start, end, line: a.line + 1, column: a.character + 1,
    endLine: b.line + 1, endColumn: b.character + 1, message };
}

export function readRules<T>(name: string): T {
  const rules = parse(readFileSync(new URL('../rules/' + name, import.meta.url), 'utf8'));
  if (rules?.version !== 1) throw new Error('Unsupported rule version: ' + name);
  return rules as T;
}
