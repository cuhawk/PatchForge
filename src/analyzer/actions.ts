import ts from 'typescript';

function hasServerDirective(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (/^(['"])use server\1$/.test(statement.expression.getText())) return true;
  }
  return false;
}

export function isServerAction(fn: ts.Node): fn is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  if (!(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) || !fn.body ||
      !ts.getModifiers(fn)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (ts.isBlock(fn.body) && hasServerDirective(fn.body.statements)) return true;
  const owner = ts.isVariableDeclaration(fn.parent) && ts.isVariableDeclarationList(fn.parent.parent)
    ? fn.parent.parent.parent : fn;
  const exported = ts.isExportAssignment(fn.parent) ? fn.parent : owner;
  const source = exported.parent;
  if (!ts.isSourceFile(source) || !hasServerDirective(source.statements)) return false;
  if (ts.isExportAssignment(exported) || (ts.canHaveModifiers(exported) &&
      ts.getModifiers(exported)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) return true;
  const name = ts.isVariableDeclaration(fn.parent) ? fn.parent.name : fn.name;
  return !!name && ts.isIdentifier(name) && source.statements.some(statement =>
    ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier &&
    !!statement.exportClause && ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.some(element => !element.isTypeOnly &&
      (element.propertyName ?? element.name).text === name.text));
}

export function validationType(parameter: ts.ParameterDeclaration): string | undefined {
  if (parameter.dotDotDotToken || parameter.questionToken || !parameter.type ||
      !ts.isIdentifier(parameter.name)) return undefined;
  if (ts.isTypeReferenceNode(parameter.type) && !parameter.type.typeArguments &&
      ts.isIdentifier(parameter.type.typeName) && parameter.type.typeName.text === 'FormData') return 'FormData';
  switch (parameter.type.kind) {
    case ts.SyntaxKind.StringKeyword: return 'string';
    case ts.SyntaxKind.NumberKeyword: return 'number';
    case ts.SyntaxKind.BooleanKeyword: return 'boolean';
  }
  return undefined;
}

// Recognize a leading reject-on-mismatch guard while leaving input tainted for sink checks.
export function validatedParameters(body: ts.ConciseBody): Set<string> {
  const validated = new Set<string>();
  if (!ts.isBlock(body)) return validated;
  for (const statement of body.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue;
    if (!ts.isIfStatement(statement) || statement.elseStatement) break;
    const branch = statement.thenStatement;
    if (!ts.isThrowStatement(branch) &&
        !(ts.isBlock(branch) && branch.statements.length === 1 && ts.isThrowStatement(branch.statements[0]))) break;
    const condition = statement.expression;
    if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isParenthesizedExpression(condition.operand)) {
      const test = condition.operand.expression;
      if (ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
          ts.isIdentifier(test.left) && test.right.getText() === 'globalThis.FormData') {
        validated.add(JSON.stringify([test.left.text, 'FormData']));
        continue;
      }
    }
    if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        !ts.isTypeOfExpression(condition.left) || !ts.isIdentifier(condition.left.expression) ||
        !ts.isStringLiteral(condition.right)) break;
    validated.add(JSON.stringify([condition.left.expression.text, condition.right.text]));
  }
  return validated;
}
