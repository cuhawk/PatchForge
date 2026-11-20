import ts from 'typescript';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readRules, site, structuralContext, type Finding } from '../model.js';

interface HookRules { hooks: string[]; rules: Record<string, string> }

const shellTokens = /"[^"]*"|'[^']*'|&&|\|\||[;|]|[^\s;|&]+/g;

export function auditInstallHooks(packageFile: string): Finding[] {
  const rules = readRules<HookRules>('install-hooks.yaml');
  const manifest = realpathSync(packageFile);
  const text = readFileSync(manifest, 'utf8');
  const source = ts.createSourceFile(manifest, text, ts.ScriptTarget.JSON, true, ts.ScriptKind.JSON);
  const data = JSON.parse(text) as { scripts?: Record<string, unknown> };
  const findings = new Map<string, Finding>();
  const visited = new Set<string>();
  const pathRoot = dirname(manifest);

  function report(ruleId: string, node: ts.Node) {
    const sink = site(node, rules.rules[ruleId]);
    findings.set(JSON.stringify([ruleId, sink.file, sink.start]), { ruleId, sink, trace: [], fingerprintContext: structuralContext(node), confidence: 0.8 });
  }

  function inspectScript(file: ts.SourceFile) {
    const marks = new Map<string, Set<string>>();
    function evaluate(node: ts.Node): Set<string> {
      const flags = new Set<string>();
      ts.forEachChild(node, child => evaluate(child).forEach(flag => flags.add(flag)));
      if (ts.isIdentifier(node)) marks.get(node.text)?.forEach(flag => flags.add(flag));
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
          node.expression.text === 'process' && node.name.text === 'env') flags.add('env');
      else if (ts.isPropertyAccessExpression(node) ||
               (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))) flags.delete('env');
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) marks.set(node.name.text, flags);
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) &&
          node.moduleSpecifier.text.startsWith('.')) {
        reference(resolve(dirname(file.fileName), node.moduleSpecifier.text), node);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = node.expression.getText(file);
        const specifier = node.arguments?.[0];
        if ((name === 'require' || name === 'import') && specifier && ts.isStringLiteralLike(specifier) &&
            specifier.text.startsWith('.')) {
          reference(resolve(dirname(file.fileName), specifier.text), node);
        }
        if (['fetch', 'https.get', 'http.get', 'axios.get'].includes(name)) flags.add('network');
        if (name === 'atob' || (name === 'Buffer.from' && node.arguments?.[1] &&
          ts.isStringLiteralLike(node.arguments[1]) && node.arguments[1].text === 'base64')) flags.add('decode');
        if (['eval', 'Function', 'globalThis.eval', 'globalThis.Function'].includes(name)) {
          if (flags.has('network')) report('PF101', node);
          if (flags.has('decode')) report('PF102', node);
        }
        if (['console.log', 'console.dir', 'console.error', 'process.stdout.write'].includes(name) && flags.has('env')) {
          report('PF103', node);
        }
      }
      return flags;
    }
    evaluate(file);
  }

  function reference(path: string, node: ts.Node) {
    try {
      const target = realpathSync(resolve(pathRoot, path));
      const local = relative(pathRoot, target);
      if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep) || !/\.[cm]?js$/i.test(local)) {
        report('PF104', node);
        return;
      }
      if (!visited.has(target)) {
        visited.add(target);
        inspectScript(ts.createSourceFile(target, readFileSync(target, 'utf8'), ts.ScriptTarget.Latest, true));
      }
    } catch { report('PF104', node); }
  }

  const hookNodes = new Map<string, ts.Node>();
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer) &&
        ts.isObjectLiteralExpression(node.parent) && ts.isPropertyAssignment(node.parent.parent) &&
        ts.isStringLiteral(node.parent.parent.name) && node.parent.parent.name.text === 'scripts') {
      hookNodes.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  const inspected = new Set<string>();
  function hook(name: string) {
    if (inspected.has(name)) return;
    inspected.add(name);
    const command = data.scripts?.[name];
    const node = hookNodes.get(name);
    if (!node || typeof command !== 'string') return;
    const tokens = (command.match(shellTokens) ?? []).map(token => token.replace(/^['"]|['"]$/g, ''));
    const segments: string[][] = [[]];
    const operators: string[] = [];
    for (const token of tokens) {
      if ([';', '&&', '||', '|'].includes(token)) {
        operators.push(token);
        segments.push([]);
      } else segments.at(-1)!.push(token);
    }
    if (operators.some((operator, i) => operator === '|' &&
        ['curl', 'wget'].includes(segments[i][0]) && ['sh', 'bash', 'node'].includes(segments[i + 1][0]))) {
      report('PF101', node);
    }
    for (const [bin, first, second] of segments) {
      if (bin === 'printenv' || (bin === 'env' && !first)) report('PF103', node);
      if (bin === 'npm' && ['run', 'run-script'].includes(first) && second) hook(second);
      if (bin === 'node') {
        if (['-e', '--eval'].includes(first) && second) {
          inspectScript(ts.createSourceFile(resolve(pathRoot, 'inline-' + encodeURIComponent(name) + '.js'), second, ts.ScriptTarget.Latest, true));
        } else if (first && !first.startsWith('-')) reference(first, node);
        else report('PF104', node);
      }
    }
  }
  rules.hooks.forEach(hook);
  return [...findings.values()].sort((a, b) => a.sink.file.localeCompare(b.sink.file, 'en') ||
    a.sink.start - b.sink.start || a.ruleId.localeCompare(b.ruleId, 'en'));
}
