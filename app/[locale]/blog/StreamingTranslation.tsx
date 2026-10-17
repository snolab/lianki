"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Streamdown } from "streamdown";

interface StreamingTranslationProps {
  locale: string;
  slug: string;
  /** Shown with the error when the translation can't be generated. */
  fallback?: ReactNode;
}

export function StreamingTranslation({ locale, slug, fallback }: StreamingTranslationProps) {
  const [content, setContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStream = async () => {
      try {
        const response = await fetch(`/api/translate?slug=${slug}&locale=${locale}`);

        if (!response.ok) {
          const errorText = await response.text();
          if (response.status === 401) {
            setError("Sign in required to generate translation");
          } else if (response.status === 429) {
            setError("Rate limit reached. Please retry in a few minutes.");
          } else {
            setError(`Translation failed: ${errorText}`);
          }
          setIsStreaming(false);
          return;
        }

        if (!response.body) {
          setError("No response body");
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
        setError(err instanceof Error ? err.message : "Unknown error");
        setIsStreaming(false);
      }
    };

    fetchStream();
  }, [locale, slug]);

  if (error) {
    const errorBox = (
      <div className="text-red-600 bg-red-50 px-4 py-3 rounded">
        <strong>Translation Error:</strong> {error}
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
