// Blog posts, bundled at build time from the repo's English markdown
// (blog/en/*.md). Frontmatter (title/date/summary/tags) is parsed here; the body
// is rendered with `marked` in BlogPostPage. Other locales are a follow-up.
const raw = import.meta.glob("../../../../blog/en/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type Post = {
  slug: string;
  title: string;
  date: string;
  summary: string;
  tags: string[];
  body: string;
};

function parse(path: string, text: string): Post {
  const slug = path.split("/").pop()!.replace(/\.md$/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const front = m ? m[1] : "";
  const body = m ? m[2] : text;
  const get = (key: string) => {
    const line = front.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const tagsRaw = get("tags");
  const tags = tagsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    slug,
    title: get("title") || slug,
    date: get("date"),
    summary: get("summary"),
    tags,
    body,
  };
}

export const posts: Post[] = Object.entries(raw)
  .map(([path, text]) => parse(path, text))
  .sort((a, b) => (a.date < b.date ? 1 : -1));

export const postBySlug = (slug: string) => posts.find((p) => p.slug === slug);
