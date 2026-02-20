"use client";

import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";

interface StreamingTranslationProps {
  locale: string;
  slug: string;
}

export function StreamingTranslation({ locale, slug }: StreamingTranslationProps) {
  const [content, setContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStream = async () => {
      try {
        const response = await fetch(`/api/translate?slug=${slug}&locale=${locale}`);

        if (!response.ok) {
          const errorText = await response.text();
          setError(`Translation failed: ${errorText}`);
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

            // Commit the translated markdown back to the repo (non-blocking, server-side)
            console.log(`[auto-commit] Starting commit for ${locale}/${slug}`);
            fetch("/api/commit-translation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ slug, locale, content: fullText }),
            })
              .then((res) => res.json())
              .then((data) => {
                if (data.success) {
                  console.log(`[auto-commit] ✓ Success: ${data.filePath}`);
                } else {
                  console.error(`[auto-commit] ✗ Failed:`, data.error);
                }
              })
              .catch((err) => {
                console.error(`[auto-commit] ✗ Network error:`, err);
              });

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
    return (
      <div className="text-red-600 bg-red-50 px-4 py-3 rounded">
        <strong>Translation Error:</strong> {error}
      </div>
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
      <Streamdown>{cleanedContent}</Streamdown>
      {isStreaming && (
        <span className="inline-block w-2 h-5 bg-blue-600 animate-pulse ml-1">▊</span>
      )}
    </div>
  );
}
