'use server';
export async function lookup(url: string) {
  if (typeof url !== 'string') throw new TypeError('Invalid URL');
  if (!['https://example.test/status'].includes(url)) throw new Error('Unknown URL');
  return fetch(url, { redirect: 'error' });
}
