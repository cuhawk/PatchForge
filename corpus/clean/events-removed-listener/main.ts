import { bus } from './helper.js';
import { readFile } from 'node:fs';
function inspect(req: { body: string }) {
  const listener = (label: string) => readFile(label, () => undefined);
  bus.addListener('label', listener);
  bus.off('label', listener);
  bus.emit('label', req.body);
}
