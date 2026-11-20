import ts from 'typescript';
import { isAbsolute, resolve, sep } from 'node:path';
import { Finding, Site, readRules, site } from '../model.js';

interface Rules {
  sources: string[];
  sinks: Record<string, { names: string[]; argument: number }>;
  guards: { path: [string, string, string]; bindings: string[]; allowlist: string[] };
}

interface Value {
  traces: Site[][];
  fields?: Map<string, Value>;
  name?: string;
  literal?: string;
  fn?: ts.FunctionLikeDeclaration;
  closure?: State;
  base?: Value;
}

type State = Map<ts.Symbol, Value>;
const empty: Value = { traces: [] };
const merge = (...values: Value[]): Value => ({ traces: values.flatMap(value => value.traces).slice(0, 32) });
const choices = (a: Value, b: Value): Value => a === b ? a : merge(a, b);
const hop = (value: Value, node: ts.Node, message: string): Value =>
  ({ ...value, traces: value.traces.map(trace => [...trace, site(node, message)]) });

export function analyze(files: string[], options: ts.CompilerOptions = {}): Finding[] {
  const rules = readRules<Rules>('taint-ts.yaml');
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true, noEmit: true, noLib: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, ...options,
  };
  const moduleCache = ts.createModuleResolutionCache(ts.sys.getCurrentDirectory(), name => name, compilerOptions);
  const resolveModule = (name: string, file: string, mode: ts.ResolutionMode) =>
    ts.resolveModuleName(name, file, compilerOptions, ts.sys, moduleCache, undefined, mode).resolvedModule?.resolvedFileName;
  const roots = new Set(files.map(file => resolve(file)));
  const visited = new Set<string>();
  let program = ts.createProgram([...roots], compilerOptions);
  for (;;) {
    const before = roots.size;
    for (const file of program.getSourceFiles()) {
      if (visited.has(file.fileName) || file.isDeclarationFile || program.isSourceFileFromExternalLibrary(file)) continue;
      visited.add(file.fileName);
      function discover(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
            node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
          const path = resolveModule(node.arguments[0].text, file.fileName, ts.ModuleKind.CommonJS);
          if (path && !path.includes(`${sep}node_modules${sep}`) && !program.getSourceFile(path)) roots.add(path);
        }
        ts.forEachChild(node, discover);
      }
      discover(file);
    }
    if (before === roots.size) break;
    program = ts.createProgram([...roots], compilerOptions, undefined, program);
  }
  const checker = program.getTypeChecker();
  const findings = new Map<string, Finding>();
  const active = new Set<ts.Node>();
  const reached = new Set<ts.Node>();

  function report(ruleId: string, node: ts.Node, value: Value, message: string) {
    const sink = site(node, message);
    const trace = value.traces[0] ?? [];
    const key = JSON.stringify([ruleId, sink.file, sink.start]);
    if (!findings.has(key)) findings.set(key, { ruleId, sink, trace, confidence: trace.length ? 0.95 : 0.65 });
  }

  function lookup(node: ts.Identifier, state: State): Value {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return { ...empty, name: node.text };
    const stored = state.get(symbol);
    if (stored) return stored;
    let target = symbol;
    if (symbol.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(symbol);
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body) return { ...empty, fn: declaration, closure: moduleStates.get(declaration.getSourceFile()) ?? state };
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
        declaration.getSourceFile() !== node.getSourceFile() && !active.has(declaration)) {
      active.add(declaration);
      try { return expression(declaration.initializer, state); }
      finally { active.delete(declaration); }
    }
    for (const alias of symbol.declarations ?? []) {
      let context: ts.Node | undefined = alias;
      while (context && !ts.isImportDeclaration(context)) context = context.parent;
      if (context && ts.isStringLiteral(context.moduleSpecifier)) {
        const module = context.moduleSpecifier.text.replace(/^node:/, '');
        const imported = ts.isImportSpecifier(alias) ? (alias.propertyName ?? alias.name).text : '';
        return { ...empty, name: imported ? module + '.' + imported : module };
      }
    }
    if (declaration && !declaration.getSourceFile().isDeclarationFile &&
        !(ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword))) return empty;
    return { ...empty, name: node.text };
  }

  function member(value: Value, key: string | undefined, node: ts.Node): Value {
    const selected = key === undefined ? undefined : value.fields?.get(key);
    if (selected) return hop(selected, node, 'Read field');
    const name = value.name && key !== undefined ? value.name + '.' + key : undefined;
    if (name && rules.sources.includes(name)) return { traces: [[site(node, 'Untrusted source ' + name)]] };
    return { ...hop(value, node, 'Read property'), name, fields: undefined, fn: undefined, literal: undefined };
  }

  function bind(node: ts.BindingName, value: Value, state: State) {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) state.set(symbol, hop(value, node, 'Bind ' + node.text));
      return;
    }
    node.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      const key = ts.isArrayBindingPattern(node) ? String(index) :
        (element.propertyName ?? element.name).getText().replace(/^['"]|['"]$/g, '');
      bind(element.name, element.dotDotDotToken ? value : member(value, key, element), state);
    });
  }

  function invoke(value: Value, args: Value[], node: ts.Node, state: State): Value {
    const fn = value.fn;
    if (!fn?.body || active.has(fn) || active.size >= 24) return merge(...args);
    active.add(fn);
    reached.add(fn);
    try {
      const local = new Map([...(value.closure ?? []), ...state]);
      fn.parameters.forEach((param, i) => bind(param.name, args[i] ?? empty, local));
      const returns: Value[] = [];
      if (ts.isBlock(fn.body)) statements(fn.body.statements, local, returns);
      else returns.push(expression(fn.body, local));
      return hop(returns.length ? returns.reduce(choices) : empty, node, 'Return from helper');
    } finally { active.delete(fn); }
  }

  function expression(node: ts.Expression, state: State): Value {
    if (ts.isIdentifier(node)) return lookup(node, state);
    if (ts.isStringLiteralLike(node)) return { ...empty, literal: node.text };
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) {
      return hop(expression(node.expression, state), node, ts.isAwaitExpression(node) ? 'Await promise' : 'Read expression');
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { ...empty, fn: node, closure: state };
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
      const declaration = target?.valueDeclaration;
      if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body &&
          !declaration.getSourceFile().isDeclarationFile) {
        return { ...empty, fn: declaration, closure: moduleStates.get(declaration.getSourceFile()) ?? state };
      }
      return member(expression(node.expression, state), node.name.text, node);
    }
    if (ts.isElementAccessExpression(node)) return member(expression(node.expression, state), expression(node.argumentExpression, state).literal, node);
    if (ts.isTemplateExpression(node)) return hop(merge(...node.templateSpans.map(span => expression(span.expression, state))), node, 'Interpolate string');
    if (ts.isConditionalExpression(node)) {
      expression(node.condition, state);
      return choices(expression(node.whenTrue, new Map(state)), expression(node.whenFalse, new Map(state)));
    }
    if (ts.isBinaryExpression(node)) {
      const left = expression(node.left, state);
      const right = expression(node.right, state);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left)) bind(node.left, right, state);
        if (ts.isElementAccessExpression(node.left)) {
          const key = expression(node.left.argumentExpression, state);
          if (key.traces.length) report('PF005', node, key, 'Untrusted property key');
        }
        return right;
      }
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && left.literal !== undefined && right.literal !== undefined) {
        return { ...empty, literal: left.literal + right.literal };
      }
      return hop(merge(left, right), node, 'Combine values');
    }
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      const fields = new Map<string, Value>();
      const spread: Value[] = [];
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property)) {
            const value = expression(property.expression, state);
            value.fields?.forEach((field, key) => fields.set(key, hop(field, property, 'Spread field')));
            if (!value.fields) spread.push(value);
          } else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            const key = ts.isComputedPropertyName(property.name) ? expression(property.name.expression, state).literal :
              ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
            const binding = ts.isShorthandPropertyAssignment(property) && checker.getShorthandAssignmentValueSymbol(property);
            const value = binding && state.has(binding) ? state.get(binding)! :
              expression(ts.isPropertyAssignment(property) ? property.initializer : property.name, state);
            if (key !== undefined) fields.set(key, value);
            else spread.push(value);
          }
        }
      } else {
        node.elements.forEach((element, i) => fields.set(String(i), expression(element, state)));
      }
      return { ...merge(...spread), fields };
    }
    if (ts.isCallExpression(node)) {
      const callee = expression(node.expression, state);
      const args = node.arguments.map(argument => expression(argument, state));
      if (callee.name === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const module = args[0]?.literal;
        if (module === undefined) report('PF006', node, args[0] ?? empty, 'Non-constant module reference');
        else {
          const mode = callee.name === 'require' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
          const resolved = resolveModule(module, node.getSourceFile().fileName, mode);
          const source = resolved && program.getSourceFile(resolved);
          const symbol = source && checker.getSymbolAtLocation(source);
          if (symbol) {
            const fields = new Map<string, Value>();
            for (const entry of checker.getExportsOfModule(symbol)) {
              const target = entry.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(entry) : entry;
              const declaration = target.valueDeclaration;
              if (declaration && ts.isFunctionDeclaration(declaration)) fields.set(entry.name, { ...empty, fn: declaration, closure: state });
              const initializer = declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)
                ? declaration.initializer : ts.isBinaryExpression(declaration) && declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ? declaration.right : ts.isPropertyAccessExpression(declaration) && ts.isBinaryExpression(declaration.parent) &&
                    declaration.parent.left === declaration ? declaration.parent.right : undefined);
              if (initializer && !active.has(initializer)) {
                active.add(initializer);
                try { fields.set(entry.name, expression(initializer, moduleStates.get(initializer.getSourceFile()) ?? state)); }
                finally { active.delete(initializer); }
              }
            }
            return { ...empty, fields };
          }
          return { ...empty, name: module.replace(/^node:/, '') };
        }
      }
      for (const [id, sink] of Object.entries(rules.sinks)) {
        const value = args[sink.argument];
        if (callee.name && sink.names.includes(callee.name) && value?.traces.length) {
          report(id, node, value, 'Tainted argument to ' + callee.name);
        }
      }
      if (callee.name === rules.guards.path[0] && node.arguments.length === 2) {
        return { ...merge(...args), base: args[0] };
      }
      if (callee.name === 'Promise.resolve') return args[0] ?? empty;
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then' && args[0]?.fn) {
        return invoke(args[0], [expression(node.expression.expression, state)], node, state);
      }
      if (callee.fn) return invoke(callee, args, node, state);
      if (callee.name && Object.values(rules.sinks).some(sink => sink.names.includes(callee.name!))) return empty;
      return hop(merge(callee, ...args), node, 'Call result');
    }
    return empty;
  }

  function guarded(condition: ts.Expression, state: State) {
    if (ts.isParenthesizedExpression(condition)) return guarded(condition.expression, state);
    let identifier: ts.Identifier | undefined;
    if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        rules.guards.allowlist.includes('strictEquality')) {
      if (ts.isIdentifier(condition.left) && ts.isStringLiteralLike(condition.right)) identifier = condition.left;
      if (ts.isIdentifier(condition.right) && ts.isStringLiteralLike(condition.left)) identifier = condition.right;
    }
    if (ts.isCallExpression(condition) && ts.isPropertyAccessExpression(condition.expression)) {
      const { expression: receiver, name } = condition.expression;
      const argument = condition.arguments[0];
      if (name.text === 'includes' && rules.guards.allowlist.includes('literalArrayIncludes') &&
          ts.isArrayLiteralExpression(receiver) && receiver.elements.every(ts.isStringLiteralLike) &&
          argument && ts.isIdentifier(argument)) identifier = argument;
      if (name.text === rules.guards.path[2] && ts.isIdentifier(receiver) && argument && ts.isBinaryExpression(argument) &&
          argument.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const value = lookup(receiver, state);
        const base = expression(argument.left, state);
        if (value.base?.literal !== undefined && value.base.literal === base.literal && isAbsolute(base.literal) &&
            expression(argument.right, state).name === rules.guards.path[1]) {
          identifier = receiver;
        }
      }
    }
    if (identifier) bind(identifier, { ...lookup(identifier, state), traces: [] }, state);
  }

  function statements(nodes: readonly ts.Statement[], state: State, returns: Value[]): boolean {
    for (const node of nodes) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          bind(declaration.name, declaration.initializer ? expression(declaration.initializer, state) : empty, state);
        }
      } else if (ts.isExpressionStatement(node)) expression(node.expression, state);
      else if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
        if (node.expression) {
          const value = expression(node.expression, state);
          if (ts.isReturnStatement(node)) returns.push(value);
        }
        return true;
      } else if (ts.isBlock(node)) {
        if (statements(node.statements, state, returns)) return true;
      } else if (ts.isIfStatement(node)) {
        expression(node.expression, state);
        const yes = new Map(state);
        const no = new Map(state);
        const negated = ts.isPrefixUnaryExpression(node.expression) && node.expression.operator === ts.SyntaxKind.ExclamationToken;
        if (negated && ts.isPrefixUnaryExpression(node.expression)) guarded(node.expression.operand, no);
        else guarded(node.expression, yes);
        const exitYes = statements([node.thenStatement], yes, returns);
        const exitNo = node.elseStatement ? statements([node.elseStatement], no, returns) : false;
        if (exitYes && exitNo) return true;
        for (const key of new Set([...yes.keys(), ...no.keys()])) {
          state.set(key, exitYes ? no.get(key) ?? empty : exitNo ? yes.get(key) ?? empty :
            choices(yes.get(key) ?? empty, no.get(key) ?? empty));
        }
      }
    }
    return false;
  }

  const modules = program.getSourceFiles().filter(module => !module.isDeclarationFile && !program.isSourceFileFromExternalLibrary(module));
  const moduleStates = new Map(modules.map(module => [module, new Map<ts.Symbol, Value>()]));
  for (const [module, state] of moduleStates) statements(module.statements, state, []);
  for (const [module, state] of moduleStates) {
    function visit(node: ts.Node) {
      if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
           ts.isMethodDeclaration(node)) && !reached.has(node)) {
        invoke({ ...empty, fn: node, closure: state }, node.parameters.map(parameter =>
          ts.isIdentifier(parameter.name) ? { ...empty, name: parameter.name.text } : empty), node, state);
      }
      ts.forEachChild(node, visit);
    }
    visit(module);
  }
  return [...findings.values()].sort((a, b) => b.confidence - a.confidence ||
    a.sink.file.localeCompare(b.sink.file, 'en') || a.sink.start - b.sink.start || a.ruleId.localeCompare(b.ruleId, 'en'));
}
