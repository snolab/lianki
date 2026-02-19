import matter from "gray-matter";
import { marked } from "marked";

const REPO = "snomiao/lianki";
const GITHUB_API = "https://api.github.com";

function getBranch() {
  return process.env.VERCEL_GIT_COMMIT_REF ?? "main";
}

function ghHeaders() {
  const token = process.env.GITHUB_INTL_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
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
  const url = `${GITHUB_API}/repos/${REPO}/contents/blog/${locale}/${slug}.md?ref=${getBranch()}`;
  const res = await fetch(url, { headers: ghHeaders(), next: { revalidate: 3600 } });
  if (!res.ok) return null;
  const { content } = (await res.json()) as { content: string };
  return Buffer.from(content, "base64").toString("utf-8");
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
  const url = `${GITHUB_API}/repos/${REPO}/contents/blog/en?ref=${getBranch()}`;
  const res = await fetch(url, { headers: ghHeaders(), next: { revalidate: 3600 } });
  if (!res.ok) return [];
  const files = (await res.json()) as { name: string; type: string }[];
  return files
    .filter((f) => f.type === "file" && f.name.endsWith(".md"))
    .map((f) => f.name.replace(/\.md$/, ""))
    .sort()
    .reverse();
}
