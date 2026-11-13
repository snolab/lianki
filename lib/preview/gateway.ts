import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export type Statement = { sql: string; params: unknown[] };
export type BlobValue = {
  bytes: ArrayBuffer;
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: Record<string, string | Date>;
  customMetadata?: Record<string, string>;
};
/** Capability supplied only by a named Service Binding, never a public URL. */
export interface CoreBinding {
  query(tenant: string, statements: Statement[], batch: boolean): Promise<unknown[]>;
  blob(
    tenant: string,
    op: "get" | "put" | "delete",
    key: string,
    value?: ArrayBuffer,
    options?: unknown,
  ): Promise<BlobValue | null>;
  proxy(tenant: string, request: Request): Promise<Response>;
}
export type GatewayEnv = {
  DB?: D1Database;
  BLOBS?: R2Bucket;
  CORE?: CoreBinding;
  CORE_AUTH?: {
    authorize(request: Request): Promise<Response>;
    proxy?(request: Request): Promise<Response>;
  };
  LIANKI_BOX_CLIENT_ID?: string;
  PREVIEW_MODE?: string;
  PREVIEW_TENANT?: string;
  PREVIEW_ORIGIN?: string;
  PREVIEW_LOCAL_ROUTES?: string;
  PREVIEW_PRODUCTION_ROUTES?: string;
};
export function isPreview(env: GatewayEnv): boolean {
  return env.PREVIEW_MODE === "1" || !env.DB;
}
export function previewTarget(env: GatewayEnv) {
  if (!env.CORE || !env.PREVIEW_TENANT || !/^[a-z0-9-]{1,63}$/.test(env.PREVIEW_TENANT))
    throw new Error("Preview requires CORE and a deployment-owned PREVIEW_TENANT");
  return { core: env.CORE, tenant: env.PREVIEW_TENANT };
}

/** Production returns the exact native binding, without wrapping or RPC. */
export function dataGateway(env: GatewayEnv): D1Database {
  if (!isPreview(env)) return env.DB!;
  const { core, tenant } = previewTarget(env);
  class Prepared {
    constructor(
      readonly sql: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      return new Prepared(this.sql, params);
    }
    async all() {
      return (await core.query(tenant, [{ sql: this.sql, params: this.params }], false))[0] as {
        results: Record<string, unknown>[];
      };
    }
    run() {
      return this.all();
    }
    async first(column?: string) {
      const row = (await this.all()).results[0];
      if (!row) return null;
      if (column && !(column in row)) throw new Error(`Unknown column: ${column}`);
      return column ? row[column] : row;
    }
    async raw(options?: { columnNames?: boolean }) {
      const rows = (await this.all()).results;
      const values = rows.map(Object.values);
      return options?.columnNames && rows.length ? [Object.keys(rows[0]), ...values] : values;
    }
  }
  return {
    prepare: (sql: string) => new Prepared(sql),
    batch: (statements: Prepared[]) => {
      if (statements.some((s) => !(s instanceof Prepared))) throw new Error("Foreign statement");
      return core.query(
        tenant,
        statements.map(({ sql, params }) => ({ sql, params })),
        true,
      );
    },
    exec: () => {
      throw new Error("Preview schema changes are forbidden; migrate in Core");
    },
    dump: () => {
      throw new Error("Preview database dump is forbidden");
    },
    withSession: () => {
      throw new Error("Preview D1 sessions are not supported");
    },
  } as unknown as D1Database;
}

/** R2's subset used by the app. Unsupported operations fail instead of falling back. */
export function blobGateway(env: GatewayEnv): R2Bucket {
  if (!isPreview(env)) {
    if (!env.BLOBS) throw new Error("Missing BLOBS binding");
    return env.BLOBS;
  }
  const { core, tenant } = previewTarget(env);
  return {
    async get(key: string) {
      const value = await core.blob(tenant, "get", key);
      if (!value) return null;
      const body = new Response(value.bytes);
      return {
        ...value,
        body: body.body,
        bodyUsed: false,
        arrayBuffer: () => body.arrayBuffer(),
        text: () => body.text(),
        json: () => body.json(),
        blob: () => body.blob(),
        writeHttpMetadata: (headers: Headers) => {
          for (const [name, val] of Object.entries(value.httpMetadata ?? {})) {
            const header =
              name === "cacheExpiry"
                ? "expires"
                : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
            headers.set(header, val instanceof Date ? val.toUTCString() : val);
          }
        },
      };
    },
    async put(key: string, value: BodyInit | null, options?: unknown) {
      return core.blob(tenant, "put", key, await new Response(value).arrayBuffer(), options);
    },
    async delete(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys)
        await core.blob(tenant, "delete", key);
    },
  } as unknown as R2Bucket;
}
