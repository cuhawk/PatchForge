'use server';
import { relay } from './helper.js';
export async function lookup(url: string) {
  const [target] = await Promise.all([relay(url)]);
  return fetch(target, { method: 'HEAD' });
}
