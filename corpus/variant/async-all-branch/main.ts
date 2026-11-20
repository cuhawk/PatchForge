import { group } from './helper.js';
import { readFile } from 'node:fs';
declare const toggle: boolean;
async function inspect(req: { body: string }) {
  const result = await group(req.body, toggle);
  readFile(result[0].label, () => undefined);
}
