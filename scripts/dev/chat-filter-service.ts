#!/usr/bin/env bun
// Optional loopback adapter; cloud prepare is the CLI default.
import { createFilterHandler, createWorkersClassifier, filterConfig } from "./chat-filter-lib";
import { PARTNER_AI_MODEL } from "../../lib/partner-ai-config";

if (import.meta.main) {
  const config = filterConfig();
  const handler = createFilterHandler({
    token: process.env.LIANKI_CHAT_FILTER_TOKEN ?? "",
    config,
    classify: createWorkersClassifier(config),
  });
  Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    maxRequestBodySize: config.maxBodyBytes,
    fetch: handler,
  });
  console.error(
    JSON.stringify({
      type: "ready",
      host: "127.0.0.1",
      port: config.port,
      model: PARTNER_AI_MODEL,
    }),
  );
}
