export function group(input: string) {
  const pending = [Promise.resolve('fixed')] as const;
  return Promise.all([...pending, Promise.resolve({ label: input })]);
}
