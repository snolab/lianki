"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Streamdown } from "streamdown";

/** The translated lines for a failed translation, from the server page (blog-page `post.*`). */
export interface TranslationMessages {
  errSignIn: string;
  errRate: string;
  errFailed: string;
}

interface StreamingTranslationProps {
  locale: string;
  slug: string;
  messages: TranslationMessages;
  /** Shown with the error when the translation can't be generated. */
  fallback?: ReactNode;
}

export function StreamingTranslation({
  locale,
  slug,
  messages,
  fallback,
}: StreamingTranslationProps) {
  const [content, setContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);
  // Which translated line explains a failure; the response body and exception stay in the console.
  const [error, setError] = useState<keyof TranslationMessages | null>(null);

  useEffect(() => {
    const fetchStream = async () => {
      try {
        const response = await fetch(`/api/translate?slug=${slug}&locale=${locale}`);

        if (!response.ok) {
          console.warn(
            "[blog] translation failed",
            response.status,
            (await response.text().catch(() => "")).slice(0, 300),
          );
          setError(
            response.status === 401
              ? "errSignIn"
              : response.status === 429
                ? "errRate"
                : "errFailed",
          );
          setIsStreaming(false);
          return;
        }

        if (!response.body) {
          console.warn("[blog] translation: no response body");
          setError("errFailed");
          setIsStreaming(false);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            setIsStreaming(false);
            // Auto-commit happens server-side in /api/translate after streaming completes
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          fullText += chunk;
          setContent(fullText);
        }
      } catch (err) {
        console.error("Streaming error:", err);
        setError("errFailed");
        setIsStreaming(false);
      }
    };

    fetchStream();
  }, [locale, slug]);

  if (error) {
    const errorBox = (
      <div role="alert" className="text-red-600 bg-red-50 px-4 py-3 rounded">
        <span aria-hidden="true">⚠ </span>
        {messages[error]}
      </div>
    );
    if (!fallback) return errorBox;
    return (
      <>
        {errorBox}
        <div className="mt-6">{fallback}</div>
      </>
    );
  }

  // Strip markdown code fence if present (API returns ```markdown\n...\n```)
  // Also strip frontmatter (YAML between --- markers)
  const cleanedContent = content
    .replace(/^```markdown\s*\n?/, "") // Remove opening fence
    .replace(/\n?```\s*$/, "") // Remove closing fence
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, ""); // Remove frontmatter

  return (
    <div className="streaming-translation">
      <Streamdown animated caret="block">
        {cleanedContent}
      </Streamdown>
      {isStreaming && (
        <span className="inline-block w-2 h-5 bg-blue-600 animate-pulse ml-1">▊</span>
      )}
    </div>
  );
}
