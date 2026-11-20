'use server';
export async function save(label: string) {
  if (typeof label !== 'string') throw new TypeError('Invalid label');
  return label.trim();
}
