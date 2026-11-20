'use server';
async function normalize(label: string) { return label.trim(); }
export async function fixed() { return normalize('fixed'); }
