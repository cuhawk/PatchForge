const label = 'ordinary module';
'use server';
export async function display(value: string) { return [label, value]; }
