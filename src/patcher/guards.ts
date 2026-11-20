import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isIP } from 'node:net';

export function safePath(base: string, input: string): string {
  const root = realpathSync(base);
  const absolute = resolve(root, input);
  function assertInside(path: string) {
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Path outside base');
  }
  assertInside(absolute);
  if (existsSync(absolute)) {
    const canonical = realpathSync(absolute);
    assertInside(canonical);
    return canonical;
  }
  throw new Error('Path does not exist');
}

export function safeWrite<T>(record: Record<string, T>, key: unknown, value: T): T {
  if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) ||
      Object.getPrototypeOf(record) !== Object.getPrototypeOf(Object.create(null))) {
    throw new Error('Unsafe record or key');
  }
  record[key] = value;
  return value;
}

export function safeUrl(input: string | URL, allowedHosts: readonly string[]): URL {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || isIP(host) ||
      !allowedHosts.includes(host) || !host.includes('.') ||
      ['.local', '.localhost', '.internal', '.home.arpa'].some(suffix => host.endsWith(suffix))) {
    throw new Error('Outbound URL is outside policy');
  }
  return url;
}
