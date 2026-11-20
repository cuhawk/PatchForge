import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { Finding } from '../model.js';

export interface LockfilePolicy {
  internalScopes?: Readonly<Record<string, readonly string[]>>;
  reviewedLifecycle?: readonly string[];
}

interface Entry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  hasInstallScript?: boolean;
  requiresBuild?: boolean;
  link?: boolean;
  resolution?: { integrity?: string; tarball?: string; repo?: string; commit?: string; directory?: string };
  dependencies?: Record<string, string | { version?: string }>;
  devDependencies?: Entry['dependencies'];
  optionalDependencies?: Entry['dependencies'];
  peerDependencies?: Entry['dependencies'];
}

function dependencies(entry: Entry) {
  return { ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
}

function packageId(key: string): [string, string] {
  const id = key.replace(/^\//, '').replace(/\(.*/, '');
  const legacy = /^((?:@[^/]+\/)?[^/@]+)\/([^/_]+)(?:_.*)?$/.exec(id);
  if (legacy) return [legacy[1], legacy[2]];
  const separator = id.indexOf('@', 1);
  if (separator !== -1) return [id.slice(0, separator), id.slice(separator + 1)];
  const slash = id.lastIndexOf('/');
  return slash > 0 ? [id.slice(0, slash), id.slice(slash + 1)] : [id, ''];
}

function sha512(value: unknown): boolean {
  return typeof value === 'string' && value.split(/\s+/).some(hash =>
    /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/.test(hash));
}

export function auditLockfile(path: string, policy: LockfilePolicy = {}): Finding[] {
  const file = resolve(path);
  const npm = basename(file) === 'package-lock.json';
  if (!npm && basename(file) !== 'pnpm-lock.yaml') throw new Error('Unsupported lockfile: ' + file);
  const text = readFileSync(file, 'utf8');
  const document = parseDocument(text);
  if (document.errors.length) throw new Error('Invalid lockfile: ' + document.errors[0].message);
  const data = (npm ? JSON.parse(text) : document.toJS()) as {
    lockfileVersion?: number | string;
    packages?: Record<string, Entry>;
    importers?: Record<string, Entry>;
    snapshots?: Record<string, Entry>;
    dependencies?: Record<string, Entry>;
  } & Entry;
  if (!data?.lockfileVersion) throw new Error('Missing lockfileVersion: ' + file);
  const findings: Finding[] = [];
  const lineStarts = [0, ...Array.from(text.matchAll(/\r\n|\r|\n/g), match => match.index + match[0].length)];
  function position(offset: number) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid;
    }
    return [low + 1, offset - lineStarts[low] + 1];
  }

  const locations = new Map<string, readonly number[]>();
  function indexTable(path: string[], nested = false) {
    const table = document.getIn(path, true);
    if (!isMap(table)) return;
    for (const { key } of table.items) {
      if (!isScalar(key) || !key.range) continue;
      const entry = [...path, String(key.value)];
      locations.set(JSON.stringify(entry), key.range);
      if (nested) indexTable([...entry, 'dependencies'], true);
    }
  }
  indexTable(['packages']);
  if (npm && !data.packages) indexTable(['dependencies'], true);

  function inspect(path: string[], entry: Entry, name: string, version: string, direct: boolean,
                   snapshot?: Entry, aliases: readonly string[] = []) {
    const source = entry.resolved ?? entry.resolution?.tarball ?? entry.resolution?.repo ?? version;
    if (entry.link || entry.resolution?.directory || /^(?:file|link|workspace):/.test(source) &&
        !/\.(?:tgz|tar\.gz)(?:$|[?#])/.test(source)) return;
    const git = !!entry.resolution?.repo || /^(?:git(?:\+[^:]+)?:|ssh:|github:|gitlab:|bitbucket:|git@)|\.git(?:[?#]|$)/i.test(source);
    const commit = entry.resolution?.commit ?? source.split('#')[1];
    const integrity = sha512(entry.integrity ?? entry.resolution?.integrity);
    const range = locations.get(JSON.stringify(path));
    const start = range?.[0] ?? 0;
    const end = range?.[1] ?? Math.min(1, text.length);
    const [line, column] = position(start);
    const [endLine, endColumn] = position(end);
    function report(ruleId: string, reason: string) {
      findings.push({ ruleId, sink: { file, start, end, line, column, endLine, endColumn,
        message: name + '@' + version + ' ' + reason }, trace: [], confidence: 0.95,
        fingerprintContext: [path, name] });
    }

    if (!git && !integrity) report('PF201', 'is missing a valid SHA-512 integrity digest');
    const unpinned = git ? !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit ?? '') :
      /^https?:\/\//i.test(source) && !integrity;
    if (unpinned) {
      report('PF202', 'uses a remote source without an immutable pin');
    }

    let host = 'registry.npmjs.org';
    if (/^[a-z][\w+.-]*:/i.test(source) || git) {
      try {
        const url = new URL(source);
        host = url.protocol === 'https:' ? url.host : '';
      } catch { host = ''; }
    }
    for (const candidate of new Set([name, entry.name ?? name, ...aliases])) {
      const scope = candidate.split('/')[0];
      if (scope.startsWith('@') && Object.hasOwn(policy.internalScopes ?? {}, scope) &&
          !policy.internalScopes?.[scope].some(registry => registry.toLowerCase() === host)) {
        report('PF203', 'resolves outside its configured internal registry');
        break;
      }
    }
    if (!direct && (entry.hasInstallScript || entry.requiresBuild || snapshot?.requiresBuild || snapshot?.hasInstallScript) &&
        !policy.reviewedLifecycle?.includes((entry.name ?? name) + '@' + version)) {
      report('PF204', 'has an unreviewed transitive install hook');
    }
  }

  if (npm && data.packages) {
    const direct = new Set<string>();
    for (const [workspace, entry] of Object.entries(data.packages)) {
      if (workspace.split('/').includes('node_modules')) continue;
      for (const name of Object.keys(dependencies(entry))) {
        const local = workspace ? workspace + '/node_modules/' + name : 'node_modules/' + name;
        direct.add(Object.hasOwn(data.packages, local) ? local : 'node_modules/' + name);
      }
    }
    for (const [key, entry] of Object.entries(data.packages)) {
      if (!key.split('/').includes('node_modules')) continue;
      inspect(['packages', key], entry, key.split(/(?:^|\/)node_modules\//).at(-1)!, entry.version ?? '', direct.has(key));
    }
  } else if (npm) {
    function nested(entries: Record<string, Entry>, path: string[]) {
      for (const [name, entry] of Object.entries(entries)) {
        const entryPath = [...path, name];
        inspect(entryPath, entry, name, entry.version ?? '', false);
        nested((entry.dependencies ?? {}) as unknown as Record<string, Entry>, [...entryPath, 'dependencies']);
      }
    }
    nested(data.dependencies ?? {}, ['dependencies']);
  } else {
    const direct = new Map<string, string[]>();
    for (const importer of Object.values(data.importers ?? { '.': data })) {
      for (const [name, specifier] of Object.entries(dependencies(importer))) {
        const version = (typeof specifier === 'string' ? specifier : specifier?.version)?.replace(/\(.*/, '');
        if (!version) continue;
        const id = version.replace(/^npm:/, '');
        const key = id.startsWith('/') || id.indexOf('@', 1) !== -1
          ? packageId(id).join('@') : name + '@' + id;
        const aliases = direct.get(key) ?? [];
        aliases.push(name);
        direct.set(key, aliases);
      }
    }
    const builds = new Map<string, Entry>();
    for (const [key, snapshot] of Object.entries(data.snapshots ?? {})) {
      if (snapshot.requiresBuild || snapshot.hasInstallScript) builds.set(packageId(key).join('@'), snapshot);
    }
    for (const [key, entry] of Object.entries(data.packages ?? {})) {
      const [name, version] = packageId(key);
      const id = name + '@' + version;
      inspect(['packages', key], entry, name, version, direct.has(id), builds.get(id), direct.get(id));
    }
  }
  return findings;
}
