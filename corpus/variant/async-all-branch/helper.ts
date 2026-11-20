export async function group(input: string, toggle: boolean) {
  if (toggle) return Promise.all([Promise.resolve({ label: input })]);
  return [{ label: 'fixed' }];
}
