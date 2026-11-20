import type { EventEmitter } from 'node:events';
import { readFile } from 'node:fs';
export function register(bus: EventEmitter) {
  bus.once('label', (_tag: string, label: string) => readFile(label, () => undefined));
}
