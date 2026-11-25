"use client";
import { useEffect } from "react";
import { portableSource } from "@/lib/portable-chat-url";
import { sendAction } from "@/lib/islands/actions";

export default function ChatLaunch({
  title,
  openText,
  source,
  returnText,
}: {
  title: string;
  openText: string;
  source: string | null;
  returnText: string;
}) {
  const open = () => sendAction("chat.open", {});
  // Already-mounted widget: this route's action opens it. A late-mounted widget
  // checks /chat itself, so hydration timing cannot swallow the first open.
  useEffect(() => {
    sendAction("chat.open", {});
  }, []);
  const returnUrl = portableSource(source);
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-bold">{title}</h1>
      <button
        type="button"
        className="tap-40 self-start rounded-full border px-4 py-2"
        data-testid="portable-chat-open"
        onClick={open}
      >
        {openText}
      </button>
      {returnUrl && (
        <a
          href={returnUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start underline"
          data-testid="portable-chat-return"
        >
          {returnText.replace("{host}", returnUrl)}
        </a>
      )}
    </main>
  );
}
