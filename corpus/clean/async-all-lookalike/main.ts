import { readFile } from 'node:fs';
const Promise = { all: ([_value]: string[]) => ['fixed'] };
async function inspect(req: { body: string }) {
  const [label] = await Promise.all([req.body]);
  readFile(label, () => undefined);
}
