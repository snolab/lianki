"use client";

import { StateTreeFromSource } from "@lianki/debug-chat/StateTree";
import { useMemo } from "react";
import { liveTreeSource, progressSocketUrl } from "@/lib/progress-tree";

/**
 * The state tree with live progress laid over it (lib/progress-tree.ts):
 * `markdown` is the hand-edited base; the owner-only progress socket updates
 * it as agents report. Without the hub it is the outline as it is.
 */
export function LiveStateTree({ markdown, repo }: { markdown: string; repo: string }) {
  const source = useMemo(
    () =>
      typeof window === "undefined"
        ? () => markdown
        : liveTreeSource({ base: () => markdown, url: progressSocketUrl(location), repo }),
    [markdown, repo],
  );
  return <StateTreeFromSource source={source} repo={repo} />;
}
