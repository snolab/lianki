import { WorkerEntrypoint } from "cloudflare:workers";
import { previewAuthority } from "../../../lib/preview/authority";
import type { BoxEnv } from "../../../lib/box-oauth/gate";
// Exercises the real adapters and RPC entrypoint without building the full UI.
import { dataGateway, blobGateway, type GatewayEnv } from "../../../lib/preview/gateway";
import { previewHandler } from "../../../lib/preview/proxy";
export { PreviewCore } from "../../../lib/preview/entrypoint";
export default {
  async fetch(req: Request, env: GatewayEnv) {
    return previewHandler(req, env, async () => {
      const db = dataGateway(env);
      await db
        .prepare(
          "INSERT INTO cards (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .bind("branch", "local-business")
        .run();
      const blobs = blobGateway(env);
      await blobs.put("preview-asset", new Uint8Array([0, 1, 255]));
      return Response.json({
        local: true,
        card: await db.prepare("SELECT * FROM cards WHERE id = ?").bind("branch").first(),
        bytes: [...new Uint8Array(await (await blobs.get("preview-asset"))!.arrayBuffer())],
      });
    });
  },
};
export class PreviewAuth extends WorkerEntrypoint<BoxEnv> {
  authorize(req: Request) {
    return previewAuthority(
      req,
      this.env,
      { flagOn: async () => true, allow: async () => true },
      async () => new Response(null, { status: 204 }),
    );
  }
}
