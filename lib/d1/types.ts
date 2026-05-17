// Narrow structural interface over the D1 API — satisfied by both the real
// Cloudflare D1Database and the bun:sqlite-backed TestD1Database in tests.

export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(query: string): D1StmtLike;
  exec(query: string): Promise<unknown>;
}
