import ts from 'typescript';
import { isAbsolute, resolve, sep } from 'node:path';
import { isServerAction, validatedParameters, validationType } from './actions.js';
import { Finding, Site, readRules, site, structuralContext } from '../model.js';

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
  fulfilled?: Value;
  emitter?: Emitter;
  eventMethod?: string;
}

interface Listener {
  event: string;
  callback: Value;
  once: boolean;
}
interface Emitter {
  listeners: Listener[];
}
type State = Map<ts.Symbol, Value>;
const empty: Value = { traces: [] };
const merge = (...values: Value[]): Value => ({ traces: values.flatMap(value => value.traces).slice(0, 32) });
function choices(a: Value, b: Value): Value {
  if (a === b) return a;
  const fields = new Map<string, Value>();
  for (const key of new Set([...(a.fields?.keys() ?? []), ...(b.fields?.keys() ?? [])])) {
    fields.set(key, choices(a.fields?.get(key) ?? merge(a), b.fields?.get(key) ?? merge(b)));
  }
  const value = merge(a, b);
  return {
    ...value,
    fields: fields.size ? fields : undefined,
    fulfilled: a.fulfilled || b.fulfilled ? choices(fulfilled(a), fulfilled(b)) : undefined,
    literal: a.literal === b.literal ? a.literal : undefined,
  };
}
const moduleName = (name: string): string =>
  name === 'events' ? 'node:events' : name === 'node:events' ? name : name.replace(/^node:/, '');
const fulfilled = (value: Value): Value => value.fulfilled ?? value;
const hop = (value: Value, node: ts.Node, message: string): Value =>
  ({ ...value, traces: value.traces.map(trace => [...trace, site(node, message)]),
    fields: value.fields && new Map([...value.fields].map(([key, field]) => [key, hop(field, node, message)])),
    fulfilled: value.fulfilled && hop(value.fulfilled, node, message) });

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
  const moduleEmitters = new Set<Emitter>();
  let initializingModules = true;

  function report(ruleId: string, node: ts.Node, value: Value, message: string) {
    const sink = site(node, message);
    const trace = value.traces.find(trace => ruleId === 'PF008' && trace[0]?.message === 'Server Action input') ?? value.traces[0] ?? [];
    const key = JSON.stringify([ruleId, sink.file, sink.start]);
    if (!findings.has(key)) findings.set(key, { ruleId, sink, trace, fingerprintContext: structuralContext(node), confidence: trace.length ? 0.95 : 0.65 });
  }

  function exportedValue(symbol: ts.Symbol, state: State): Value | undefined {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.valueDeclaration;
    if (!declaration || declaration.getSourceFile().isDeclarationFile ||
        program.isSourceFileFromExternalLibrary(declaration.getSourceFile())) return undefined;
    const moduleState = moduleStates.get(declaration.getSourceFile()) ?? state;
    const stored = moduleState.get(target);
    if (stored) return stored;
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return { ...empty, fn: declaration, closure: moduleState };
    const initializer = ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) ? declaration.initializer :
      ts.isBinaryExpression(declaration) && declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken ? declaration.right :
      ts.isPropertyAccessExpression(declaration) && ts.isBinaryExpression(declaration.parent) &&
        declaration.parent.left === declaration ? declaration.parent.right : undefined;
    if (!initializer || active.has(initializer)) return empty;
    active.add(initializer);
    try { return expression(initializer, moduleState); }
    finally { active.delete(initializer); }
  }

  function moduleSummary(symbol: ts.Symbol, state: State): Value {
    const fields = new Map<string, Value>();
    for (const entry of checker.getExportsOfModule(symbol)) {
      fields.set(entry.name, exportedValue(entry, state) ?? empty);
    }
    return { ...empty, fields };
  }

  function lookup(node: ts.Identifier, state: State): Value {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return { ...empty, name: node.text };
    const stored = state.get(symbol);
    if (stored) return stored;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    if (declaration && (ts.isFunctionDeclaration(declaration) || declaration.getSourceFile() !== node.getSourceFile())) {
      const value = exportedValue(symbol, state);
      if (value) return value;
    }
    if (symbol.declarations?.some(ts.isNamespaceImport) && declaration && ts.isSourceFile(declaration) &&
        moduleStates.has(declaration)) return moduleSummary(target, state);
    for (const alias of symbol.declarations ?? []) {
      let context: ts.Node | undefined = alias;
      while (context && !ts.isImportDeclaration(context)) context = context.parent;
      if (context && ts.isStringLiteral(context.moduleSpecifier)) {
        const module = moduleName(context.moduleSpecifier.text);
        const imported = ts.isImportSpecifier(alias) ? (alias.propertyName ?? alias.name).text : '';
        return { ...empty, name: imported ? module + '.' + imported : module };
      }
    }
    if (declaration && !declaration.getSourceFile().isDeclarationFile &&
        !(ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword))) return empty;
    return { ...empty, name: node.text };
  }

  function member(value: Value, key: string | undefined, node: ts.Node): Value {
    if (value.emitter && key && ['on', 'addListener', 'once', 'emit', 'off', 'removeListener'].includes(key)) {
      return { ...empty, emitter: value.emitter, eventMethod: key };
    }
    const selected = key === undefined ? undefined : value.fields?.get(key);
    if (selected) return hop(selected, node, 'Read field');
    const name = value.name && key !== undefined ? value.name + '.' + key : undefined;
    if (name && rules.sources.includes(name)) return { traces: [[site(node, 'Untrusted source ' + name)]] };
    return { ...hop(value, node, 'Read property'), name, fields: undefined, fn: undefined, literal: undefined, fulfilled: undefined, emitter: undefined };
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
      const signature = checker.getSignatureFromDeclaration(fn);
      const returnType = signature && checker.getReturnTypeOfSignature(signature);
      const awaitedType = returnType && checker.getAwaitedType(returnType);
      const async = ts.getModifiers(fn)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
        (awaitedType !== undefined && awaitedType !== returnType);
      const result = returns.length ? returns.map(value => async ? fulfilled(value) : value).reduce(choices) : empty;
      const summary = hop(result, node, 'Return from helper');
      return async ? { ...empty, fulfilled: summary } : summary;
    } finally { active.delete(fn); }
  }

  function expression(node: ts.Expression, state: State): Value {
    if (ts.isIdentifier(node)) return lookup(node, state);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return { ...empty, literal: node.text };
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) ) {
      return hop(expression(node.expression, state), node, 'Read expression');
    }
    if (ts.isAwaitExpression(node)) {
      return hop(fulfilled(expression(node.expression, state)), node, 'Await promise');
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { ...empty, fn: node, closure: state };
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      const receiver = checker.getSymbolAtLocation(node.expression);
      const access = receiver?.declarations?.some(ts.isNamespaceImport) && symbol && exportedValue(symbol, state);
      if (access) return access;
      const value = expression(node.expression, state);
      const property = member(value, node.name.text, node);
      return node.name.text === 'then' ? { ...property, base: value } : property;
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
        let index = 0;
        for (const element of node.elements) {
          if (ts.isSpreadElement(element)) {
            const value = expression(element.expression, state);
            if (!value.fields) {
              spread.push(value);
              break;
            }
            for (const field of value.fields.values()) fields.set(String(index++), field);
          } else fields.set(String(index++), expression(element, state));
        }
      }
      return { ...merge(...spread), fields };
    }
    if (ts.isNewExpression(node)) {
      const constructor = expression(node.expression, state);
      node.arguments?.forEach(argument => expression(argument, state));
      if (['node:events.EventEmitter', 'node:events'].includes(constructor.name ?? '')) {
        const emitter: Emitter = { listeners: [] };
        if (initializingModules) moduleEmitters.add(emitter);
        return { ...empty, emitter };
      }
      return empty;
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
          if (symbol && source && moduleStates.has(source)) return moduleSummary(symbol, state);
          return { ...empty, name: moduleName(module) };
        }
      }
      for (const [id, sink] of Object.entries(rules.sinks)) {
        const value = args[sink.argument];
        if (callee.name && sink.names.includes(callee.name) && value?.traces.length) {
          const actionUrl = id === 'PF003' && value.traces.some(trace =>
            trace[0]?.message === 'Server Action input');
          report(actionUrl ? 'PF008' : id, node, value,
            actionUrl ? 'Server Action URL requires an outbound allowlist' : 'Tainted argument to ' + callee.name);
        }
      }
      if (callee.name === rules.guards.path[0] && node.arguments.length === 2) {
        return { ...merge(...args), base: args[0] };
      }
      if (callee.name === 'Promise.resolve') return { ...empty, fulfilled: fulfilled(args[0] ?? empty) };
      if (callee.name === 'Promise.all' && args[0]) {
        const batch = args[0];
        const fields = batch.fields && new Map([...batch.fields].map(([key, value]) =>
          [key, hop(fulfilled(value), node, 'Resolve Promise.all element')]));
        return { ...empty, fulfilled: { ...batch, fields } };
      }
      if (callee.emitter && callee.eventMethod) {
        const { emitter, eventMethod } = callee;
        const [event, callback] = args;
        if (event?.literal === undefined) return empty;
        if (eventMethod === 'emit') {
          for (const listener of [...emitter.listeners]) {
            if (listener.event !== event.literal) continue;
            if (listener.once) {
              const index = emitter.listeners.indexOf(listener);
              if (index === -1) continue;
              emitter.listeners.splice(index, 1);
            }
            invoke(listener.callback, args.slice(1).map(value => hop(value, node, 'Emit ' + event.literal)), node, state);
          }
          return empty;
        }
        if (callback?.fn && (eventMethod === 'off' || eventMethod === 'removeListener')) {
          for (let index = emitter.listeners.length - 1; index >= 0; index--) {
            const { event: registeredEvent, callback: registeredCallback } = emitter.listeners[index];
            if (registeredEvent !== event.literal || registeredCallback.fn !== callback.fn ||
                registeredCallback.closure !== callback.closure) continue;
            emitter.listeners.splice(index, 1);
            break;
          }
        } else if (callback?.fn) emitter.listeners.push({ event: event.literal, callback, once: eventMethod === 'once' });
        return { ...empty, emitter };
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then' && args[0]?.fn) {
        const receiver = callee.base;
        if (receiver?.fulfilled) {
          return { ...empty, fulfilled: fulfilled(invoke(args[0], [fulfilled(receiver)], node, state)) };
        }
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
  initializingModules = false;
  const initialListeners = new Map([...moduleEmitters].map(emitter => [emitter, [...emitter.listeners]]));
  for (const [module, state] of moduleStates) {
    function visit(node: ts.Node) {
      if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
           ts.isMethodDeclaration(node))) {
        if (isServerAction(node)) {
          const validated = validatedParameters(node.body);
          const args = node.parameters.map(parameter => {
            const value = { traces: [[site(parameter, 'Server Action input')]] };
            const type = validationType(parameter);
            if (type && !validated.has(JSON.stringify([parameter.name.getText(), type]))) {
              report('PF007', parameter, value, 'Server Action input requires runtime validation');
            }
            return value;
          });
          invoke({ ...empty, fn: node, closure: state }, args, node, state);
        } else if (!reached.has(node)) {
          invoke({ ...empty, fn: node, closure: state }, node.parameters.map(parameter =>
            ts.isIdentifier(parameter.name) ? { ...empty, name: parameter.name.text } : empty), node, state);
        }
        for (const [emitter, listeners] of initialListeners) emitter.listeners = [...listeners];
      }
      ts.forEachChild(node, visit);
    }
    visit(module);
  }
  return [...findings.values()].sort((a, b) => b.confidence - a.confidence ||
    a.sink.file.localeCompare(b.sink.file, 'en') || a.sink.start - b.sink.start || a.ruleId.localeCompare(b.ruleId, 'en'));
}
