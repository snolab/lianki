"use client";

import { Streamdown } from "streamdown";
import matter from "gray-matter";
import { getDateLocale } from "@/lib/constants";

interface MarkdownPostProps {
  content: string;
  locale: string;
}

/** Renders a post (English or a committed translation) from its raw markdown. */
export function MarkdownPost({ content, locale }: MarkdownPostProps) {
  // Strip markdown code fence if present (LLM sometimes wraps in ```markdown...```)
  const cleanedContent = content
    .replace(/^```markdown\s*\n?/, "") // Remove opening fence
    .replace(/\n?```\s*$/, ""); // Remove closing fence

  // Parse frontmatter
  const { data, content: body } = matter(cleanedContent);
  // Posts open with `# Title`, which repeats the header's <h1> right above it.
  const markdown = body.replace(/^\s*# [^\n]*\n/, "");

  return (
    <article>
      <header className="mb-8">
        <time className="text-sm text-gray-400">
          {data.date
            ? new Date(data.date).toLocaleDateString(getDateLocale(locale), {
                year: "numeric",
                month: "long",
                day: "numeric",
              })
            : ""}
        </time>
        <h1 className="text-3xl font-bold mt-2">{data.title}</h1>
        {data.tags && data.tags.length > 0 && (
          <div className="flex gap-2 mt-3 flex-wrap">
            {data.tags.map((tag: string) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 bg-gray-100 rounded-full text-gray-600"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="markdown-post">
        <Streamdown>{markdown}</Streamdown>
      </div>
    </article>
  );
}
