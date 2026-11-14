import type { PendingFile } from "./files";
import { cleanContext, MAX_CHAT, type AttachmentRef, type ChatContext } from "./wire";

/** One aggregate view, independent of completion order or mutable upload snapshots. */
export function pendingBubble(files: readonly PendingFile[]) {
  const total = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  const sent = files.reduce(
    (sum, file) =>
      sum + Math.max(0, Math.min(file.size, file.state === "done" ? file.size : file.sent)),
    0,
  );
  const refs = files.flatMap((file) =>
    file.state === "done" && file.ref ? [{ ...file.ref }] : [],
  );
  const state = !files.length
    ? "empty"
    : files.some((file) => file.state === "failed" || file.state === "too-big")
      ? "failed"
      : files.every((file) => file.state === "done" && file.ref)
        ? "ready"
        : "uploading";
  return { state, sent, total, progress: total ? sent / total : state === "ready" ? 1 : 0, refs };
}

/** Selection changes alone never request a send. Only a tap or actual other input does. */
export function planPendingSend(d: {
  text: string;
  files: readonly PendingFile[];
  candidate?: ChatContext | null;
  attached?: ChatContext | null;
  candidateTapped?: boolean;
}): { text: string; attachments: AttachmentRef[]; context?: ChatContext } | null {
  const bubble = pendingBubble(d.files);
  if (bubble.state === "uploading" || bubble.state === "failed") return null;
  const context = cleanContext(d.attached) ?? cleanContext(d.candidate);
  const text =
    d.text.trim() ||
    bubble.refs
      .map((ref) => ref.name)
      .join(", ")
      .slice(0, MAX_CHAT) ||
    (d.candidateTapped ? context?.selection : "");
  if (!text) return null;
  return { text, attachments: bubble.refs, ...(context ? { context: { ...context } } : {}) };
}
