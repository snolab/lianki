import matter from "gray-matter";
import { marked } from "marked";
import fs from "fs/promises";
import path from "path";

// Map intlayer locale codes to blog directory names.
// "zh" uses the legacy "cn" directory; all others match their locale code.
export function blogLocaleDir(locale: string): string {
  return locale === "zh" ? "cn" : locale;
}

export type PostMeta = {
  slug: string;
  title: string;
  date: string;
  summary: string;
  tags: string[];
};

export type Post = PostMeta & { contentHtml: string };

export async function getRawPost(locale: string, slug: string): Promise<string | null> {
  const dir = blogLocaleDir(locale);
  const blogDir = path.join(process.cwd(), "blog", dir);
  const filePath = path.join(blogDir, `${slug}.md`);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content;
  } catch {
    // Fallback to English if locale version doesn't exist
    if (locale !== "en") {
      const fallbackPath = path.join(process.cwd(), "blog", "en", `${slug}.md`);
      try {
        const content = await fs.readFile(fallbackPath, "utf-8");
        return content;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parsePost(raw: string, slug: string): Post {
  const { data, content } = matter(raw);
  return {
    slug,
    title: data.title ?? slug,
    date: data.date ?? "",
    summary: data.summary ?? "",
    tags: data.tags ?? [],
    contentHtml: marked(content) as string,
  };
}

export async function getPost(locale: string, slug: string): Promise<Post | null> {
  const raw = await getRawPost(locale, slug);
  return raw ? parsePost(raw, slug) : null;
}

export async function getAllSlugs(): Promise<string[]> {
  const blogDir = path.join(process.cwd(), "blog", "en");

  try {
    const files = await fs.readdir(blogDir);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
