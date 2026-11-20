import { relay } from './helper.js';
import { readFile } from 'node:fs';
function inspect(req: { body: string }) {
  return Promise.all([relay(req.body)]).then(([label]) => readFile(label, () => undefined));
}
