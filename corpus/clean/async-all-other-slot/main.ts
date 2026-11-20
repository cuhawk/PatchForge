import { relay } from './helper.js';
import { readFile } from 'node:fs';
async function inspect(req: { body: string }) {
  const [, label] = await Promise.all([relay(req.body), relay('fixed')]);
  readFile(label, () => undefined);
}
