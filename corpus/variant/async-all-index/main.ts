import { group } from './helper.js';
import { readFile } from 'node:fs';
async function inspect(req: { body: string }) {
  const labels = await group(req.body);
  readFile(labels[1].label, () => undefined);
}
