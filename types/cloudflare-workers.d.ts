/**
 * The one piece of the Workers runtime module the main Worker's entry uses
 * (worker.ts). The repo type-checks with the DOM lib, not
 * @cloudflare/workers-types, so it is declared here.
 */
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected env: Env;
    protected ctx: unknown;
    constructor(ctx: unknown, env: Env);
  }
}
