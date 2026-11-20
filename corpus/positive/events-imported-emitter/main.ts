import { bus } from './helper.js';
import { readFile } from 'node:fs';
function inspect(req: { body: string }) {
  bus.on('label', (label: string) => readFile(label, () => undefined));
  bus.emit('label', req.body);
}
