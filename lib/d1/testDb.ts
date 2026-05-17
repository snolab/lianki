// A minimal D1Database implementation backed by node:sqlite, for unit tests.
// Implements only the subset of the D1 API the repositories use:
// prepare().bind().first()/.all()/.run() and exec().

import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

class TestPreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): TestPreparedStatement {
    return new TestPreparedStatement(this.db, this.query, values);
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.db.prepare(this.query).get(...(this.params as never[])) as Row | undefined;
    if (row == null) return null;
    if (colName) return (row[colName] ?? null) as T;
    return { ...row } as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    const rows = this.db.prepare(this.query).all(...(this.params as never[])) as Row[];
    return { results: rows.map((r) => ({ ...r })) as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    this.db.prepare(this.query).run(...(this.params as never[]));
    return { success: true, meta: {} };
  }
}

export class TestD1Database {
  constructor(private readonly db: DatabaseSync = new DatabaseSync(":memory:")) {}

  prepare(query: string): TestPreparedStatement {
    return new TestPreparedStatement(this.db, query);
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }

  async batch(statements: TestPreparedStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }

  raw(): DatabaseSync {
    return this.db;
  }
}

/** Create an in-memory test database with the given schema SQL applied. */
export function createTestD1(schemaSql: string): TestD1Database {
  const d1 = new TestD1Database();
  d1.raw().exec(schemaSql);
  return d1;
}
