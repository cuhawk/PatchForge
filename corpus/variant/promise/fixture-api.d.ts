declare const fs: { readFile(input: string): string };
declare const child_process: { exec(input: string): string };
declare const fetch: (input: string) => string;
declare const db: { query(input: string, bindings?: string[]): unknown };
declare const req: { query: string; body: string; params: string };
declare const mcp: { toolArgs: string };
