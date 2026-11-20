import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { BlockList, isIP } from 'node:net';

export function safePath(base: string, input: string): string {
  const root = realpathSync(base);
  const absolute = resolve(root, input);
  function assertInside(path: string) {
    if (path === root || !path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Path outside base');
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

const reserved = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) reserved.addSubnet(address, bits, 'ipv4');
reserved.addSubnet('2001::', 23, 'ipv6');
reserved.addSubnet('2001:db8::', 32, 'ipv6');
reserved.addSubnet('2002::', 16, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function safeUrl(input: string | URL, allowedHosts: readonly string[]): URL {
  const url = new URL(input);
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const version = isIP(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !allowedHosts.includes(host) || !version || (version === 6 && !globalV6.check(host, 'ipv6')) ||
      reserved.check(host, version === 6 ? 'ipv6' : 'ipv4')) {
    throw new Error('Outbound URL is outside policy');
  }
  return url;
}
