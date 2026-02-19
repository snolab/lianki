import matter from "gray-matter";
import { remark } from "remark";
import remarkHtml from "remark-html";

const REPO = "snomiao/lianki";
const BRANCH = "main";
const GITHUB_API = "https://api.github.com";

function ghHeaders() {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
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

export type Post = PostMeta & {
  contentHtml: string;
};

export async function getRawPost(locale: string, slug: string): Promise<string | null> {
  const path = `blog/${locale}/${slug}.md`;
  const url = `${GITHUB_API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`;

  const res = await fetch(url, {
    headers: ghHeaders(),
    next: { revalidate: 3600 },
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { content: string; encoding: string };
  return Buffer.from(data.content, "base64").toString("utf-8");
}

export async function parsePost(raw: string, slug: string): Promise<Post> {
  const { data, content } = matter(raw);
  const processed = await remark().use(remarkHtml).process(content);
  return {
    slug,
    title: data.title ?? slug,
    date: data.date ?? "",
    summary: data.summary ?? "",
    tags: data.tags ?? [],
    contentHtml: processed.toString(),
  };
}

export async function getPost(locale: string, slug: string): Promise<Post | null> {
  const raw = await getRawPost(locale, slug);
  if (!raw) return null;
  return parsePost(raw, slug);
}

export async function getAllSlugs(): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${REPO}/contents/blog/en?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: ghHeaders(),
    next: { revalidate: 3600 },
  });

  if (!res.ok) return [];

  const files = (await res.json()) as { name: string; type: string }[];
  return files
    .filter((f) => f.type === "file" && f.name.endsWith(".md"))
    .map((f) => f.name.replace(/\.md$/, ""))
    .sort()
    .reverse();
}
