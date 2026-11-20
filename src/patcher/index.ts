import ts from 'typescript';
import type { Finding } from '../model.js';

export interface RepairOptions {
  guardsModule: string;
  baseDirectory?: string;
  allowedHosts?: readonly string[];
}

export interface Edit {
  start: number;
  end: number;
  replacement: string;
}

export function applyEdits(input: string, edits: readonly Edit[]): string {
  let result = input;
  let boundary = input.length;
  for (const { start, end, replacement } of [...edits].sort((a, b) => b.start - a.start)) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > boundary) {
      throw new Error('Invalid or overlapping edit');
    }
    result = result.slice(0, start) + replacement + result.slice(end);
    boundary = start;
  }
  return result;
}

export function synthesize(input: string, finding: Finding, options: RepairOptions): Edit[] {
  const source = ts.createSourceFile(finding.sink.file, input, ts.ScriptTarget.Latest, true);
  const identifiers = new Set<string>();
  let target: ts.Node | undefined;
  function scan(node: ts.Node) {
    if (node.getStart(source) === finding.sink.start && node.end === finding.sink.end) target = node;
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, scan);
  }
  scan(source);
  if (!target) return [];
  const f = ts.factory;
  const printer = ts.createPrinter();
  let helper: string;
  let module: string;
  let make: (alias: ts.Identifier) => ts.Expression;
  if (finding.ruleId === 'PF005' && ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(target.left)) {
    const args = [target.left.expression, target.left.argumentExpression, target.right];
    helper = 'safeWrite';
    module = options.guardsModule;
    make = alias => f.createCallExpression(alias, undefined, args);
  } else if (ts.isCallExpression(target) && target.arguments.length) {
    const call = target;
    const [first, ...rest] = call.arguments;
    const update = (...args: ts.Expression[]) => f.updateCallExpression(call, call.expression, call.typeArguments, args);
    if (finding.ruleId === 'PF002' && options.baseDirectory !== undefined) {
      helper = 'safePath';
      module = options.guardsModule;
      make = alias => update(f.createCallExpression(alias, undefined, [f.createStringLiteral(options.baseDirectory!), first]), ...rest);
    } else if (finding.ruleId === 'PF003' && options.allowedHosts?.length && !rest.length) {
      helper = 'safeUrl';
      module = options.guardsModule;
      make = alias => update(f.createCallExpression(alias, undefined,
        [first, f.createArrayLiteralExpression(options.allowedHosts!.map(host => f.createStringLiteral(host)))]),
        f.createObjectLiteralExpression([f.createPropertyAssignment('redirect', f.createStringLiteral('error'))]));
    } else if (finding.ruleId === 'PF001' && ts.isTemplateExpression(first) && first.templateSpans.length === 1 &&
        /^[A-Za-z0-9_./-]+ $/.test(first.head.text) && first.templateSpans[0].literal.text === '' &&
        (call.arguments.length === 1 || (call.arguments.length === 2 &&
         (ts.isArrowFunction(rest[0]) || ts.isFunctionExpression(rest[0]))))) {
      const sync = finding.sink.message.endsWith('.execSync');
      if (sync && rest.length) return [];
      helper = sync ? 'execFileSync' : 'execFile';
      module = 'node:child_process';
      make = alias => f.createCallExpression(alias, undefined, [
        f.createStringLiteral(first.head.text.trim()),
        f.createArrayLiteralExpression([first.templateSpans[0].expression]),
        f.createObjectLiteralExpression([f.createPropertyAssignment('shell', f.createFalse())]),
        ...rest,
      ]);
    } else return [];
  } else return [];

  if (!module) return [];
  let suffix = 0;
  while (identifiers.has('__patchforge' + suffix)) suffix++;
  const alias = f.createIdentifier('__patchforge' + suffix);
  const imported = f.createImportDeclaration(undefined, f.createImportClause(false, undefined,
    f.createNamedImports([f.createImportSpecifier(false, f.createIdentifier(helper), alias)])), f.createStringLiteral(module));
  const insertion = source.statements.find(statement =>
    !ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression))?.getStart(source) ?? source.end;
  return [
    { start: target.getStart(source), end: target.end, replacement: printer.printNode(ts.EmitHint.Expression, make(alias), source) },
    { start: insertion, end: insertion, replacement: printer.printNode(ts.EmitHint.Unspecified, imported, source) + '\n' },
  ];
}
