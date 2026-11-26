/**
 * Pure rules for the chat in the lianki.com frame (app/embed/partner), shared
 * with 随身Li's bundled window: no standing "chat only" notice, the advanced
 * hint only after an advanced action was tried, drafts per account and site.
 */

/**
 * The composer's draft scope in the frame: one per account and site. Before
 * the hub names the viewer, a holding scope that no account shares.
 */
export function frameDraftScope(viewerId: string | undefined, origin: string | undefined): string {
  const who = viewerId && /^[\w.~-]{1,128}$/.test(viewerId) ? viewerId : "pending";
  return `portable~${who}~${origin || "unknown"}`;
}

/** An address (`@/…`), page context or files: an advanced action in chat-only mode. */
export function isAdvancedSend(
  to?: string,
  opts?: { context?: unknown; attachments?: unknown },
): boolean {
  return (
    !!to ||
    opts?.context != null ||
    (Array.isArray(opts?.attachments) && opts.attachments.length > 0)
  );
}

/** The one line above the input: a failure, the hub's warning, a share note, else the advanced hint. */
export function frameWarning(
  state: { sendFailed?: boolean; warning?: string },
  copy: { sendFailed: string; advanced?: string; note?: string },
): string | undefined {
  return (
    (state.sendFailed ? `⚠ ${copy.sendFailed}` : undefined) ??
    state.warning ??
    copy.note ??
    copy.advanced
  );
}
