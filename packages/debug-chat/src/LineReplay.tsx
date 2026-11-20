"use client";
/**
 * The "Play original audio" row in a spoken line's details (line-replay.ts;
 * docs/recordings.md, "Replay from the chat"): looks the line's recording up
 * once when the details open and, when there is one, shows Li's ▶ chip
 * (PlayChip.tsx) for it — the same player, the same mic and Li-voice rules.
 * Nothing while it looks, and nothing when no clip exists or recordings are off.
 */
import { useEffect, useState } from "react";
import { PlayChip } from "./PlayChip";
import { type LiPlayer, liPlayer } from "./li-player";
import { clipLineAudio, findLineClips, replayTitle, replayable } from "./line-replay";
import type { ChatMessage } from "./wire";

export function LineReplay({
  message,
  words,
  fetchImpl,
  player,
}: {
  message: ChatMessage;
  /** ChatExtra.lineReplay. */
  words: string;
  /** For the tests; the page's fetch otherwise. */
  fetchImpl?: typeof fetch;
  /** For the tests; the page's one player (li-player.ts) otherwise. */
  player?: LiPlayer | null;
}) {
  const [clips, setClips] = useState<string[]>([]);
  const ok = replayable(message);
  useEffect(() => {
    if (!ok) return;
    let live = true;
    const f = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    if (!f) return;
    void findLineClips(message, f).then((ids) => {
      if (live) setClips(ids ?? []);
    });
    return () => {
      live = false;
    };
    // One lookup per opened line.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, ok]);
  if (!clips.length) return null;
  const p = player !== undefined ? player : liPlayer();
  const origin = globalThis.location?.origin;
  return (
    <div data-testid="debug-chat-line-replay" className="mt-2 flex flex-col gap-1">
      {clips.map((id, i) => (
        <PlayChip
          key={id}
          id={`replay:${message.id}:${id}`}
          audio={clipLineAudio(id, replayTitle(words, i, clips.length), origin)}
          player={p}
        />
      ))}
    </div>
  );
}
